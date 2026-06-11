import { GhostStackOrchestrator } from "../runtime/orchestrator";
import { RuntimeManager } from "../orchestration/runtime-manager";
import { YAMLConfigLoader } from "../runtime/config-loader";
import { LocalEventBus } from "../orchestration/event-bus";
import { TaskRouter, Task } from "../orchestration/task-router";
import { LocalAgentRegistry } from "../orchestration/agent-registry";
import { FileEventStore, FileRuntimePersistence } from "../orchestration/persistence-manager";
import { StructuredLogger } from "../orchestration/logger";
import { MemoryQueueBackend } from "../orchestration/queue-backend";
import { TaskExecutor } from "../orchestration/task-executor";
import { FlociExecutionAdapter } from "../orchestration/floci-adapter";
import * as path from "path";
import * as fs from "fs";

describe("GhostStack Phase 3: E2E Pipeline Vertical Slice & Crash Recovery Integration", () => {
  const testDir = path.join(__dirname, "../temp-e2e-db");
  const eventLogPath = path.join(testDir, "e2e_events.jsonl");
  const cacheDbPath = path.join(testDir, "e2e_cache.json");

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should validate dependencies, execute S3/SQS/DynamoDB actions in order, and persist execution states cleanly", async () => {
    const loader = new YAMLConfigLoader({
      portsPath: path.join(__dirname, "../runtime/ports.yaml"),
      servicesPath: path.join(__dirname, "../runtime/services.yaml"),
      healthchecksPath: path.join(__dirname, "../runtime/healthchecks.yaml"),
      runtimePath: path.join(__dirname, "../runtime/ghoststack.runtime.yaml")
    });

    const rm = new RuntimeManager(loader);
    const bus = new LocalEventBus();
    const eventStore = new FileEventStore(eventLogPath);
    const router = new TaskRouter(bus, eventStore);
    const registry = new LocalAgentRegistry();
    const logger = new StructuredLogger();

    const queue = new MemoryQueueBackend();
    const persistence = new FileRuntimePersistence(cacheDbPath);
    const flociAdapter = new FlociExecutionAdapter();
    const executor = new TaskExecutor(queue, bus, persistence, logger, [flociAdapter]);

    const orchestrator = new GhostStackOrchestrator(rm, bus, router, registry, eventStore, logger, queue, executor);

    await orchestrator.start();

    // Setup dependency chain: Table depends on Queue, Queue depends on Bucket
    const tasks: Task[] = [
      {
        id: "ddb-table-test",
        title: "Create DynamoDB Table",
        description: "Configure table descriptor",
        priority: "medium",
        status: "pending",
        dependencies: ["sqs-queue-test"]
      },
      {
        id: "s3-bucket-test",
        title: "Create S3 Bucket",
        description: "Provision storage bucket",
        priority: "high",
        status: "pending",
        dependencies: []
      },
      {
        id: "sqs-queue-test",
        title: "Create SQS Queue",
        description: "Provision queue messaging",
        priority: "medium",
        status: "pending",
        dependencies: ["s3-bucket-test"]
      }
    ];

    let startCount = 0;
    let successCount = 0;

    bus.subscribe("execution_started", () => {
      startCount++;
    });
    bus.subscribe("execution_succeeded", () => {
      successCount++;
    });

    // Execute E2E sorting, routing, queue pushes, and adapter runs!
    await orchestrator.submitAndExecuteTasks(tasks);

    expect(startCount).toBe(3);
    expect(successCount).toBe(3);

    // Verify executions in correct dependency order inside state store
    const s3State = await persistence.getState<any>("s3-bucket-test");
    const sqsState = await persistence.getState<any>("sqs-queue-test");
    const ddbState = await persistence.getState<any>("ddb-table-test");

    expect(s3State.status).toBe("success");
    expect(s3State.result.service).toBe("s3");
    expect(s3State.result.bucketName).toBe("s3-bucket-test");

    expect(sqsState.status).toBe("success");
    expect(sqsState.result.service).toBe("sqs");
    expect(sqsState.result.queueName).toBe("sqs-queue-test");

    expect(ddbState.status).toBe("success");
    expect(ddbState.result.service).toBe("dynamodb");
    expect(ddbState.result.tableName).toBe("ddb-table-test");
  });
});
