// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

import { LocalEventBus } from "../src/event-bus.js";

describe("LocalEventBus — publish & subscribe", () => {
  let bus: LocalEventBus;

  beforeEach(() => {
    bus = new LocalEventBus();
  });

  it("delivers published event to subscriber", async () => {
    const handler = vi.fn();
    bus.subscribe("user.created", handler);
    await bus.publish("user.created", { id: "u1" });
    expect(handler).toHaveBeenCalledWith({ id: "u1" });
  });

  it("delivers to multiple subscribers for same event", async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.subscribe("msg", h1);
    bus.subscribe("msg", h2);
    await bus.publish("msg", "hello");
    expect(h1).toHaveBeenCalledWith("hello");
    expect(h2).toHaveBeenCalledWith("hello");
  });

  it("does not deliver to unsubscribed handlers", async () => {
    const handler = vi.fn();
    const sub = bus.subscribe("evt", handler);
    sub.unsubscribe();
    await bus.publish("evt", "data");
    expect(handler).not.toHaveBeenCalled();
  });

  it("wildcard '*' subscribers receive full EventEnvelope", async () => {
    const handler = vi.fn();
    bus.subscribe("*", handler);
    await bus.publish("foo.bar", { value: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
    const envelope = handler.mock.calls[0][0];
    expect(envelope.event).toBe("foo.bar");
    expect(envelope.payload).toEqual({ value: 1 });
    expect(typeof envelope.eventId).toBe("string");
    expect(typeof envelope.sequenceNumber).toBe("number");
  });

  it("does not deliver different event to unrelated subscriber", async () => {
    const handler = vi.fn();
    bus.subscribe("event.a", handler);
    await bus.publish("event.b", "data");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("LocalEventBus — deduplication", () => {
  let bus: LocalEventBus;

  beforeEach(() => {
    bus = new LocalEventBus();
  });

  it("drops duplicate events within dedup window", async () => {
    const handler = vi.fn();
    bus.subscribe("task.done", handler);
    await bus.publish("task.done", { id: 1 }, { dedupKey: "task-abc" });
    await bus.publish("task.done", { id: 2 }, { dedupKey: "task-abc" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(bus.getDeduplicationCount()).toBe(1);
  });

  it("allows same event with different dedup keys", async () => {
    const handler = vi.fn();
    bus.subscribe("task.done", handler);
    await bus.publish("task.done", { id: 1 }, { dedupKey: "key-1" });
    await bus.publish("task.done", { id: 2 }, { dedupKey: "key-2" });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("compact() clears dedup keys", async () => {
    await bus.publish("evt", {}, { dedupKey: "dup-key" });
    await bus.publish("evt", {}, { dedupKey: "dup-key" }); // deduped
    const { dedupKeysCleared } = bus.compact();
    expect(dedupKeysCleared).toBeGreaterThanOrEqual(1);
    // After compaction, the same key can be published again
    const handler = vi.fn();
    bus.subscribe("evt", handler);
    await bus.publish("evt", { fresh: true }, { dedupKey: "dup-key" });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("LocalEventBus — history", () => {
  let bus: LocalEventBus;

  beforeEach(() => {
    bus = new LocalEventBus();
  });

  it("getHistory() returns all published events", async () => {
    await bus.publish("a", 1);
    await bus.publish("b", 2);
    await bus.publish("c", 3);
    const history = bus.getHistory();
    expect(history).toHaveLength(3);
    expect(history.map((e) => e.event)).toEqual(["a", "b", "c"]);
  });

  it("getHistory(count) returns last N events", async () => {
    await bus.publish("a", 1);
    await bus.publish("b", 2);
    await bus.publish("c", 3);
    const last2 = bus.getHistory(2);
    expect(last2).toHaveLength(2);
    expect(last2[0].event).toBe("b");
    expect(last2[1].event).toBe("c");
  });

  it("ring buffer respects maxHistorySize", async () => {
    const smallBus = new LocalEventBus({ maxHistorySize: 3 });
    for (let i = 0; i < 5; i++) {
      await smallBus.publish("evt", i);
    }
    expect(smallBus.getHistory().length).toBeLessThanOrEqual(3);
  });

  it("replayEvents() returns events since a timestamp", async () => {
    await bus.publish("early", "e");
    // Wait so cutoff is strictly after the "early" event's timestamp
    await new Promise((r) => setTimeout(r, 10));
    const cutoff = new Date();
    await new Promise((r) => setTimeout(r, 5));
    await bus.publish("late", "l");
    const replayed = bus.replayEvents(cutoff);
    expect(replayed.some((e) => e.event === "late")).toBe(true);
    expect(replayed.some((e) => e.event === "early")).toBe(false);
  });

  it("compactHistory() removes old entries", async () => {
    await bus.publish("old", 1);
    await new Promise((r) => setTimeout(r, 20));
    await bus.publish("new", 2);
    const { prunedCount } = bus.compactHistory(10); // keep only last 10ms
    expect(prunedCount).toBeGreaterThanOrEqual(1);
    expect(bus.getHistory().every((e) => e.event === "new")).toBe(true);
  });
});

describe("LocalEventBus — sequence & causal chains", () => {
  let bus: LocalEventBus;

  beforeEach(() => {
    bus = new LocalEventBus();
  });

  it("sequence numbers are strictly increasing", async () => {
    await bus.publish("a", 1);
    await bus.publish("b", 2);
    await bus.publish("c", 3);
    const seqs = bus.getHistory().map((e) => e.sequenceNumber);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it("getOrderingGaps() returns empty for contiguous sequence", async () => {
    await bus.publish("x", 1);
    await bus.publish("y", 2);
    expect(bus.getOrderingGaps()).toHaveLength(0);
  });

  it("validateCausalChains() returns valid:true when no causal links", async () => {
    await bus.publish("a", 1);
    await bus.publish("b", 2);
    const report = bus.validateCausalChains();
    expect(report.valid).toBe(true);
    expect(report.cycleDetected).toBe(false);
    expect(report.eventsWithCauses).toBe(0);
  });

  it("validateCausalChains() links cause chain correctly", async () => {
    await bus.publish("root", { step: 1 });
    const parentId = bus.getHistory()[0].eventId;
    await bus.publish("child", { step: 2 }, { causeEventId: parentId });
    const report = bus.validateCausalChains();
    expect(report.valid).toBe(true);
    expect(report.eventsWithCauses).toBe(1);
    expect(report.missingCauseEvents).toHaveLength(0);
  });

  it("validateCausalChains() detects missing cause", async () => {
    await bus.publish("child", {}, { causeEventId: "nonexistent-event-id" });
    const report = bus.validateCausalChains();
    expect(report.valid).toBe(false);
    expect(report.missingCauseEvents).toContain("nonexistent-event-id");
  });
});

describe("LocalEventBus — getStats()", () => {
  it("tracks subscription count", () => {
    const bus = new LocalEventBus();
    const sub1 = bus.subscribe("a", vi.fn());
    const sub2 = bus.subscribe("b", vi.fn());
    expect(bus.getActiveSubscriptionCount()).toBe(2);
    sub1.unsubscribe();
    expect(bus.getActiveSubscriptionCount()).toBe(1);
    sub2.unsubscribe();
    expect(bus.getActiveSubscriptionCount()).toBe(0);
  });

  it("getStats() historySize reflects published events", async () => {
    const bus = new LocalEventBus();
    await bus.publish("x", 1);
    await bus.publish("y", 2);
    expect(bus.getStats().historySize).toBe(2);
  });
});

describe("LocalEventBus — error isolation", () => {
  it("handler errors do not prevent other handlers from running", async () => {
    const bus = new LocalEventBus();
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const succeeding = vi.fn();
    bus.subscribe("test", failing);
    bus.subscribe("test", succeeding);
    await bus.publish("test", "data");
    expect(succeeding).toHaveBeenCalledWith("data");
  });
});
