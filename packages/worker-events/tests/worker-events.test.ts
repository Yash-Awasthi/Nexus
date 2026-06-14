// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SseSerializer,
  EventFilter,
  EventReplay,
  EventChannel,
  SessionEventBroadcaster,
  type WorkerEvent,
  type SessionStartedEvent,
  type NewPromptEvent,
  type ObservationQueuedEvent,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(sessionId: string, overrides: Partial<WorkerEvent> = {}): WorkerEvent {
  return {
    type: "heartbeat",
    sessionId,
    id: "1",
    timestamp: new Date().toISOString(),
    uptimeMs: 0,
    ...overrides,
  } as WorkerEvent;
}

// ── SseSerializer ─────────────────────────────────────────────────────────────

describe("SseSerializer", () => {
  const serializer = new SseSerializer();

  it("encode produces SSE frame with id, event, data lines", () => {
    const event = makeEvent("s1", { type: "heartbeat", id: "42" }) as any;
    const frame = serializer.encode(event);
    expect(frame).toContain("id: 42");
    expect(frame).toContain("event: heartbeat");
    expect(frame).toContain("data:");
    expect(frame.endsWith("\n\n")).toBe(true);
  });

  it("decode round-trips an event", () => {
    const original = makeEvent("s1", { type: "heartbeat", id: "99", uptimeMs: 5000 }) as any;
    const frame = serializer.encode(original);
    const decoded = serializer.decode(frame);
    expect(decoded.type).toBe("heartbeat");
    expect(decoded.sessionId).toBe("s1");
    expect((decoded as any).uptimeMs).toBe(5000);
  });

  it("decode throws on invalid JSON", () => {
    expect(() => serializer.decode("data: not-json\n\n")).toThrow();
  });
});

// ── EventFilter ───────────────────────────────────────────────────────────────

describe("EventFilter", () => {
  it("byType matches correct event types", () => {
    const f = EventFilter.byType("heartbeat", "error");
    expect(f(makeEvent("s1", { type: "heartbeat" }))).toBe(true);
    expect(f(makeEvent("s1", { type: "new_prompt" } as any))).toBe(false);
  });

  it("bySession matches correct sessionId", () => {
    const f = EventFilter.bySession("session-A");
    expect(f(makeEvent("session-A"))).toBe(true);
    expect(f(makeEvent("session-B"))).toBe(false);
  });

  it("and returns true only when all predicates pass", () => {
    const f = EventFilter.and(
      EventFilter.bySession("s1"),
      EventFilter.byType("heartbeat"),
    );
    expect(f(makeEvent("s1", { type: "heartbeat" }))).toBe(true);
    expect(f(makeEvent("s2", { type: "heartbeat" }))).toBe(false);
    expect(f(makeEvent("s1", { type: "error" } as any))).toBe(false);
  });

  it("or returns true when any predicate passes", () => {
    const f = EventFilter.or(
      EventFilter.byType("heartbeat"),
      EventFilter.byType("error"),
    );
    expect(f(makeEvent("s1", { type: "heartbeat" }))).toBe(true);
    expect(f(makeEvent("s1", { type: "error" } as any))).toBe(true);
    expect(f(makeEvent("s1", { type: "new_prompt" } as any))).toBe(false);
  });

  it("not inverts predicate", () => {
    const f = EventFilter.not(EventFilter.byType("heartbeat"));
    expect(f(makeEvent("s1", { type: "heartbeat" }))).toBe(false);
    expect(f(makeEvent("s1", { type: "error" } as any))).toBe(true);
  });
});

// ── EventReplay ───────────────────────────────────────────────────────────────

