// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  SseSerializer,
  SseEventBuffer,
  SseChannel,
  SseSessionManager,
  type SseEvent,
} from "../src/index.js";

// ── SseSerializer ─────────────────────────────────────────────────────────────

describe("SseSerializer", () => {
  it("encode produces valid SSE frame", () => {
    const event: SseEvent = {
      id: "1",
      type: "block",
      sessionId: "s1",
      data: { content: "hello" },
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const frame = SseSerializer.encode(event);
    expect(frame).toContain("id: 1");
    expect(frame).toContain("event: block");
    expect(frame).toContain("data:");
    expect(frame.endsWith("\n\n")).toBe(true);
  });

  it("decode round-trips an event", () => {
    const event: SseEvent = {
      id: "42",
      type: "researchComplete",
      sessionId: "sess-x",
      data: { summary: "done" },
      timestamp: "2026-06-14T00:00:00.000Z",
    };
    const frame = SseSerializer.encode(event);
    const decoded = SseSerializer.decode(frame);
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe("42");
    expect(decoded!.type).toBe("researchComplete");
    expect(decoded!.sessionId).toBe("sess-x");
  });

  it("decode returns null for malformed frame", () => {
    expect(SseSerializer.decode("not-sse")).toBeNull();
  });
});

// ── SseEventBuffer ────────────────────────────────────────────────────────────

describe("SseEventBuffer", () => {
  function makeEvent(id: string): SseEvent {
    return { id, type: "block", sessionId: "s1", data: {}, timestamp: new Date().toISOString() };
  }

  it("push and all return events", () => {
    const buf = new SseEventBuffer(10);
    buf.push(makeEvent("1"));
    buf.push(makeEvent("2"));
    expect(buf.all()).toHaveLength(2);
    expect(buf.size()).toBe(2);
  });

  it("evicts oldest when at maxSize", () => {
    const buf = new SseEventBuffer(3);
    buf.push(makeEvent("1"));
    buf.push(makeEvent("2"));
    buf.push(makeEvent("3"));
    buf.push(makeEvent("4"));
    expect(buf.size()).toBe(3);
    expect(buf.all()[0]!.id).toBe("2");
  });

  it("since returns events after lastId", () => {
    const buf = new SseEventBuffer(10);
    buf.push(makeEvent("1"));
    buf.push(makeEvent("2"));
    buf.push(makeEvent("3"));
    const events = buf.since("1");
    expect(events).toHaveLength(2);
    expect(events[0]!.id).toBe("2");
  });

  it("since unknown id returns all events", () => {
    const buf = new SseEventBuffer(10);
    buf.push(makeEvent("5"));
    buf.push(makeEvent("6"));
    const events = buf.since("999");
    expect(events).toHaveLength(2);
  });

  it("last returns most recent event", () => {
    const buf = new SseEventBuffer(10);
    buf.push(makeEvent("1"));
    buf.push(makeEvent("2"));
    expect(buf.last()!.id).toBe("2");
  });

  it("clear empties buffer", () => {
    const buf = new SseEventBuffer(10);
    buf.push(makeEvent("1"));
    buf.clear();
    expect(buf.size()).toBe(0);
  });
});

// ── SseChannel ────────────────────────────────────────────────────────────────

describe("SseChannel", () => {
  it("publish delivers to subscribers", () => {
    const ch = new SseChannel("session-1");
    const received: SseEvent[] = [];
    ch.subscribe((e) => received.push(e));
    ch.publish("block", { content: "hello" });
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("block");
    expect(received[0]!.sessionId).toBe("session-1");
  });

  it("multiple subscribers all receive", () => {
    const ch = new SseChannel("s1");
    const r1: SseEvent[] = [];
    const r2: SseEvent[] = [];
    ch.subscribe((e) => r1.push(e));
    ch.subscribe((e) => r2.push(e));
    ch.block("hi");
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });

  it("unsubscribe stops delivery", () => {
    const ch = new SseChannel("s1");
    const received: SseEvent[] = [];
    const sub = ch.subscribe((e) => received.push(e));
    sub.unsubscribe();
    ch.block("hi");
    expect(received).toHaveLength(0);
  });

  it("reconnect with lastId replays missed events", () => {
    const ch = new SseChannel("s1");
    const e1 = ch.block("msg1");
    ch.block("msg2");

    const received: SseEvent[] = [];
    ch.subscribe((e) => received.push(e), e1.id);
    // Should have received msg2 (the one after e1) immediately
    expect(received).toHaveLength(1);
    expect(received[0]!.data).toMatchObject({ content: "msg2" });
  });

  it("block/updateBlock/researchComplete/heartbeat emit correct types", () => {
    const ch = new SseChannel("s1");
    const types: string[] = [];
    ch.subscribe((e) => types.push(e.type));
    ch.block("content");
    ch.updateBlock("blk-1", "updated");
    ch.researchComplete("done");
    ch.heartbeat();
    expect(types).toEqual(["block", "updateBlock", "researchComplete", "heartbeat"]);
  });

  it("publish after close throws", () => {
    const ch = new SseChannel("s1");
    ch.close();
    expect(() => ch.publish("block", {})).toThrow("closed");
  });

  it("subscriberCount tracks active subscribers", () => {
    const ch = new SseChannel("s1");
    const sub = ch.subscribe(() => {});
    expect(ch.subscriberCount()).toBe(1);
    sub.unsubscribe();
    expect(ch.subscriberCount()).toBe(0);
  });

  it("close sets isClosed and clears subscribers", () => {
    const ch = new SseChannel("s1");
    ch.subscribe(() => {});
    ch.close();
    expect(ch.isClosed()).toBe(true);
    expect(ch.subscriberCount()).toBe(0);
  });
});

// ── SseSessionManager ─────────────────────────────────────────────────────────

describe("SseSessionManager", () => {
  it("getOrCreate creates channel on first call", () => {
    const mgr = new SseSessionManager();
    const ch = mgr.getOrCreate("session-1");
    expect(ch.sessionId).toBe("session-1");
    expect(mgr.count()).toBe(1);
  });

  it("getOrCreate returns same channel on second call", () => {
    const mgr = new SseSessionManager();
    const ch1 = mgr.getOrCreate("s1");
    const ch2 = mgr.getOrCreate("s1");
    expect(ch1).toBe(ch2);
  });

  it("has returns correct boolean", () => {
    const mgr = new SseSessionManager();
    mgr.getOrCreate("s1");
    expect(mgr.has("s1")).toBe(true);
    expect(mgr.has("s2")).toBe(false);
  });

  it("publish creates channel and delivers event", () => {
    const mgr = new SseSessionManager();
    const received: SseEvent[] = [];
    mgr.subscribe("s1", (e) => received.push(e));
    mgr.publish("s1", "block", { content: "test" });
    expect(received).toHaveLength(1);
  });

  it("subscribe with lastId triggers replay", () => {
    const mgr = new SseSessionManager();
    const e1 = mgr.publish("s1", "block", { content: "first" });
    mgr.publish("s1", "block", { content: "second" });

    const received: SseEvent[] = [];
    mgr.subscribe("s1", (e) => received.push(e), e1.id);
    expect(received).toHaveLength(1);
    expect(received[0]!.data).toMatchObject({ content: "second" });
  });

  it("close removes channel", () => {
    const mgr = new SseSessionManager();
    mgr.getOrCreate("s1");
    expect(mgr.close("s1")).toBe(true);
    expect(mgr.has("s1")).toBe(false);
  });

  it("closeAll closes all channels", () => {
    const mgr = new SseSessionManager();
    mgr.getOrCreate("s1");
    mgr.getOrCreate("s2");
    mgr.closeAll();
    expect(mgr.count()).toBe(0);
  });

  it("activeSessions returns all session ids", () => {
    const mgr = new SseSessionManager();
    mgr.getOrCreate("s1");
    mgr.getOrCreate("s2");
    const ids = mgr.activeSessions();
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
  });
});
