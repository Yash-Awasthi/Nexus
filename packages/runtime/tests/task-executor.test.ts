// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

import { TaskExecutor } from "../src/task-executor.js";
import type { IEventBus } from "../src/event-bus.js";
import type { IQueueBackend, QueueJob } from "../src/interfaces/queue.interface.js";
import type { IExecutionAdapter } from "../src/interfaces/execution.interface.js";
import type { ILogger } from "../src/interfaces/logger.interface.js";
import type {
  IMetricsCollector,
  ITraceRecorder,
  ITraceSpan,
} from "../src/interfaces/observability.interface.js";
import type { IRuntimePersistence } from "../src/interfaces/persistence.interface.js";

// ── Fakes ──────────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<QueueJob> = {}): QueueJob {
  return {
    id: "job-1",
    payload: { type: "floci", action: "run" },
    priority: "medium",
    retries: 0,
    maxRetries: 2,
    createdAt: new Date(),
    ...overrides,
  };
}

class FakeQueue implements IQueueBackend {
  jobs: QueueJob[] = [];
  dlq: QueueJob[] = [];
  movesToDlq: { job: QueueJob; error: string }[] = [];

  async push(job: QueueJob): Promise<void> {
    // Mirror real backends: an exhausted job routes to the dead-letter queue.
    if (job.retries >= job.maxRetries) this.dlq.push(job);
    else this.jobs.push(job);
  }
  async pop(): Promise<QueueJob | undefined> {
    return this.jobs.shift();
  }
  async moveToDeadLetter(job: QueueJob, error: string): Promise<void> {
    this.movesToDlq.push({ job, error });
  }
  async getDeadLetterQueue(): Promise<QueueJob[]> {
    return this.dlq;
  }
  async clearDeadLetterQueue(): Promise<void> {
    this.dlq = [];
  }
  async getQueueLength(): Promise<number> {
    return this.jobs.length;
  }
  async getActiveJobs(): Promise<QueueJob[]> {
    return this.jobs;
  }
}

const logger: ILogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

/** Minimal event-bus double — TaskExecutor only publishes. */
class FakeBus {
  published: { channel: string; data: unknown }[] = [];
  async publish(channel: string, data: unknown): Promise<void> {
    this.published.push({ channel, data });
  }
}

class FakePersistence implements IRuntimePersistence {
  saved: { key: string; state: unknown }[] = [];
  async saveState(key: string, state: unknown): Promise<void> {
    this.saved.push({ key, state });
  }
  async getState<T>(): Promise<T | undefined> {
    return undefined;
  }
  async clearState(): Promise<void> {
    this.saved = [];
  }
}

class FakeMetrics implements IMetricsCollector {
  calls: string[] = [];
  increment(name: string, amount = 1): void {
    this.calls.push(`inc:${name}:${amount}`);
  }
  recordGauge(name: string, value: number): void {
    this.calls.push(`gauge:${name}:${value}`);
  }
  recordTiming(name: string, durationMs: number): void {
    this.calls.push(`timing:${name}:${durationMs}`);
  }
  getMetrics(): Record<string, unknown> {
    return {};
  }
  reset(): void {
    this.calls = [];
  }
}

class FakeTracer implements ITraceRecorder {
  spans: ITraceSpan[] = [];
  ended: { spanId: string; metadata?: Record<string, unknown> }[] = [];
  startSpan(name: string, parentId?: string): ITraceSpan {
    const span = { spanId: `span-${this.spans.length + 1}`, name, parentId, startTime: new Date() };
    this.spans.push(span);
    return span;
  }
  endSpan(spanId: string, metadata?: Record<string, unknown>): void {
    this.ended.push({ spanId, metadata });
  }
  getSpans(): ITraceSpan[] {
    return this.spans;
  }
  clear(): void {
    this.spans = [];
  }
}

function adapterFor(type: string, impl?: Partial<IExecutionAdapter>): IExecutionAdapter {
  return {
    canExecute: (t: string) => t === type,
    execute: vi.fn(async () => ({ ok: true })),
    ...impl,
  };
}

interface Rig {
  queue: FakeQueue;
  bus: FakeBus;
  persistence: FakePersistence;
  metrics: FakeMetrics;
  tracer: FakeTracer;
  executor: TaskExecutor;
}

