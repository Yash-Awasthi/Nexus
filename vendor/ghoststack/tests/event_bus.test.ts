import { LocalEventBus, IEventStore, SequenceGap, CausalValidationReport } from "../orchestration/event-bus";

// ---------------------------------------------------------------------------
// In-memory event store for persistence testing
// ---------------------------------------------------------------------------
class InMemoryEventStore implements IEventStore {
  public events: any[] = [];

  async saveEvent(event: string, payload: any): Promise<void> {
    // Persist a copy so the test can inspect it
    this.events.push({ event, payload, timestamp: new Date().toISOString() });
  }

  async replayEvents(since?: Date): Promise<any[]> {
    if (!since) return [...this.events];
    const sinceTime = since.getTime();
    return this.events.filter(
      (raw: any) => new Date(raw.timestamp).getTime() >= sinceTime
    );
  }
}

describe("Event Bus — Core", () => {
  it("should subscribe, publish, and unsubscribe successfully", async () => {
    const bus = new LocalEventBus();
    let receivedPayload: any = null;

    const subscription = bus.subscribe("test_event", (payload) => {
      receivedPayload = payload;
    });

    await bus.publish("test_event", { message: "hello" });
    expect(receivedPayload).toEqual({ message: "hello" });

    receivedPayload = null;
    subscription.unsubscribe();

    await bus.publish("test_event", { message: "ignored" });
    expect(receivedPayload).toBeNull();
  });

  it("should deliver to wildcard (*) handlers with full envelope", async () => {
    const bus = new LocalEventBus();
    let receivedEnvelope: any = null;

    bus.subscribe("*", (envelope) => {
      receivedEnvelope = envelope;
    });

    await bus.publish("some.event", { data: 42 });
    expect(receivedEnvelope).not.toBeNull();
    expect(receivedEnvelope.event).toBe("some.event");
    expect(receivedEnvelope.payload).toEqual({ data: 42 });
    expect(receivedEnvelope.eventId).toMatch(/^evt-/);
    expect(receivedEnvelope.sequenceNumber).toBe(1);
  });
});

describe("Event Bus — History Ring Buffer", () => {
  it("should retain published events in history", async () => {
    const bus = new LocalEventBus({ maxHistorySize: 100 });
    expect(bus.getHistory()).toHaveLength(0);

    await bus.publish("evt.a", { n: 1 });
    await bus.publish("evt.b", { n: 2 });

    const history = bus.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].event).toBe("evt.a");
    expect(history[1].event).toBe("evt.b");
  });

  it("should respect maxHistorySize and prune oldest entries", async () => {
    const bus = new LocalEventBus({ maxHistorySize: 3 });

    for (let i = 0; i < 10; i++) {
      await bus.publish(`evt.${i}`, { n: i });
    }

    const history = bus.getHistory();
    expect(history.length).toBeLessThanOrEqual(3);
    // Should retain the most recent events
    expect(history[history.length - 1].event).toBe("evt.9");
  });

  it("getHistory(count) should return the last N events", async () => {
    const bus = new LocalEventBus({ maxHistorySize: 100 });

    for (let i = 0; i < 10; i++) {
      await bus.publish(`evt.${i}`, { n: i });
    }

    const last3 = bus.getHistory(3);
    expect(last3).toHaveLength(3);
    expect(last3[0].event).toBe("evt.7");
    expect(last3[2].event).toBe("evt.9");
  });

  it("replayEvents(since) should return events after the given time", async () => {
    const bus = new LocalEventBus({ maxHistorySize: 100 });
    // Publish two "before" events with a known timestamp ceiling
    const _before1 = new Date();
    await bus.publish("before.1", {});
    await bus.publish("before.2", {});

    // Wait enough to guarantee the "after" events have strictly later timestamps
    await new Promise((r) => setTimeout(r, 25));
    const after1 = new Date();
    await bus.publish("after.1", {});
    await bus.publish("after.2", {});

    // Use the timestamp captured after the delay as the cutoff
    const replayed = bus.replayEvents(after1);
    expect(replayed.length).toBeGreaterThanOrEqual(2);
    expect(replayed.every((e) => e.event.startsWith("after"))).toBe(true);
  });
});

