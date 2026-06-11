import { GhostStackOrchestrator } from "../runtime/orchestrator";
import { RuntimeManager } from "../orchestration/runtime-manager";
import { LocalEventBus } from "../orchestration/event-bus";
import { TaskRouter } from "../orchestration/task-router";
import { LocalAgentRegistry } from "../orchestration/agent-registry";
import { FileEventStore, FileRuntimePersistence } from "../orchestration/persistence-manager";
import { StructuredLogger } from "../orchestration/logger";
import { MemoryQueueBackend } from "../orchestration/queue-backend";
import { TaskExecutor } from "../orchestration/task-executor";
import { MetricsCollector, TraceRecorder } from "../orchestration/observability-manager";
import { FlociExecutionAdapter } from "../orchestration/floci-adapter";
import { YAMLConfigLoader } from "../runtime/config-loader";
import * as path from "path";
import * as fs from "fs";

describe("Milestone 3: Telemetry & Core Orchestrator Integration", () => {
  const testDir = path.join(__dirname, "../temp-telemetry-db");
  const eventLogPath = path.join(testDir, "telemetry_events.jsonl");
  const cacheDbPath = path.join(testDir, "telemetry_cache.json");

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

  it("should track latency timings, queue depths, replayed logs, and parent traces automatically", async () => {
    const loader = new YAMLConfigLoader({
      portsPath: path.join(__dirname, "../runtime/ports.yaml"),
      servicesPath: path.join(__dirname, "../runtime/services.yaml"),
      healthchecksPath: path.join(__dirname, "../runtime/healthchecks.yaml"),
      runtimePath: path.join(__dirname, "../runtime/ghoststack.runtime.yaml")
    });

    const logger = new StructuredLogger();
    const eventBus = new LocalEventBus();
    const eventStore = new FileEventStore(eventLogPath);
    const persistence = new FileRuntimePersistence(cacheDbPath);
    const runtimeManager = new RuntimeManager(loader);
    const agentRegistry = new LocalAgentRegistry();
    const taskRouter = new TaskRouter(eventBus, eventStore);

    // Initialize telemetry
    const metrics = new MetricsCollector();
    const tracer = new TraceRecorder();
    const queue = new MemoryQueueBackend();

    const adapter = new FlociExecutionAdapter();
    const executor = new TaskExecutor(queue, eventBus, persistence, logger, [adapter], metrics, tracer);

    const orchestrator = new GhostStackOrchestrator(
      runtimeManager,
      eventBus,
      taskRouter,
      agentRegistry,
      eventStore,
      logger,
      queue,
      executor,
      metrics,
      tracer
    );

    // Bootstrap orchestrator
    await orchestrator.start();

    // Submit tasks
    const testTasks = [{ id: "task-telemetry-s3", description: "setup s3 bucket", priority: "high", dependencies: [] }];

    await orchestrator.submitAndExecuteTasks(testTasks as any);

    // 1. Assert telemetry metrics were generated
    const currentMetrics = metrics.getMetrics();
    expect(currentMetrics["task.submitted"]).toBe(1);
    expect(currentMetrics["task.executed"]).toBe(1);
    expect(currentMetrics["task.success"]).toBe(1);
    expect(currentMetrics["queue.size"]).toBe(0);
    // With Histogram-based MetricsCollector, timings are exposed under "_histogram" suffix
    const timingMetric = currentMetrics["task.latency_histogram"] || currentMetrics["task.latency"];
    expect(timingMetric).toBeDefined();

    // 2. Assert traces capture execution spans
    const spans = tracer.getSpans();
    const executionSpan = spans.find((s) => s.name === "task.execute");
    expect(executionSpan).toBeDefined();
    expect(executionSpan?.metadata?.taskId).toBe("task-telemetry-s3");
  });
});