function makeRig(adapters: IExecutionAdapter[]): Rig {
  const queue = new FakeQueue();
  const bus = new FakeBus();
  const persistence = new FakePersistence();
  const metrics = new FakeMetrics();
  const tracer = new FakeTracer();
  const executor = new TaskExecutor(
    queue as unknown as IQueueBackend,
    bus as unknown as IEventBus,
    persistence as unknown as IRuntimePersistence,
    logger,
    adapters,
    metrics as unknown as IMetricsCollector,
    tracer as unknown as ITraceRecorder,
  );
  return { queue, bus, persistence, metrics, tracer, executor };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("TaskExecutor", () => {
  it("start logs the runtime start", async () => {
    const { executor } = makeRig([]);
    await executor.start();
    expect(logger.info).toHaveBeenCalledWith("Task Executor core runtime started.");
  });

  it("executeNext returns false on an empty queue", async () => {
    const { executor } = makeRig([]);
    expect(await executor.executeNext()).toBe(false);
  });

  it("dead-letters a job whose type has no adapter", async () => {
    const rig = makeRig([adapterFor("floci")]);
    rig.queue.jobs.push(makeJob({ payload: { type: "unknown-kind" } }));

    expect(await rig.executor.executeNext()).toBe(false);
    expect(rig.queue.movesToDlq).toHaveLength(1);
    expect(rig.queue.movesToDlq[0]?.error).toContain("Unsupported task type");
    expect(rig.metrics.calls).toContain("inc:task.failed:1");
    expect(rig.metrics.calls).toContain("inc:task.dead_letter:1");
  });

  it("executes a job successfully: state, events, metrics, trace", async () => {
    const rig = makeRig([adapterFor("floci")]);
    rig.queue.jobs.push(makeJob());

    expect(await rig.executor.executeNext()).toBe(true);
    expect(rig.metrics.calls.some((c) => c.startsWith("gauge:queue.size:"))).toBe(true);
    expect(rig.metrics.calls).toContain("inc:task.executed:1");
    expect(rig.metrics.calls).toContain("inc:task.success:1");
    expect(rig.persistence.saved[0]?.state).toMatchObject({
      status: "success",
      result: { ok: true },
    });
    const channels = rig.bus.published.map((p) => p.channel);
    expect(channels).toEqual(["execution_started", "execution_succeeded"]);
    expect(rig.tracer.ended[0]?.spanId).toBe("span-1");
    expect(rig.tracer.ended[0]?.metadata).toMatchObject({ status: "success" });
  });

  it("records floci-specific metrics when the payload carries them", async () => {
    const rig = makeRig([
      adapterFor("floci", {
        execute: vi.fn(async () => ({ ok: true, flociRequestMs: 42, mocked: true })),
      }),
    ]);
    rig.queue.jobs.push(makeJob());

    await rig.executor.executeNext();
    expect(rig.metrics.calls).toContain("timing:floci.request_ms:42");
    expect(rig.metrics.calls).toContain("inc:floci.mocked:1");

    const rig2 = makeRig([
      adapterFor("floci", {
        execute: vi.fn(async () => ({ ok: true, flociRequestMs: 7, mocked: false })),
      }),
    ]);
    rig2.queue.jobs.push(makeJob());
    await rig2.executor.executeNext();
    expect(rig2.metrics.calls).toContain("timing:floci.request_ms:7");
    expect(rig2.metrics.calls).toContain("inc:floci.live:1");
  });

  it("on failure with retries left: re-queues and schedules exponential backoff", async () => {
    const rig = makeRig([
      adapterFor("floci", {
        execute: vi.fn(async () => {
          throw new Error("boom");
        }),
      }),
    ]);
    rig.queue.jobs.push(makeJob({ retries: 0, maxRetries: 3 }));

    expect(await rig.executor.executeNext()).toBe(false);
    // Backoff for retry 1 = 500ms * 2^0 = 500ms, capped at 30s.
    expect((rig.executor as unknown as { _pendingRetryDelayMs: number })._pendingRetryDelayMs).toBe(
      500,
    );
    expect(rig.queue.jobs).toHaveLength(1); // re-queued
    expect(rig.queue.jobs[0]?.retries).toBe(1);
    expect(rig.metrics.calls).toContain("inc:task.retry:1");
    expect(rig.metrics.calls).not.toContain("inc:task.dead_letter:1");
    expect(rig.persistence.saved[0]?.state).toMatchObject({ status: "failed", error: "boom" });
    expect(rig.bus.published.some((p) => p.channel === "execution_failed")).toBe(true);
  });

  it("on exhausted retries: routes the job to the dead-letter queue", async () => {
    const rig = makeRig([
      adapterFor("floci", {
        execute: vi.fn(async () => {
          throw new Error("boom");
        }),
      }),
    ]);
    rig.queue.jobs.push(makeJob({ retries: 2, maxRetries: 2 }));

    expect(await rig.executor.executeNext()).toBe(false);
    expect(rig.metrics.calls).toContain("inc:task.dead_letter:1");
    expect(rig.queue.dlq).toHaveLength(1); // push routed exhausted job to DLQ
    expect((rig.executor as unknown as { _pendingRetryDelayMs: number })._pendingRetryDelayMs).toBe(
      0,
    );
  });

  it("caps exponential backoff at 30 seconds", async () => {
    const rig = makeRig([
      adapterFor("floci", {
        execute: vi.fn(async () => {
          throw new Error("boom");
        }),
      }),
    ]);
    rig.queue.jobs.push(makeJob({ retries: 6, maxRetries: 50 })); // 2^6 = 64000ms → capped

    await rig.executor.executeNext();
    expect((rig.executor as unknown as { _pendingRetryDelayMs: number })._pendingRetryDelayMs).toBe(
      30_000,
    );
  });

  it("runLoop drains the queue and returns the success count", async () => {
    const rig = makeRig([adapterFor("floci")]);
    rig.queue.jobs.push(makeJob({ id: "a" }), makeJob({ id: "b" }));

    const processed = await rig.executor.runLoop(10, 1);
    expect(processed).toBe(2);
  });

  it("runLoop stops after maxIterations even when the queue never drains", async () => {
    const rig = makeRig([
      adapterFor("floci", {
        execute: vi.fn(async () => {
          throw new Error("always-fails");
        }),
      }),
    ]);
    // One job that always fails and gets re-queued (retries < maxRetries keeps it alive).
    rig.queue.jobs.push(makeJob({ retries: 0, maxRetries: 1_000_000 }));

    // 2 iterations: the retry-backoff path resets consecutiveEmpty, so it would run
    // forever — maxIterations must cap it (2 iterations = one 500ms backoff wait).
    const processed = await rig.executor.runLoop(2, 1);
    expect(processed).toBe(0);
  });

  it("runLoop exits once the queue is confirmed drained (3 empty polls)", async () => {
    const rig = makeRig([adapterFor("floci")]);
    // Seed one job; after it is consumed the queue is empty and runLoop must exit.
    rig.queue.jobs.push(makeJob());

    const processed = await rig.executor.runLoop(1_000, 1);
    expect(processed).toBe(1);
  });
});
