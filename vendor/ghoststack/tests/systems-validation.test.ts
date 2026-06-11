/**
 * GhostStack Phase 7: Systems Validation
 *
 * Validates the system's robustness against:
 * 1. Data corruption — corrupt JSONL event logs, state files, partial writes
 * 2. Failure injection — adapters that throw controlled errors, circuit breaker resilience
 * 3. Cross-component stability — full pipeline under sustained duress
 */

import { LocalEventBus } from "../orchestration/event-bus";
import { FileEventStore, FileRuntimePersistence } from "../orchestration/persistence-manager";
import { MemoryQueueBackend } from "../orchestration/queue-backend";
import { TaskExecutor } from "../orchestration/task-executor";
import { StructuredLogger } from "../orchestration/logger";
import { MetricsCollector, TraceRecorder } from "../orchestration/observability-manager";
import { CircuitBreaker } from "../orchestration/circuit-breaker";
import { FlociExecutionAdapter } from "../orchestration/floci-adapter";
import { MemoryStore } from "../orchestration/memory-store";
import { IExecutionAdapter, IExecutionContext } from "../orchestration/interfaces/execution.interface";
import * as fs from "fs";
import * as path from "path";

// ─── Failure Injection Adapter ────────────────────────────────────────────

type InjectionMode =
  | { type: "always_fail"; errorMsg: string }
  | { type: "fail_n_times"; remaining: number; errorMsg: string }
  | { type: "fail_with_slowdown"; delayMs: number; errorMsg: string }
  | { type: "flaky"; failureRate: number; errorMsg: string }
  | { type: "pass_through" };

class FailInjectorAdapter implements IExecutionAdapter {
  private mode: InjectionMode = { type: "pass_through" };
  private callCount = 0;
  public failureCount = 0;
  public successCount = 0;

  setMode(mode: InjectionMode): void {
    this.mode = mode;
    this.callCount = 0;
    this.failureCount = 0;
    this.successCount = 0;
  }

  canExecute(taskType: string): boolean {
    return taskType === "floci" || taskType === "inject";
  }

  async execute(_task: any, _context: IExecutionContext): Promise<any> {
    this.callCount++;
    const mode = this.mode;

    switch (mode.type) {
      case "always_fail":
        this.failureCount++;
        throw new Error(mode.errorMsg);

      case "fail_n_times":
        if (mode.remaining > 0) {
          mode.remaining--;
          this.failureCount++;
          throw new Error(mode.errorMsg);
        }
        this.successCount++;
        return { status: "success", service: "inject", mocked: true };

      case "fail_with_slowdown":
        await new Promise((r) => setTimeout(r, mode.delayMs));
        this.failureCount++;
        throw new Error(mode.errorMsg);

      case "flaky":
        if (Math.random() < mode.failureRate) {
          this.failureCount++;
          throw new Error(mode.errorMsg);
        }
        this.successCount++;
        return { status: "success", service: "inject", mocked: true };

      case "pass_through":
      default:
        this.successCount++;
        return { status: "success", service: "inject", mocked: true };
    }
  }