describe("EventReplay", () => {
  it("stores events up to maxSize", () => {
    const replay = new EventReplay(3);
    replay.push(makeEvent("s", { id: "1" }));
    replay.push(makeEvent("s", { id: "2" }));
    replay.push(makeEvent("s", { id: "3" }));
    replay.push(makeEvent("s", { id: "4" })); // evicts "1"
    expect(replay.size()).toBe(3);
    const all = replay.all();
    expect(all.map((e) => e.id)).toEqual(["2", "3", "4"]);
  });

  it("since returns all events when lastId is empty", () => {
    const replay = new EventReplay(10);
    replay.push(makeEvent("s", { id: "1" }));
    replay.push(makeEvent("s", { id: "2" }));
    expect(replay.since("")).toHaveLength(2);
  });

  it("since returns events after the given id", () => {
    const replay = new EventReplay(10);
    replay.push(makeEvent("s", { id: "1" }));
    replay.push(makeEvent("s", { id: "2" }));
    replay.push(makeEvent("s", { id: "3" }));
    expect(replay.since("1").map((e) => e.id)).toEqual(["2", "3"]);
  });

  it("since returns all when lastId not found", () => {
    const replay = new EventReplay(10);
    replay.push(makeEvent("s", { id: "1" }));
    replay.push(makeEvent("s", { id: "2" }));
    expect(replay.since("99")).toHaveLength(2);
  });

  it("clear removes all events", () => {
    const replay = new EventReplay(10);
    replay.push(makeEvent("s", { id: "1" }));
    replay.clear();
    expect(replay.size()).toBe(0);
  });

  it("all returns a defensive copy", () => {
    const replay = new EventReplay(10);
    replay.push(makeEvent("s", { id: "1" }));
    const copy = replay.all();
    copy.push(makeEvent("s", { id: "99" }));
    expect(replay.size()).toBe(1);
  });
});

// ── EventChannel ──────────────────────────────────────────────────────────────

describe("EventChannel", () => {
  it("publish calls subscriber handler", () => {
    const ch = new EventChannel("s1");
    const received: WorkerEvent[] = [];
    ch.subscribe((e) => received.push(e));
    ch.publish({ type: "heartbeat", uptimeMs: 0 } as any);
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("heartbeat");
  });

  it("publish assigns sessionId and id automatically", () => {
    const ch = new EventChannel("session-X");
    let ev: WorkerEvent | null = null;
    ch.subscribe((e) => { ev = e; });
    ch.publish({ type: "heartbeat", uptimeMs: 0 } as any);
    expect(ev!.sessionId).toBe("session-X");
    expect(ev!.id).toBe("1");
    expect(typeof ev!.timestamp).toBe("string");
  });

  it("publish increments id monotonically", () => {
    const ch = new EventChannel("s");
    const ids: string[] = [];
    ch.subscribe((e) => ids.push(e.id));
    ch.publish({ type: "heartbeat", uptimeMs: 0 } as any);
    ch.publish({ type: "heartbeat", uptimeMs: 0 } as any);
    ch.publish({ type: "heartbeat", uptimeMs: 0 } as any);
    expect(ids).toEqual(["1", "2", "3"]);
  });

  it("subscribe with predicate filters events", () => {
    const ch = new EventChannel("s");
    const heartbeats: WorkerEvent[] = [];
    ch.subscribe((e) => heartbeats.push(e), EventFilter.byType("heartbeat"));
    ch.publish({ type: "heartbeat", uptimeMs: 0 } as any);
    ch.publish({ type: "new_prompt", promptId: "p1", role: "user", contentPreview: "hi" } as any);
    expect(heartbeats).toHaveLength(1);
  });

  it("unsubscribe stops delivery", () => {
    const ch = new EventChannel("s");
    const received: WorkerEvent[] = [];
    const unsub = ch.subscribe((e) => received.push(e));
    ch.publish({ type: "heartbeat", uptimeMs: 0 } as any);
    unsub();
    ch.publish({ type: "heartbeat", uptimeMs: 0 } as any);
    expect(received).toHaveLength(1);
  });

  it("subscriberCount tracks active subscribers", () => {
    const ch = new EventChannel("s");
    const unsub1 = ch.subscribe(() => {});
    const unsub2 = ch.subscribe(() => {});
    expect(ch.subscriberCount).toBe(2);
    unsub1();
    expect(ch.subscriberCount).toBe(1);
    unsub2();
    expect(ch.subscriberCount).toBe(0);
  });

  it("catchUp delivers replayed events to handler", () => {
    const ch = new EventChannel("s", 20);
    ch.publish({ type: "heartbeat", uptimeMs: 0 } as any);
    ch.publish({ type: "heartbeat", uptimeMs: 100 } as any);
    const replayed: WorkerEvent[] = [];
    ch.catchUp("", (e) => replayed.push(e));
    expect(replayed).toHaveLength(2);
  });

  it("catchUp delivers only events after lastId", () => {
    const ch = new EventChannel("s", 20);
    const e1 = ch.publish({ type: "heartbeat", uptimeMs: 0 } as any);
    ch.publish({ type: "heartbeat", uptimeMs: 1 } as any);
    const replayed: WorkerEvent[] = [];
    ch.catchUp(e1.id, (e) => replayed.push(e));
    expect(replayed).toHaveLength(1);
  });

  it("publish throws after close", () => {
    const ch = new EventChannel("s");
    ch.close();
    expect(() => ch.publish({ type: "heartbeat", uptimeMs: 0 } as any)).toThrow("closed");
  });

  it("isClosed reflects close() call", () => {
    const ch = new EventChannel("s");
    expect(ch.isClosed).toBe(false);
    ch.close();
    expect(ch.isClosed).toBe(true);
  });

  it("subscriber errors do not prevent other subscribers from receiving", () => {
    const ch = new EventChannel("s");
    let second = false;
    ch.subscribe(() => { throw new Error("subscriber crash"); });
    ch.subscribe(() => { second = true; });
    ch.publish({ type: "heartbeat", uptimeMs: 0 } as any);
    expect(second).toBe(true);
  });
});

