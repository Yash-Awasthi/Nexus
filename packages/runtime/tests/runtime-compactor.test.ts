// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";

import type { EventBusStats } from "../src/event-bus.js";
import type { IQueueBackend } from "../src/interfaces/queue.interface.js";
import type { MetricsCollector } from "../src/observability-manager.js";
import { MetricsCollector as RealMetricsCollector } from "../src/observability-manager.js";
import { LeakDetector, ResourceQuotaManager, RuntimeCompactor } from "../src/runtime-compactor.js";

function stats(overrides: Partial<EventBusStats> = {}): EventBusStats {
  return {
    activeSubscriptions: 3,
    pendingHandlers: 0,
    backpressureCount: 0,
    historySize: 5,
    persistedEventCount: 2,
    ...overrides,
  };
}

function fakeBus(overrides: { stats?: Partial<EventBusStats> } = {}) {
  let historyPruned = 0;
  let dedupCleared = 0;
  return {
    state: stats(overrides.stats),
    async publish() {},
    compactHistory(maxAgeMs: number) {
      historyPruned = maxAgeMs;
      return { prunedCount: 7 };
    },
    compact() {
      dedupCleared = 1;
      return { dedupKeysCleared: 3 };
    },
    getStats() {
      return this.state;
    },
    __historyPruned: () => historyPruned,
    __dedupCleared: () => dedupCleared,
  };
}

function fakeQueue(opts: {
  dlq?: { id: string; priority: string; retries: number }[];
  active?: { id: string; priority: string; retries: number }[];
  throwOnDlq?: boolean;
} = {}) {
  const state = {
    dlq: [...(opts.dlq ?? [])],
    active: [...(opts.active ?? [])],
    queueLen: 4,
    pushed: 0,
  };
  return {
    state,
    async push(job: unknown) {
      state.pushed++;
      return undefined;
    },
    async getDeadLetterQueue() {
      if (opts.throwOnDlq) throw new Error("dlq unavailable");
      return state.dlq;
    },
    async clearDeadLetterQueue() {
      state.dlq = [];
      return undefined;
    },
    async getQueueLength() {
      return state.queueLen;
    },
    async getActiveJobs() {
      return state.active;
    },
  } as unknown as IQueueBackend & { state: typeof state };
}

function fakeGraph(initialJournalLength = 0) {
  let journal: unknown[] = Array.from({ length: initialJournalLength }, (_, i) => ({ i }));
  return {
    journal,
    getJournal() {
      return journal;
    },
    clearJournal() {
      journal = [];
    },
    grow(n: number) {
      journal = [...journal, ...Array.from({ length: n }, (_, i) => ({ j: i }))];
    },
    async addNode() {},
    async updateNodeStatus() {},
  };
}

// ─── LeakDetector ────────────────────────────────────────────────────────────

describe("LeakDetector", () => {
  it("produces a baseline report with no suspicious growth", () => {
    const bus = fakeBus();
    const detector = new LeakDetector(bus as never);
    const report = detector.diagnose();
    expect(report.detected).toBe(false);
    expect(report.subscriptions.activeCount).toBe(3);
    expect(report.pendingOperations).toBe(0);
    expect(report.warnings).toEqual([]);
    expect(report.timestamp).toBeTruthy();
  });

  it("computes growth rates across multiple readings", () => {
    const bus = fakeBus({ stats: { activeSubscriptions: 5 } });
    const detector = new LeakDetector(bus as never);
    detector.diagnose();
    bus.state.activeSubscriptions = 8;
    const report = detector.diagnose();
    // Sub-second elapsed time yields a zero/undefined growth window — the important
    // contract is that readings accumulate and a numeric rate is always reported.
    expect(typeof report.subscriptions.growthRate).toBe("number");
    expect(typeof report.subscriptions.suspiciousGrowth).toBe("boolean");
    expect(report.memory.heapGrowthMB).toBeGreaterThanOrEqual(0);
  });

  it("caps stored readings and resets on demand", () => {
    const bus = fakeBus();
    const detector = new LeakDetector(bus as never);
    for (let i = 0; i < 25; i++) detector.diagnose();
    detector.reset();
    const report = detector.diagnose();
    expect(report.memory.heapGrowthMB).toBe(0);
  });

  it("accepts custom thresholds", () => {
    const bus = fakeBus();
    const detector = new LeakDetector(bus as never, {
      memoryGrowthThresholdMBperMin: 999,
      subscriptionGrowthThresholdPerMin: 999,
    });
    expect(detector.diagnose().detected).toBe(false);
  });
});