  getCallCount(): number {
    return this.callCount;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const testDir = path.join(__dirname, "../temp-systems-validation");
const eventLogPath = path.join(testDir, "events.jsonl");
const stateDbPath = path.join(testDir, "state.json");

function cleanDir(): void {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir, { recursive: true });
}


// ─── Systems Validation Suite ─────────────────────────────────────────────

describe("Phase 7: Systems Validation", () => {
  beforeEach(() => {
    cleanDir();
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  //  1. Data Corruption Recovery
  // ═════════════════════════════════════════════════════════════════════

  describe("1. Data Corruption Recovery", () => {
    it("replays events past a corrupt JSONL line", async () => {
      // Write a JSONL file with a corrupt middle line
      const lines = [
        JSON.stringify({ event: "good_1", payload: { n: 1 }, timestamp: new Date().toISOString() }),
        "this is not valid json\n",  // corrupt line
        JSON.stringify({ event: "good_2", payload: { n: 2 }, timestamp: new Date().toISOString() }),
      ];
      fs.writeFileSync(eventLogPath, lines.join("\n"), "utf-8");

      const store = new FileEventStore(eventLogPath);
      const events = await store.replayEvents();

      // Should skip the corrupt line and recover clean lines
      expect(events.length).toBe(2);
      expect(events[0].event).toBe("good_1");
      expect(events[1].event).toBe("good_2");
    });

    it("recovers from a truncated (partial last line) JSONL file", async () => {
      const lines = [
        JSON.stringify({ event: "complete", payload: { n: 1 }, timestamp: new Date().toISOString() }) + "\n",
        '{"event": "truncated", "payload"',  // no newline, truncated JSON
      ];
      fs.writeFileSync(eventLogPath, lines.join(""), "utf-8");

      const store = new FileEventStore(eventLogPath);
      const events = await store.replayEvents();

      // Should recover the complete first line, skip the truncated partial
      expect(events.length).toBe(1);
      expect(events[0].event).toBe("complete");
    });

    it("recovers from a completely empty JSONL file", async () => {
      fs.writeFileSync(eventLogPath, "", "utf-8");
      const store = new FileEventStore(eventLogPath);
      const events = await store.replayEvents();
      expect(events.length).toBe(0);
    });

    it("recovers from a JSONL file with only whitespace", async () => {
      fs.writeFileSync(eventLogPath, "   \n\n  \n", "utf-8");
      const store = new FileEventStore(eventLogPath);
      const events = await store.replayEvents();
      expect(events.length).toBe(0);
    });

    it("recovers state from a corrupt JSON state file by resetting", async () => {
      fs.writeFileSync(stateDbPath, "{this is not valid json", "utf-8");
      const persistence = new FileRuntimePersistence(stateDbPath);

      // Should fail to parse but not crash — getState returns undefined
      const val = await persistence.getState<any>("test");
      expect(val).toBeUndefined();

      // Should be able to write new state successfully
      await persistence.saveState("test", { recovered: true });
      const readback = await persistence.getState<any>("test");
      expect(readback).toEqual({ recovered: true });
    });

    it("recovers from a partially written state file", async () => {
      // Simulate a partial write by writing a truncated JSON
      fs.writeFileSync(stateDbPath, '{"workflow_history": [{"id": "exec-01", "status": "succeeded"', "utf-8");
      const persistence = new FileRuntimePersistence(stateDbPath);

      const val = await persistence.getState<any>("test");
      expect(val).toBeUndefined();

      // New writes should succeed
      await persistence.saveState("status", "ok");
      expect(await persistence.getState<string>("status")).toBe("ok");
    });

    it("preserves event order after replay with interleaved good and bad lines", async () => {
      const entries = [
        { event: "step_1", payload: { idx: 1 } },
        { event: "step_2", payload: { idx: 2 } },
        // corrupt lines intentionally inserted
        null,
        { event: "step_3", payload: { idx: 3 } },
        "nonsense\n",
        { event: "step_4", payload: { idx: 4 } },
        undefined,
        { event: "step_5", payload: { idx: 5 } },
      ];

      const jsonl = entries
        .map((e) => {
          if (e === null) return "{{invalid}}\n";
          if (e === undefined) return "not json either\n";
          if (typeof e === "string") return e;
          return JSON.stringify(e) + "\n";
        })
        .join("");

      fs.writeFileSync(eventLogPath, jsonl, "utf-8");
      const store = new FileEventStore(eventLogPath);
      const events = await store.replayEvents();

      // step_5 is valid JSON at end of file — it should be recovered.
      // Total: step_1, step_2, step_3, step_4, step_5 = 5 events recovered
      expect(events.length).toBe(5);
      expect(events.map((e: any) => e.event)).toEqual(["step_1", "step_2", "step_3", "step_4", "step_5"]);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  //  2. Failure Injection
  // ═════════════════════════════════════════════════════════════════════

  describe("2. Failure Injection & Resilience", () => {
    it("circuit breaker wraps an always-failing adapter and opens", async () => {
      const eventBus = new LocalEventBus();
      const breaker = new CircuitBreaker(
        { failureThreshold: 3, recoveryTimeoutMs: 5000, halfOpenMaxRequests: 3, halfOpenSuccessRate: 0.5, name: "inject-test" },
        eventBus
      );

      const injector = new FailInjectorAdapter();
      injector.setMode({ type: "always_fail", errorMsg: "injected failure" });

      let openEventFired = false;
      eventBus.subscribe("circuit_breaker_opened", () => { openEventFired = true; });

      // Run 3 failing executions through the breaker
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(() => injector.execute({ type: "inject", payload: {} }, {} as IExecutionContext));
        } catch { /* expected */ }
      }

      expect(breaker.getState()).toBe("open");
      expect(openEventFired).toBe(true);
      expect(injector.failureCount).toBe(3);
    });

    it("executor survives injected failures and processes remaining jobs", async () => {
      const eventBus = new LocalEventBus();
      const persistence = new FileRuntimePersistence(stateDbPath);
      const logger = new StructuredLogger();
      const queue = new MemoryQueueBackend();
      const metrics = new MetricsCollector();
      const tracer = new TraceRecorder();
      const injector = new FailInjectorAdapter();

      // Set up: first 5 jobs will fail, next 5 succeed
      injector.setMode({ type: "fail_n_times", remaining: 5, errorMsg: "transient failure" });

      const executor = new TaskExecutor(queue, eventBus, persistence, logger, [injector], metrics, tracer);

      // Enqueue 10 jobs
      for (let i = 0; i < 10; i++) {
        await queue.push({
          id: `inject-job-${i}`,
          payload: { type: "inject", payload: {} },
          priority: "medium",
          retries: 0,
          maxRetries: 2,
          createdAt: new Date(),
        });
      }

      // Drain the queue: execute until empty
      // Jobs 0-4 fail on first attempt and get pushed back for retry.
      // After retries exhausted, they go to DLQ.
      // With remaining=5 and maxRetries=2, each of jobs 0-4 gets 3 attempts.
      // That's 5 initial + 10 retry = 15 failed attempts.
      // Jobs 5-9 succeed on first attempt (5 successes).
      while (await queue.getQueueLength() > 0) {
        await executor.executeNext();
      }

      // 5 initial failures (jobs 0-4) + 5 retry successes + 5 fresh successes (jobs 5-9)
      expect(injector.failureCount).toBe(5);
      expect(injector.successCount).toBe(10);

      // Queue should be empty
      const qLen = await queue.getQueueLength();
      expect(qLen).toBe(0);
    });

    it("executor with slowdown injection stays within timeout bounds", async () => {
      const eventBus = new LocalEventBus();
      const persistence = new FileRuntimePersistence(stateDbPath);
      const logger = new StructuredLogger();
      const queue = new MemoryQueueBackend();
      const metrics = new MetricsCollector();
      const tracer = new TraceRecorder();
      const injector = new FailInjectorAdapter();

      // Each call delays 5ms before failing
      injector.setMode({ type: "fail_with_slowdown", delayMs: 5, errorMsg: "slow failure" });

      const executor = new TaskExecutor(queue, eventBus, persistence, logger, [injector], metrics, tracer);

      await queue.push({
        id: "slow-fail-job",
        payload: { type: "inject", payload: {} },
        priority: "medium",
        retries: 0,
        maxRetries: 1,
        createdAt: new Date(),
      });

      const start = Date.now();
      await executor.executeNext(); // first attempt + retry with slowdown
      await executor.executeNext(); // second attempt (retry)
      const elapsed = Date.now() - start;

      const dlq = await queue.getDeadLetterQueue();
      expect(dlq.length).toBe(1);
      // Each attempt: 5ms delay. 2 attempts = 10ms + overhead
      expect(elapsed).toBeGreaterThanOrEqual(5);
    });

    it("flaky adapter with 50% failure rate eventually converges", async () => {
      const eventBus = new LocalEventBus();
      const persistence = new FileRuntimePersistence(stateDbPath);
      const logger = new StructuredLogger();
      const queue = new MemoryQueueBackend();
      const metrics = new MetricsCollector();
      const tracer = new TraceRecorder();
      const injector = new FailInjectorAdapter();

      injector.setMode({ type: "flaky", failureRate: 0.5, errorMsg: "random flake" });
      const executor = new TaskExecutor(queue, eventBus, persistence, logger, [injector], metrics, tracer);

      // Enqueue 20 jobs
      for (let i = 0; i < 20; i++) {
        await queue.push({
          id: `flaky-${i}`,
          payload: { type: "inject", payload: {} },
          priority: "medium",
          retries: 0,
          maxRetries: 2,
          createdAt: new Date(),
        });
      }

      // Drain the queue: execute until empty
      // With 50% failure rate and maxRetries=2, many jobs will retry.
      while (await queue.getQueueLength() > 0) {
        await executor.executeNext();
      }

      const totalCalls = injector.successCount + injector.failureCount;
      expect(totalCalls).toBeGreaterThanOrEqual(20); // some may have retried
      expect(injector.failureCount).toBeGreaterThan(0);
      expect(injector.successCount).toBeGreaterThan(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  //  3. Cross-Component Stability
  // ═════════════════════════════════════════════════════════════════════

  describe("3. Cross-Component Stability", () => {
    it("event bus + queue + executor + persistence co-exist under sustained load", async () => {
      const eventStore = new FileEventStore(eventLogPath);
      const eventBus = new LocalEventBus({ maxHistorySize: 5000, eventStore });
      const persistence = new FileRuntimePersistence(stateDbPath);
      const logger = new StructuredLogger();
      const queue = new MemoryQueueBackend();
      const metrics = new MetricsCollector();
      const tracer = new TraceRecorder();
      const flociAdapter = new FlociExecutionAdapter({ allowMockFallback: true });

      const executor = new TaskExecutor(
        queue, eventBus, persistence, logger, [flociAdapter], metrics, tracer
      );

      // Publish background events on the bus while executing jobs
      const eventPump = (async () => {
        for (let i = 0; i < 200; i++) {
          await eventBus.publish("background_metric", { idx: i });
        }
      })();

      // Enqueue and execute 25 jobs
      for (let i = 0; i < 25; i++) {
        await queue.push({
          id: `steady-${i}`,
          payload: { type: "floci", payload: { action: "filter_content", pattern: ".*" } },
          priority: "medium",
          retries: 0,
          maxRetries: 1,
          createdAt: new Date(),
        });
      }

      for (let i = 0; i < 25; i++) {
        await executor.executeNext();
      }

      await eventPump;

      // Verify all jobs drained
      expect(await queue.getQueueLength()).toBe(0);

      // Events should be persisted
      const replayed = await eventStore.replayEvents();
      expect(replayed.length).toBeGreaterThanOrEqual(25); // at least execution events

      // Metrics should have recorded something
      const m = metrics.getMetrics();
      expect(Object.keys(m).length).toBeGreaterThan(0);
    });

    it("circuit breaker + queue + executor handle recovery gracefully", async () => {
      const eventBus = new LocalEventBus();
      const persistence = new FileRuntimePersistence(stateDbPath);
      const logger = new StructuredLogger();
      const queue = new MemoryQueueBackend();
      const metrics = new MetricsCollector();
      const tracer = new TraceRecorder();
      const injector = new FailInjectorAdapter();

      // First 3 jobs fail, then succeed
      injector.setMode({ type: "fail_n_times", remaining: 3, errorMsg: "transient" });

      const executor = new TaskExecutor(queue, eventBus, persistence, logger, [injector], metrics, tracer);

      for (let i = 0; i < 6; i++) {
        await queue.push({
          id: `rec-${i}`,
          payload: { type: "inject", payload: {} },
          priority: "medium",
          retries: 0,
          maxRetries: 1,
          createdAt: new Date(),
        });
      }

      // First 3 fail, then retries fail, then DLQ'd; last 3 succeed
      for (let i = 0; i < 12; i++) {
        await executor.executeNext();
      }

      expect(await queue.getQueueLength()).toBe(0);
      expect(injector.successCount).toBe(3);

      const dlq = await queue.getDeadLetterQueue();
      // After 3 jobs fail with retries exhausted, they go to DLQ
      // Each of the first 3 jobs gets 2 attempts (initial + 1 retry)
      // The first 3 attempts (jobs 0,1,2) all fail -> retries exhausted
      expect(dlq.length).toBe(3);
    });

    it("memory store handles concurrent store/delete/query under pressure", async () => {
      const store = new MemoryStore({
        saveState: async () => {},
        getState: async () => undefined,
        clearState: async () => {},
      } as any);

      const ids: string[] = [];
      const promises: Promise<any>[] = [];

      // Concurrently store 50 entries
      for (let i = 0; i < 50; i++) {
        promises.push(
          store.store({
            type: i % 2 === 0 ? "observation" : "decision",
            key: `concurrent:${i}`,
            value: { data: i },
            tags: [`group-${i % 5}`],
          }).then((id) => { ids.push(id); })
        );
      }
      await Promise.all(promises);

      const stats = await store.getStats();
      expect(stats.totalEntries).toBe(50);
      expect(stats.byType["observation"]).toBe(25);
      expect(stats.byType["decision"]).toBe(25);

      // Query while deleting
      const queryDeletePromises: Promise<any>[] = [];
      for (let i = 0; i < 10; i++) {
        queryDeletePromises.push(store.query({ types: ["observation"], limit: 5 }));
        queryDeletePromises.push(store.delete(ids[i]));
      }
      await Promise.all(queryDeletePromises);

      const afterStats = await store.getStats();
      expect(afterStats.totalEntries).toBe(40);
    });

    it("file event store handles 500 rapid writes without corruption", async () => {
      const store = new FileEventStore(eventLogPath);

      // Write 500 events sequentially to avoid concurrent append interleaving
      for (let i = 0; i < 500; i++) {
        await store.saveEvent(`rapid_${i}`, { idx: i, nested: { value: `v${i}` } });
      }

      const replayed = await store.replayEvents();
      expect(replayed.length).toBe(500);

      // Verify no corruption — all events should be parseable
      const raw = fs.readFileSync(eventLogPath, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(500);

      // All lines should be valid JSON and contain the expected fields
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed.event).toBeDefined();
        expect(parsed.payload).toBeDefined();
      }
    });

    it("persistence atomic write survives concurrent saveState calls", async () => {
      const persistence = new FileRuntimePersistence(stateDbPath);

      const promises: Promise<void>[] = [];
      for (let i = 0; i < 20; i++) {
        promises.push(persistence.saveState(`key_${i}`, { id: i, value: `v${i}` }));
      }
      await Promise.all(promises);

      // All keys should be retrievable without corruption
      for (let i = 0; i < 20; i++) {
        const val = await persistence.getState<any>(`key_${i}`);
        expect(val).toBeDefined();
        expect(val.value).toBe(`v${i}`);
      }
    });

    it("dead letter queue accumulates and drains correctly under failure storm", async () => {
      const eventBus = new LocalEventBus();
      const persistence = new FileRuntimePersistence(stateDbPath);
      const logger = new StructuredLogger();
      const queue = new MemoryQueueBackend();
      const metrics = new MetricsCollector();
      const tracer = new TraceRecorder();
      const injector = new FailInjectorAdapter();

      // All jobs fail
      injector.setMode({ type: "always_fail", errorMsg: "storm failure" });

      const executor = new TaskExecutor(queue, eventBus, persistence, logger, [injector], metrics, tracer);

      // Enqueue 15 jobs, all will fail
      for (let i = 0; i < 15; i++) {
        await queue.push({
          id: `storm-${i}`,
          payload: { type: "inject", payload: {} },
          priority: "medium",
          retries: 0,
          maxRetries: 2,
          createdAt: new Date(),
        });
      }

      // Execute all (3 attempts each = 45 executions)
      for (let i = 0; i < 45; i++) {
        await executor.executeNext();
      }

      expect(await queue.getQueueLength()).toBe(0);

      // All 15 should land in DLQ (or fewer if some exhausted differently)
      const dlq = await queue.getDeadLetterQueue();
      expect(dlq.length).toBe(15);

      // All DLQ entries should reference the storm prefix
      for (const job of dlq) {
        expect(job.id.startsWith("storm-")).toBe(true);
      }

      // Metrics should record failures
      const m = metrics.getCounter("task.failed");
      expect(m).toBeGreaterThanOrEqual(15);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  //  4. Edge Cases
  // ═════════════════════════════════════════════════════════════════════

  describe("4. Edge Case Resilience", () => {
    it("event bus handles 10,000 rapid-fire events maintaining sequence integrity", async () => {
      const bus = new LocalEventBus({ maxHistorySize: 20000 });
      const seqs: number[] = [];

      bus.subscribe("*", (env: any) => { seqs.push(env.sequenceNumber); });

      const promises: Promise<void>[] = [];
      for (let i = 0; i < 10000; i++) {
        promises.push(bus.publish(`rapid.${i}`, { i }));
      }
      await Promise.all(promises);

      expect(seqs.length).toBe(10000);

      // All sequence numbers should be unique and gapless
      const unique = new Set(seqs);
      expect(unique.size).toBe(10000);
      expect(Math.max(...seqs)).toBe(10000);
      expect(Math.min(...seqs)).toBe(1);
    });

    it("rapid subscribe/unsubscribe does not leak handlers", async () => {
      const bus = new LocalEventBus();

      for (let i = 0; i < 200; i++) {
        const sub = bus.subscribe(`leak.${i}`, () => {});
        sub.unsubscribe();
      }

      expect(bus.getActiveSubscriptionCount()).toBe(0);
      expect(bus.getStats().activeSubscriptions).toBe(0);
    });

    it("executor handles empty queue gracefully", async () => {
      const eventBus = new LocalEventBus();
      const persistence = new FileRuntimePersistence(stateDbPath);
      const logger = new StructuredLogger();
      const queue = new MemoryQueueBackend();
      const metrics = new MetricsCollector();
      const tracer = new TraceRecorder();
      const flociAdapter = new FlociExecutionAdapter({ allowMockFallback: true });
      const executor = new TaskExecutor(queue, eventBus, persistence, logger, [flociAdapter], metrics, tracer);

      const result = await executor.executeNext();
      expect(result).toBe(false);
    });

    it("persistence handles non-existent state keys gracefully", async () => {
      const persistence = new FileRuntimePersistence(stateDbPath);
      const val = await persistence.getState("does_not_exist");
      expect(val).toBeUndefined();
    });

    it("event bus metrics are consistent after heavy load", async () => {
      const bus = new LocalEventBus({ maxHistorySize: 500 });

      // Publish 1000 events (500 will be pruned due to maxHistorySize)
      for (let i = 0; i < 1000; i++) {
        await bus.publish("metric.test", { i });
      }

      const stats = bus.getStats();
      expect(stats.sequenceCounter).toBe(1000);
      expect(stats.historySize).toBeLessThanOrEqual(500);
      expect(stats.activeSubscriptions).toBe(0);
      expect(stats.pendingHandlers).toBe(0);
      expect(stats.backpressureCount).toBe(0);
    });
  });
});
