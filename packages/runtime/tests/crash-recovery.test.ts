// SPDX-License-Identifier: Apache-2.0
import * as fc from "fast-check";
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  CrashRecovery,
  MemoryRecoveryStore,
  type TaskRecord,
  type CrashRecoveryConfig,
} from "../src/crash-recovery.js";
import type { IEventBus } from "../src/event-bus.js";
import { MemoryQueueBackend } from "../src/queue-backend.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

function makeEventBus(): IEventBus {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
    getActiveSubscriptionCount: vi.fn().mockReturnValue(0),
    getDeduplicationCount: vi.fn().mockReturnValue(0),
    compact: vi.fn().mockReturnValue({ dedupKeysCleared: 0 }),
  } as unknown as IEventBus;
}

function makeTask(overrides?: Partial<TaskRecord>): TaskRecord {
  return {
    id: `task-${Math.random().toString(36).slice(2)}`,
    type: "email.send",
    payload: { to: "test@example.com" },
    status: "running",
    priority: "medium",
    retries: 0,
    maxRetries: 3,
    startedAt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago — stale
    ...overrides,
  };
}

function makeConfig(
  store: MemoryRecoveryStore,
  queue: MemoryQueueBackend,
  eventBus: IEventBus,
  opts?: Partial<CrashRecoveryConfig>,
): CrashRecoveryConfig {
  return {
    store,
    queue,
    eventBus,
    staleThresholdMs: 5 * 60 * 1000, // 5 minutes
    ...opts,
  };
}

// ─── CrashRecovery unit tests ─────────────────────────────────────────────────