describe("Event Bus — Sequence Ordering", () => {
  it("should assign monotonically increasing sequence numbers", async () => {
    const bus = new LocalEventBus();
    const seqs: number[] = [];

    bus.subscribe("*", (env) => { seqs.push(env.sequenceNumber); });

    for (let i = 0; i < 50; i++) {
      await bus.publish("evt", { i });
    }

    // Sequence numbers should be 1..50 without gaps
    for (let i = 0; i < seqs.length; i++) {
      expect(seqs[i]).toBe(i + 1);
    }
  });

  it("getOrderingGaps() should return empty for gapless history", async () => {
    const bus = new LocalEventBus();
    for (let i = 0; i < 10; i++) {
      await bus.publish("evt", { i });
    }
    expect(bus.getOrderingGaps()).toHaveLength(0);
  });

  it("getOrderingGaps() should detect missing sequence numbers", async () => {
    const bus = new LocalEventBus({ maxHistorySize: 1000 });
    // Publish events 1..10 normally
    for (let i = 0; i < 10; i++) {
      await bus.publish("evt", { i });
    }

    // Force a gap by directly manipulating the sequence counter
    (bus as any).sequenceCounter = 15;
    await bus.publish("jump", { n: 15 });

    await bus.publish("final", { n: 16 });

    const gaps: SequenceGap[] = bus.getOrderingGaps();
    expect(gaps.length).toBeGreaterThanOrEqual(1);
    // Should report 11,12,13,14 as missing
    const allMissing = gaps.flatMap((g) => g.missingSequenceNumbers);
    expect(allMissing).toEqual(expect.arrayContaining([11, 12, 13, 14]));
  });
});

describe("Event Bus — Causal Chain Validation", () => {
  it("should validate valid causal chains", async () => {
    const bus = new LocalEventBus();

    // Create a chain: evt1 → evt2 → evt3
    await bus.publish("root", { msg: "root" });
    const h = bus.getHistory();
    const rootId = h[0].eventId;

    await bus.publish("child", { msg: "child" }, { causeEventId: rootId });
    const h2 = bus.getHistory();
    const childId = h2[1].eventId;

    await bus.publish("grandchild", { msg: "grandchild" }, { causeEventId: childId });

    const report: CausalValidationReport = bus.validateCausalChains();
    expect(report.valid).toBe(true);
    expect(report.eventsWithCauses).toBe(2);
    expect(report.missingCauseEvents).toHaveLength(0);
    expect(report.orphanChains).toBe(0);
    expect(report.cycleDetected).toBe(false);
  });

  it("should detect missing cause events (orphans)", async () => {
    const bus = new LocalEventBus();
    await bus.publish("orphan", { msg: "no parent" }, { causeEventId: "nonexistent-id" });

    const report: CausalValidationReport = bus.validateCausalChains();
    expect(report.valid).toBe(false);
    expect(report.missingCauseEvents).toContain("nonexistent-id");
    expect(report.orphanChains).toBe(1);
  });

  it("should detect self-causing cycles", async () => {
    const bus = new LocalEventBus();
    await bus.publish("self", { msg: "self cause" }, { causeEventId: "evt-self-reference" });
    const h = bus.getHistory();
    // Force the event's own ID into its causeChain
    const evt = h[0];
    (evt as any).causeChain = [evt.eventId];

    const report: CausalValidationReport = bus.validateCausalChains();
    expect(report.cycleDetected).toBe(true);
    expect(report.valid).toBe(false);
  });

  it("should report totalEvents and eventsWithCauses correctly", async () => {
    const bus = new LocalEventBus();

    await bus.publish("a", {});
    await bus.publish("b", {}, { causeEventId: "some-id" });
    await bus.publish("c", {});

    const report = bus.validateCausalChains();
    expect(report.totalEvents).toBe(3);
    expect(report.eventsWithCauses).toBe(1);
  });
});