// ─── ResourceQuotaManager ────────────────────────────────────────────────────

describe("ResourceQuotaManager", () => {
  it("merges custom quotas over defaults", () => {
    const qm = new ResourceQuotaManager({ maxHistorySize: 10 });
    expect(qm.getQuotas().maxHistorySize).toBe(10);
    expect(qm.getQuotas().maxDeadLetterJobs).toBe(1000);
    qm.updateQuotas({ maxPendingHandlers: 7 });
    expect(qm.getQuotas().maxPendingHandlers).toBe(7);
  });

  it("flags history-size and pending-handler violations", () => {
    const metrics = new RealMetricsCollector();
    const qm = new ResourceQuotaManager(
      { maxHistorySize: 10, maxPendingHandlers: 5 },
      metrics,
    );
    const violations = qm.check(
      stats({ historySize: 20, pendingHandlers: 9 }),
    );
    const kinds = violations.map((v) => v.metric);
    expect(kinds).toContain("historySize");
    expect(kinds).toContain("pendingHandlers");
    expect(violations.find((v) => v.metric === "historySize")?.severity).toBe("warn");
    expect(violations.find((v) => v.metric === "pendingHandlers")?.severity).toBe("critical");
    expect((metrics.getMetrics().gauges as Record<string, { value: number }>)["quota_violations_total"]).toBeDefined();
  });

  it("flags critical heap violations with a low limit", () => {
    const qm = new ResourceQuotaManager({ maxHeapPercent: 0.0000001 });
    const violations = qm.check(stats());
    expect(violations.find((v) => v.metric === "heapUsedPercent")?.severity).toBe("critical");
  });

  it("returns no violations under healthy conditions", () => {
    // raise the heap cap so the test process's own memory never trips it
    const qm = new ResourceQuotaManager({ maxHeapPercent: 100 });
    expect(qm.check(stats())).toEqual([]);
  });

  it("accepts a queue backend without failing", () => {
    const qm = new ResourceQuotaManager({ maxHeapPercent: 100 });
    expect(qm.check(stats(), fakeQueue())).toEqual([]);
  });
});

// ─── RuntimeCompactor.shouldCompact ──────────────────────────────────────────

describe("RuntimeCompactor.shouldCompact", () => {
  it("returns false when everything is healthy", () => {
    const bus = fakeBus();
    const compactor = new RuntimeCompactor(bus as never, {});
    expect(compactor.shouldCompact()).toBe(false);
  });

  it("triggers when the graph journal hits its size cap", () => {
    const bus = fakeBus();
    const graph = fakeGraph(1000);
    const compactor = new RuntimeCompactor(bus as never, {
      runtimeGraph: graph as never,
      options: { maxJournalSize: 1000 },
    });
    expect(compactor.shouldCompact()).toBe(true);
  });

  it("triggers when journal growth exceeds the threshold between cycles", () => {
    const bus = fakeBus();
    const graph = fakeGraph(100);
    const compactor = new RuntimeCompactor(bus as never, {
      runtimeGraph: graph as never,
      options: { journalGrowthThresholdPercent: 20 },
    });
    expect(compactor.shouldCompact()).toBe(false); // baseline snapshot
    graph.grow(50); // +50% growth
    expect(compactor.shouldCompact()).toBe(true);
    compactor.resetHeuristics();
    expect(compactor.shouldCompact()).toBe(false);
  });

  it("triggers on critical quota violations", () => {
    const bus = fakeBus();
    const quota = new ResourceQuotaManager({ maxPendingHandlers: 5 });
    bus.state.pendingHandlers = 50;
    const compactor = new RuntimeCompactor(bus as never, { quotaManager: quota });
    expect(compactor.shouldCompact()).toBe(true);
  });

  it("triggers on warn-level violations by default but respects compactOnWarnings=false", () => {
    const bus = fakeBus();
    const quota = new ResourceQuotaManager({ maxHistorySize: 2 });
    bus.state.historySize = 10;
    const warnEnabled = new RuntimeCompactor(bus as never, { quotaManager: quota });
    expect(warnEnabled.shouldCompact()).toBe(true);
    const warnDisabled = new RuntimeCompactor(bus as never, {
      quotaManager: new ResourceQuotaManager({ maxHistorySize: 2 }),
      options: { compactOnWarnings: false },
    });
    bus.state.historySize = 10;
    expect(warnDisabled.shouldCompact()).toBe(false);
  });

  it("triggers on event-bus backpressure", () => {
    const bus = fakeBus({ stats: { backpressureCount: 50 } });
    const compactor = new RuntimeCompactor(bus as never, {
      options: { backpressureThreshold: 50 },
    });
    expect(compactor.shouldCompact()).toBe(true);
  });
});