describe("CrashRecovery", () => {
  let store: MemoryRecoveryStore;
  let queue: MemoryQueueBackend;
  let eventBus: IEventBus;
  let recovery: CrashRecovery;

  beforeEach(() => {
    store = new MemoryRecoveryStore();
    queue = new MemoryQueueBackend();
    eventBus = makeEventBus();
    recovery = new CrashRecovery(makeConfig(store, queue, eventBus));
  });

  it("returns zero counts when no tasks are running", async () => {
    const result = await recovery.recover();
    expect(result.scanned).toBe(0);
    expect(result.requeued).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("re-queues a stale running task", async () => {
    const task = makeTask();
    store.seed(task);

    const result = await recovery.recover();

    expect(result.scanned).toBe(1);
    expect(result.requeued).toBe(1);
    expect(store.getTask(task.id)?.status).toBe("queued");
  });

  it("increments retry count on the recovered task", async () => {
    const task = makeTask({ retries: 1 });
    store.seed(task);

    await recovery.recover();

    expect(store.getTask(task.id)?.retries).toBe(2);
  });

  it("marks task as failed when retries exhausted", async () => {
    const task = makeTask({ retries: 3, maxRetries: 3 });
    store.seed(task);

    const result = await recovery.recover();

    expect(store.getTask(task.id)?.status).toBe("failed");
    expect(result.requeued).toBe(0);
  });

  it("pushes recovered task into the queue backend", async () => {
    const task = makeTask();
    store.seed(task);

    await recovery.recover();

    const queueLen = await queue.getQueueLength();
    expect(queueLen).toBe(1);
  });

  it("does NOT re-queue a task that is still within the stale threshold", async () => {
    const freshTask = makeTask({
      startedAt: new Date(Date.now() - 60_000), // 1 minute ago — fresh
    });
    store.seed(freshTask);

    const result = await recovery.recover();

    expect(result.skipped).toBe(1);
    expect(result.requeued).toBe(0);
    expect(store.getTask(freshTask.id)?.status).toBe("running"); // unchanged
  });

  it("handles tasks with no startedAt as stale", async () => {
    const task = makeTask({ startedAt: undefined });
    store.seed(task);

    const result = await recovery.recover();

    expect(result.requeued).toBe(1);
  });

  it("emits nexus.runtime.crash_recovery event when tasks are recovered", async () => {
    store.seed(makeTask());
    await recovery.recover();

    const publishMock = eventBus.publish as ReturnType<typeof vi.fn>;
    const events = publishMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(events).toContain("nexus.runtime.crash_recovery");
  });

  it("does NOT emit nexus.runtime.crash_recovery when nothing to recover", async () => {
    // Seed a fresh (non-stale) task
    store.seed(makeTask({ startedAt: new Date(Date.now() - 10_000) }));
    await recovery.recover();

    const publishMock = eventBus.publish as ReturnType<typeof vi.fn>;
    const events = publishMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(events).not.toContain("nexus.runtime.crash_recovery");
  });

  it("emits nexus.tasks.recovered for each re-queued task", async () => {
    const t1 = makeTask();
    const t2 = makeTask();
    store.seed(t1);
    store.seed(t2);

    await recovery.recover();

    const publishMock = eventBus.publish as ReturnType<typeof vi.fn>;
    const events = publishMock.mock.calls.map((c: unknown[]) => c[0]);
    const recoveredEvents = events.filter((e: string) => e === "nexus.tasks.recovered");
    expect(recoveredEvents.length).toBe(2);
  });

  it("emits nexus.tasks.failed for exhausted-retry tasks", async () => {
    store.seed(makeTask({ retries: 3, maxRetries: 3 }));
    await recovery.recover();

    const publishMock = eventBus.publish as ReturnType<typeof vi.fn>;
    const events = publishMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(events).toContain("nexus.tasks.failed");
  });

  it("is idempotent — second call finds no stale tasks", async () => {
    store.seed(makeTask());

    await recovery.recover(); // first run: requeues 1 task
    vi.mocked(eventBus.publish).mockClear();

    const result2 = await recovery.recover(); // second run: nothing to do
    expect(result2.requeued).toBe(0);
    expect(result2.scanned).toBe(0); // task is now "queued", not "running"
  });

  it("handles mixed stale and fresh tasks correctly", async () => {
    const stale = makeTask({ startedAt: new Date(Date.now() - 10 * 60 * 1000) });
    const fresh = makeTask({ startedAt: new Date(Date.now() - 30 * 1000) });
    store.seed(stale);
    store.seed(fresh);

    const result = await recovery.recover();

    expect(result.scanned).toBe(2);
    expect(result.requeued).toBe(1);
    expect(result.skipped).toBe(1);
  });
});

// ─── Property-based: recovery is always idempotent ───────────────────────────

describe("CrashRecovery — property-based", () => {
  const priorityArb = fc.constantFrom("low", "medium", "high") as fc.Arbitrary<
    "low" | "medium" | "high"
  >;

  it("second recover() always has 0 requeued (idempotency)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            priority: priorityArb,
            retries: fc.nat({ max: 2 }),
            maxRetries: fc.constant(3),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async (taskDefs) => {
          const store = new MemoryRecoveryStore();
          const queue = new MemoryQueueBackend();
          const eventBus = makeEventBus();
          const recovery = new CrashRecovery(makeConfig(store, queue, eventBus));

          for (const def of taskDefs) {
            store.seed(
              makeTask({
                ...def,
                startedAt: new Date(Date.now() - 10 * 60 * 1000), // all stale
              }),
            );
          }

          await recovery.recover(); // first run
          const result2 = await recovery.recover(); // second run

          expect(result2.requeued).toBe(0);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("requeued + failed + skipped always equals scanned", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            retries: fc.nat({ max: 5 }),
            maxRetries: fc.constant(3),
            staleDeltaMs: fc.integer({ min: -60_000, max: 20 * 60_000 }),
          }),
          { minLength: 0, maxLength: 15 },
        ),
        async (taskDefs) => {
          const store = new MemoryRecoveryStore();
          const queue = new MemoryQueueBackend();
          const eventBus = makeEventBus();
          const recovery = new CrashRecovery(makeConfig(store, queue, eventBus));

          for (const def of taskDefs) {
            store.seed(
              makeTask({
                retries: def.retries,
                maxRetries: def.maxRetries,
                startedAt: new Date(Date.now() - def.staleDeltaMs),
              }),
            );
          }

          const result = await recovery.recover();
          expect(result.requeued + result.failed + result.skipped).toBe(result.scanned);
        },
      ),
      { numRuns: 40 },
    );
  });
});