describe("Event Bus — Deduplication", () => {
  it("should suppress duplicate events with the same dedupKey", async () => {
    const bus = new LocalEventBus();
    let callCount = 0;

    bus.subscribe("dedup_evt", () => { callCount++; });

    await bus.publish("dedup_evt", { data: 1 }, { dedupKey: "key-1" });
    await bus.publish("dedup_evt", { data: 2 }, { dedupKey: "key-1" }); // dedup'd
    await bus.publish("dedup_evt", { data: 3 }, { dedupKey: "key-2" }); // new key

    expect(callCount).toBe(2);
    expect(bus.getDeduplicationCount()).toBe(1);
  });

  it("should allow different dedupKeys through", async () => {
    const bus = new LocalEventBus();
    let callCount = 0;

    bus.subscribe("evt", () => { callCount++; });

    await bus.publish("evt", {}, { dedupKey: "a" });
    await bus.publish("evt", {}, { dedupKey: "b" });
    await bus.publish("evt", {}, { dedupKey: "c" });

    expect(callCount).toBe(3);
  });
});

describe("Event Bus — Backpressure", () => {
  it("should not drop events under normal load", async () => {
    const bus = new LocalEventBus();
    let count = 0;

    bus.subscribe("normal", async () => { count++; });

    for (let i = 0; i < 50; i++) {
      await bus.publish("normal", { i });
    }

    expect(count).toBe(50);
  });

  it("should drop events when backpressure threshold is exceeded", async () => {
    const bus = new LocalEventBus();
    let _slowCount = 0;

    // Slow handler — introduces backpressure
    bus.subscribe("slow", async () => {
      await new Promise((r) => setTimeout(r, 50));
      _slowCount++;
    });

    // Fire many events rapidly to exceed MAX_PENDING
    const publishes = [];
    for (let i = 0; i < 150; i++) {
      publishes.push(bus.publish("slow", { i }));
    }
    await Promise.all(publishes);

    const stats = bus.getStats();
    // Some events should have been dropped
    expect(stats.backpressureCount).toBeGreaterThan(0);
  });
});

describe("Event Bus — Persistence (IEventStore)", () => {
  it("should persist events via write-before-dispatch", async () => {
    const store = new InMemoryEventStore();
    const bus = new LocalEventBus({ eventStore: store });

    await bus.publish("test.event", { msg: "hello" });

    expect(store.events).toHaveLength(1);
    const persisted = store.events[0];
    expect(persisted.event).toBe("test.event");
    // payload is the raw EventEnvelope (not pre-serialized) — verify the envelope fields
    expect(persisted.payload.event).toBe("test.event");
    expect(persisted.payload.payload).toEqual({ msg: "hello" });
    expect(persisted.payload.eventId).toMatch(/^evt-/);
    expect(persisted.payload.sequenceNumber).toBe(1);
  });

  it("should respect persistFilter", async () => {
    const store = new InMemoryEventStore();
    const bus = new LocalEventBus({
      eventStore: store,
      persistFilter: (evt) => evt.startsWith("persist.")
    });

    await bus.publish("persist.yes", {});
    await bus.publish("skip.me", {});
    await bus.publish("persist.too", {});

    expect(store.events).toHaveLength(2);
  });

  it("should recover from store errors gracefully (no crash)", async () => {
    const store = new InMemoryEventStore();
    // Simulate a failure after the first save
    const originalSave = store.saveEvent.bind(store);
    let callCount = 0;
    store.saveEvent = async (event, payload) => {
      callCount++;
      if (callCount > 1) throw new Error("Store unavailable");
      return originalSave(event, payload);
    };

    const bus = new LocalEventBus({ eventStore: store });

    await bus.publish("ok", {}); // succeeds
    await bus.publish("fail", {}); // fails gracefully

    expect(callCount).toBe(2);
    expect(store.events).toHaveLength(1); // only the first persisted
    // Verify the bus still works (handler received both)
    const stats = bus.getStats();
    expect(stats.sequenceCounter).toBe(2);
    expect(stats.persistedEventCount).toBe(1);
  });
});

describe("Event Bus — Stats", () => {
  it("getStats should include historySize and persistedEventCount", async () => {
    const bus = new LocalEventBus({ maxHistorySize: 50 });
    await bus.publish("evt", { n: 1 });

    const stats = bus.getStats();
    expect(stats.historySize).toBe(1);
    expect(stats.persistedEventCount).toBe(0);
    expect(stats.sequenceCounter).toBe(1);
    expect(stats.activeSubscriptions).toBe(0);
    expect(stats.pendingHandlers).toBe(0);
  });
});