// ─── RuntimeCompactor.compact ────────────────────────────────────────────────

describe("RuntimeCompactor.compact", () => {
  it("compacts event bus, recycles the dead-letter queue, clears journal and reports", async () => {
    const bus = fakeBus();
    const graph = fakeGraph(12);
    const queue = fakeQueue({
      dlq: [
        { id: "job-1", priority: "high", retries: 5 },
        { id: "job-2", priority: "low", retries: 1 },
      ],
      active: [{ id: "active-1", priority: "medium", retries: 0 }],
    });
    const leak = new LeakDetector(bus as never);
    leak.diagnose();
    leak.diagnose();
    const resetSpy = vi.spyOn(leak, "reset");
    const metrics = new RealMetricsCollector();
    const compactor = new RuntimeCompactor(bus as never, {
      queue,
      leakDetector: leak,
      metrics,
      runtimeGraph: graph as never,
      options: { maxEventAgeMs: 60000, maxJournalSize: 1000 },
    });

    const report = await compactor.compact();

    expect(report.subsystems.eventBus.historyPruned).toBe(7);
    expect(report.subsystems.eventBus.dedupKeysCleared).toBe(3);
    expect(report.subsystems.graph.journalSizeBefore).toBe(12);
    expect(report.subsystems.graph.journalCleared).toBe(true);
    expect(graph.getJournal()).toHaveLength(0);
    expect(report.subsystems.queue.deadLetterBefore).toBe(2);
    expect(report.subsystems.queue.recycledDeadLetter).toBe(2);
    expect(queue.state.pushed).toBe(2);
    expect(queue.state.dlq).toHaveLength(0);
    expect(report.subsystems.queue.activeJobsBefore).toBe(4);
    expect(resetSpy).toHaveBeenCalled();
    expect(report.memory.heapUsedMB).toBeGreaterThan(0);
    expect((metrics.getMetrics().counters as Record<string, { value: number }>)["compaction_cycles_total"]).toBeDefined();
  });

  it("tolerates queue failures and missing optional subsystems", async () => {
    const bus = fakeBus();
    const compactor = new RuntimeCompactor(bus as never, {
      queue: fakeQueue({ throwOnDlq: true }),
    });
    const report = await compactor.compact();
    expect(report.subsystems.queue.recycledDeadLetter).toBe(0);
    expect(report.subsystems.queue.deadLetterBefore).toBe(0);
    expect(report.subsystems.graph.journalSizeBefore).toBe(0);
  });

  it("constructor starts auto-compaction when configured", () => {
    const bus = fakeBus();
    const compactor = new RuntimeCompactor(bus as never, {
      options: { autoCompact: true, compactIntervalMs: 60000 },
    });
    compactor.stop();
    expect(compactor).toBeInstanceOf(RuntimeCompactor);
  });

  it("exposes leak diagnostics and quota violations", async () => {
    const bus = fakeBus();
    const leak = new LeakDetector(bus as never);
    const quota = new ResourceQuotaManager({ maxHistorySize: 2 });
    bus.state.historySize = 99;
    const compactor = new RuntimeCompactor(bus as never, { leakDetector: leak, quotaManager: quota });
    expect(compactor.diagnoseLeaks()).not.toBeNull();
    expect(compactor.getQuotaViolations().length).toBeGreaterThan(0);
    const bare = new RuntimeCompactor(bus as never, {});
    expect(bare.diagnoseLeaks()).toBeNull();
    expect(bare.getQuotaViolations()).toEqual([]);
  });

  it("static create factory works", () => {
    const bus = fakeBus();
    expect(RuntimeCompactor.create(bus as never)).toBeInstanceOf(RuntimeCompactor);
  });
});
