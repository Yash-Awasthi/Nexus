import { TaskExecutor } from "../orchestration/task-executor";
import { MemoryQueueBackend } from "../orchestration/queue-backend";
import { LocalEventBus } from "../orchestration/event-bus";
import { FileRuntimePersistence } from "../orchestration/persistence-manager";
import { StructuredLogger } from "../orchestration/logger";
import { FlociExecutionAdapter } from "../orchestration/floci-adapter";
import { QueueJob } from "../orchestration/interfaces/queue.interface";
import * as path from "path";
import * as fs from "fs";

describe("Milestone 3: Core Task Executor Loop", () => {
  const testDir = path.join(__dirname, "../temp-executor-db");
  const dbPath = path.join(testDir, "executor_state.json");

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

  it("should retrieve, execute, emit events, and persist state for independent floci tasks", async () => {
    const queue = new MemoryQueueBackend();
    const bus = new LocalEventBus();
    const persistence = new FileRuntimePersistence(dbPath);
    const logger = new StructuredLogger();
    const flociAdapter = new FlociExecutionAdapter();

    const executor = new TaskExecutor(queue, bus, persistence, logger, [flociAdapter]);

    const job: QueueJob = {
      id: "task-durable-01",
      payload: {
        type: "floci",
        payload: {
          action: "create_s3_bucket",
          bucketName: "ghoststack-durable-s3"
        }
      },
      priority: "high",
      retries: 0,
      maxRetries: 3,
      createdAt: new Date()
    };

    await queue.push(job);

    let startedEmitted = false;
    let succeededEmitted = false;

    bus.subscribe("execution_started", () => {
      startedEmitted = true;
    });
    bus.subscribe("execution_succeeded", () => {
      succeededEmitted = true;
    });

    const result = await executor.executeNext();
    expect(result).toBe(true);

    expect(startedEmitted).toBe(true);
    expect(succeededEmitted).toBe(true);

    // Verify state was persisted successfully!
    const state = await persistence.getState<any>("task-durable-01");
    expect(state).toBeDefined();
    expect(state.status).toBe("success");
    expect(state.result.service).toBe("s3");
    expect(state.result.bucketName).toBe("ghoststack-durable-s3");
  });
});