describe("Event Bus — Compaction", () => {
  it("compact() should clear dedup keys", async () => {
    const bus = new LocalEventBus();
    await bus.publish("evt", {}, { dedupKey: "k1" });
    await bus.publish("evt", {}, { dedupKey: "k2" });
    expect(bus.getStats().dedupKeysInWindow).toBe(2);

    const result = bus.compact();
    expect(result.dedupKeysCleared).toBe(2);
    expect(bus.getStats().dedupKeysInWindow).toBe(0);
  });

  it("compactHistory() should prune old events", async () => {
    const bus = new LocalEventBus({ maxHistorySize: 1000 });

    await bus.publish("old", { ts: 1 });
    await new Promise((r) => setTimeout(r, 20));
    await bus.publish("new", { ts: 2 });

    // Prune events older than 10ms
    const result = bus.compactHistory(10);
    expect(result.prunedCount).toBeGreaterThanOrEqual(1);
    expect(bus.getHistory().every((e) => e.event === "new")).toBe(true);
  });
});

describe("Event Bus — Stress & Storm Resilience", () => {
  it("should handle 1000 rapid events without error", async () => {
    const bus = new LocalEventBus({ maxHistorySize: 2000 });
    let received = 0;

    bus.subscribe("storm", () => { received++; });

    const promises: Promise<void>[] = [];
    for (let i = 0; i < 1000; i++) {
      promises.push(bus.publish("storm", { i }));
    }
    await Promise.all(promises);

    expect(received).toBe(1000);
    expect(bus.getHistory()).toHaveLength(1000);
  });

  it("should maintain correct sequence numbers under concurrent publish", async () => {
    const bus = new LocalEventBus({ maxHistorySize: 5000 });
    const seqs: number[] = [];

    bus.subscribe("*", (env) => { seqs.push(env.sequenceNumber); });

    // Fire events concurrently
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 500; i++) {
      promises.push(bus.publish(`evt.${i}`, { i }));
    }
    await Promise.all(promises);

    expect(seqs.length).toBe(500);
    // All sequence numbers should be unique
    const unique = new Set(seqs);
    expect(unique.size).toBe(500);
    // Max should be exactly 500
    expect(Math.max(...seqs)).toBe(500);
  });

  it("should not leak handlers after repeated subscribe/unsubscribe cycles", async () => {
    const bus = new LocalEventBus();
    const cycles = 100;

    for (let i = 0; i < cycles; i++) {
      const sub = bus.subscribe("leak.test", () => {});
      sub.unsubscribe();
    }

    expect(bus.getActiveSubscriptionCount()).toBe(0);
    expect(bus.getStats().activeSubscriptions).toBe(0);
  });
});

describe("Event Bus — Fuzzing & Edge Cases", () => {
  it("should handle empty events gracefully", async () => {
    const bus = new LocalEventBus();
    await bus.publish("empty", undefined);
    await bus.publish("null", null);

    const history = bus.getHistory();
    expect(history).toHaveLength(2);
  });

  it("should handle very long event names", async () => {
    const bus = new LocalEventBus();
    const longName = "x".repeat(1000);
    await bus.publish(longName, {});

    expect(bus.getHistory()[0].event).toBe(longName);
  });

  it("getHistory/getOrderingGaps/validateCausalChains on empty bus", () => {
    const bus = new LocalEventBus();
    expect(bus.getHistory()).toHaveLength(0);
    expect(bus.getOrderingGaps()).toHaveLength(0);

    const report = bus.validateCausalChains();
    expect(report.totalEvents).toBe(0);
    expect(report.valid).toBe(true);
  });
});

describe("Event Bus — no config", () => {
  it("should work without any config (backward compatibility)", async () => {
    const bus = new LocalEventBus();
    let val: any = null;
    bus.subscribe("noconfig", (p) => { val = p; });
    await bus.publish("noconfig", { works: true });
    expect(val).toEqual({ works: true });
  });
});