// ── SessionEventBroadcaster ───────────────────────────────────────────────────

describe("SessionEventBroadcaster", () => {
  let broadcaster: SessionEventBroadcaster;

  beforeEach(() => { broadcaster = new SessionEventBroadcaster(); });

  it("channel creates and returns same instance", () => {
    const ch1 = broadcaster.channel("s1");
    const ch2 = broadcaster.channel("s1");
    expect(ch1).toBe(ch2);
  });

  it("publish creates channel and delivers event", () => {
    const received: WorkerEvent[] = [];
    broadcaster.channel("s1").subscribe((e) => received.push(e));
    broadcaster.publish("s1", { type: "heartbeat", uptimeMs: 0 } as any);
    expect(received).toHaveLength(1);
  });

  it("channelCount tracks open channels", () => {
    broadcaster.channel("s1");
    broadcaster.channel("s2");
    expect(broadcaster.channelCount()).toBe(2);
  });

  it("sessionIds lists all channel ids", () => {
    broadcaster.channel("alpha");
    broadcaster.channel("beta");
    expect(broadcaster.sessionIds()).toContain("alpha");
    expect(broadcaster.sessionIds()).toContain("beta");
  });

  it("closeChannel removes channel", () => {
    broadcaster.channel("s1");
    broadcaster.closeChannel("s1");
    expect(broadcaster.hasChannel("s1")).toBe(false);
  });

  it("closeAll removes all channels", () => {
    broadcaster.channel("s1");
    broadcaster.channel("s2");
    broadcaster.closeAll();
    expect(broadcaster.channelCount()).toBe(0);
  });

  it("broadcast delivers to all open channels", () => {
    const s1events: WorkerEvent[] = [];
    const s2events: WorkerEvent[] = [];
    broadcaster.channel("s1").subscribe((e) => s1events.push(e));
    broadcaster.channel("s2").subscribe((e) => s2events.push(e));
    broadcaster.broadcast({ type: "heartbeat", uptimeMs: 0, sessionId: "broadcast" } as any);
    expect(s1events).toHaveLength(1);
    expect(s2events).toHaveLength(1);
  });
});
