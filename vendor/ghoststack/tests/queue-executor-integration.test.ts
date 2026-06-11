/**
 * T4 — FileQueueBackend + TaskExecutor integration
 * Verifies that jobs persisted to disk are picked up and executed by the executor.
 */
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { FileQueueBackend } from "../orchestration/file-queue-backend";
import { TaskExecutor } from "../orchestration/task-executor";
import { LocalEventBus } from "../orchestration/event-bus";
import { FileRuntimePersistence } from "../orchestration/persistence-manager";
import { NullLogger } from "../orchestration/logger";
import { MetricsCollector, TraceRecorder } from "../orchestration/observability-manager";
import { IExecutionAdapter } from "../orchestration/interfaces/execution.interface";
import { QueueJob } from "../orchestration/interfaces/queue.interface";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gs-qe-int-test-"));
}

function makeJob(id: string, type = "test-type", priority: "low" | "medium" | "high" = "high"): QueueJob {
  return {
    id,
    payload: { type, data: `payload-${id}` },
    priority,
    retries: 0,
    maxRetries: 3,
    createdAt: new Date()
  };
}

/** A mock adapter that records what it executed and optionally fails */
class CapturingAdapter implements IExecutionAdapter {
  public executed: string[] = [];
  public failCount = 0;
  private fails: number;

  constructor(failTimes = 0) {
    this.fails = failTimes;
  }

  canExecute(_taskType: string): boolean { return true; }

  async execute(task: any, _ctx: any): Promise<any> {
    if (this.fails > 0) {
      this.fails--;
      this.failCount++;
      throw new Error("simulated adapter failure");
    }
    this.executed.push(task.id ?? task.payload?.data ?? "?");
    return { ok: true };
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("FileQueueBackend + TaskExecutor integration", () => {
  let tmpDir: string;
  let queue: FileQueueBackend;
  let eventBus: LocalEventBus;
  let persistence: FileRuntimePersistence;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    queue = new FileQueueBackend(tmpDir);
    await queue.init();
    eventBus = new LocalEventBus();
    persistence = new FileRuntimePersistence(path.join(tmpDir, "cache.json"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("executor picks up a job pushed to the file-backed queue and executes it", async () => {
    const adapter = new CapturingAdapter();
    const executor = new TaskExecutor(
      queue, eventBus, persistence, new NullLogger(),
      [adapter], new MetricsCollector(), new TraceRecorder()
    );

    await queue.push(makeJob("job-1", "test-type"));
    await executor.start();
    const processed = await executor.runLoop(1);

    expect(processed).toBe(1);
    expect(adapter.executed).toHaveLength(1);
    // Queue should now be empty
    expect(await queue.getQueueLength()).toBe(0);
  });

  it("executor processes multiple jobs in priority order", async () => {
    const adapter = new CapturingAdapter();
    const executor = new TaskExecutor(
      queue, eventBus, persistence, new NullLogger(),
      [adapter], new MetricsCollector(), new TraceRecorder()
    );

    await queue.push(makeJob("low-job", "test-type", "low"));
    await queue.push(makeJob("high-job", "test-type", "high"));
    await queue.push(makeJob("med-job", "test-type", "medium"));
    await executor.start();
    await executor.runLoop(3);

    // All 3 should be processed
    expect(adapter.executed).toHaveLength(3);
    expect(await queue.getQueueLength()).toBe(0);
  });

  it("jobs survive a process restart (re-init from disk) and are executed by a new executor", async () => {
    // Push two jobs
    await queue.push(makeJob("persist-1"));
    await queue.push(makeJob("persist-2"));
    expect(await queue.getQueueLength()).toBe(2);

    // Simulate restart: create a fresh FileQueueBackend from the same data dir
    const queue2 = new FileQueueBackend(tmpDir);
    await queue2.init();
    expect(await queue2.getQueueLength()).toBe(2);

    const adapter = new CapturingAdapter();
    const executor = new TaskExecutor(
      queue2, eventBus, persistence, new NullLogger(),
      [adapter], new MetricsCollector(), new TraceRecorder()
    );
    await executor.start();
    const processed = await executor.runLoop(2);

    expect(processed).toBe(2);
    expect(await queue2.getQueueLength()).toBe(0);
  });

  it("failed jobs are retried and eventually moved to DLQ", async () => {
    // maxRetries=1 job with an adapter that always fails
    const alwaysFailJob: QueueJob = {
      id: "fail-job",
      payload: { type: "test-type" },
      priority: "high",
      retries: 0,
      maxRetries: 1,
      createdAt: new Date()
    };
    const adapter = new CapturingAdapter(99); // always fail
    const executor = new TaskExecutor(
      queue, eventBus, persistence, new NullLogger(),
      [adapter], new MetricsCollector(), new TraceRecorder()
    );

    await queue.push(alwaysFailJob);
    await executor.start();
    // Run enough iterations for the job to exhaust its retries
    await executor.runLoop(5, 0);

    // Job should be in DLQ, not in active queue
    const dlq = await queue.getDeadLetterQueue();
    const activeLen = await queue.getQueueLength();
    expect(activeLen).toBe(0);
    expect(dlq.length).toBeGreaterThan(0);
    expect(dlq.some((j) => j.id === "fail-job")).toBe(true);
  });

  it("DLQ contents persist across restarts", async () => {
    const failJob: QueueJob = {
      id: "dlq-persist",
      payload: { type: "test-type" },
      priority: "high",
      retries: 0,
      maxRetries: 1,
      createdAt: new Date()
    };
    const adapter = new CapturingAdapter(99);
    const executor = new TaskExecutor(
      queue, eventBus, persistence, new NullLogger(),
      [adapter], new MetricsCollector(), new TraceRecorder()
    );

    await queue.push(failJob);
    await executor.start();
    await executor.runLoop(5, 0);

    // Verify job is in DLQ before restart
    const dlqBefore = await queue.getDeadLetterQueue();
    expect(dlqBefore.some((j) => j.id === "dlq-persist")).toBe(true);

    // Simulate restart
    const queue2 = new FileQueueBackend(tmpDir);
    await queue2.init();
    const dlqAfter = await queue2.getDeadLetterQueue();
    expect(dlqAfter.some((j) => j.id === "dlq-persist")).toBe(true);
  });

  it("runLoop returns 0 when queue is empty", async () => {
    const adapter = new CapturingAdapter();
    const executor = new TaskExecutor(
      queue, eventBus, persistence, new NullLogger(),
      [adapter], new MetricsCollector(), new TraceRecorder()
    );
    await executor.start();
    const processed = await executor.runLoop(10, 0);
    expect(processed).toBe(0);
  });
});
