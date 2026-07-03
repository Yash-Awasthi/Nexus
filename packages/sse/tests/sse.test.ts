// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  formatSseEvent,
  formatPing,
  SseEventBus,
  publishTaskUpdate,
  publishSignal,
  publishVerdict,
  dispatchAgentEvent,
  globalBus,
  type SseEvent,
  type TaskUpdatePayload,
  type SignalPayload,
  type VerdictPayload,
} from "../src/index.js";

// ── formatSseEvent ────────────────────────────────────────────────────────────

describe("formatSseEvent", () => {
  it("emits data-only event (no event name, no id)", () => {
    const out = formatSseEvent({ data: { hello: "world" } });
    expect(out).toBe('data: {"hello":"world"}\n\n');
  });

  it("includes event field when provided", () => {
    const out = formatSseEvent({ event: "task.update", data: { taskId: "t1" } });
    expect(out).toContain("event: task.update\n");
  });

  it("includes id field when provided", () => {
    const out = formatSseEvent({ event: "x", data: {}, id: "abc-123" });
    expect(out).toContain("id: abc-123\n");
    // id should appear before event and data
    expect(out.indexOf("id:")).toBeLessThan(out.indexOf("event:"));
  });

  it("includes retry field when provided", () => {
    const out = formatSseEvent({ data: {}, retry: 3000 });
    expect(out).toContain("retry: 3000\n");
  });

  it("field order is id → retry → event → data", () => {
    const out = formatSseEvent({ event: "e", data: "x", id: "1", retry: 1000 });
    const idPos = out.indexOf("id:");
    const retryPos = out.indexOf("retry:");
    const eventPos = out.indexOf("event:");
    const dataPos = out.indexOf("data:");
    expect(idPos).toBeLessThan(retryPos);
    expect(retryPos).toBeLessThan(eventPos);
    expect(eventPos).toBeLessThan(dataPos);
  });

  it("terminates with double newline", () => {
    const out = formatSseEvent({ data: "x" });
    expect(out.endsWith("\n\n")).toBe(true);
  });

  it("passes string data through without extra JSON encoding", () => {
    const out = formatSseEvent({ data: "plain text" });
    expect(out).toBe("data: plain text\n\n");
  });

  it("splits multi-line string data into multiple data: lines", () => {
    const out = formatSseEvent({ data: "line one\nline two\nline three" });
    expect(out).toBe("data: line one\ndata: line two\ndata: line three\n\n");
  });

  it("handles empty object data", () => {
    const out = formatSseEvent({ data: {} });
    expect(out).toBe("data: {}\n\n");
  });

  it("handles array data", () => {
    const out = formatSseEvent({ data: [1, 2, 3] });
    expect(out).toBe("data: [1,2,3]\n\n");
  });

  it("handles null data", () => {
    const out = formatSseEvent({ data: null });
    expect(out).toBe("data: null\n\n");
  });
});

// ── formatPing ────────────────────────────────────────────────────────────────

describe("formatPing", () => {
  it("returns SSE comment ending in double newline", () => {
    expect(formatPing()).toBe(":ping\n\n");
  });
});

// ── SseEventBus ───────────────────────────────────────────────────────────────

describe("SseEventBus — subscribe/publish", () => {
  let bus: SseEventBus;

  beforeEach(() => {
    bus = new SseEventBus();
  });

  it("delivers published event to subscriber", () => {
    const listener = vi.fn();
    bus.subscribe("tasks", listener);
    const event: SseEvent = { event: "task.update", data: { taskId: "t1" } };
    bus.publish("tasks", event);
    expect(listener).toHaveBeenCalledWith(event);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("delivers to multiple subscribers on same channel", () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    bus.subscribe("tasks", l1);
    bus.subscribe("tasks", l2);
    bus.publish("tasks", { data: "hello" });
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });

  it("does not cross-deliver to different channels", () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    bus.subscribe("tasks", l1);
    bus.subscribe("signals", l2);
    bus.publish("tasks", { data: "t" });
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).not.toHaveBeenCalled();
  });

  it("delivers multiple publishes to same subscriber", () => {
    const listener = vi.fn();
    bus.subscribe("tasks", listener);
    bus.publish("tasks", { data: 1 });
    bus.publish("tasks", { data: 2 });
    bus.publish("tasks", { data: 3 });
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe("SseEventBus — unsubscribe", () => {
  let bus: SseEventBus;

  beforeEach(() => {
    bus = new SseEventBus();
  });

  it("stops delivery after unsubscribe", () => {
    const listener = vi.fn();
    bus.subscribe("tasks", listener);
    bus.publish("tasks", { data: "a" });
    bus.unsubscribe("tasks", listener);
    bus.publish("tasks", { data: "b" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("subscribe returns an unsubscribe function that works", () => {
    const listener = vi.fn();
    const unsub = bus.subscribe("tasks", listener);
    bus.publish("tasks", { data: "a" });
    unsub();
    bus.publish("tasks", { data: "b" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("unsubscribing one listener does not affect others", () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    bus.subscribe("tasks", l1);
    bus.subscribe("tasks", l2);
    bus.unsubscribe("tasks", l1);
    bus.publish("tasks", { data: "x" });
    expect(l1).not.toHaveBeenCalled();
    expect(l2).toHaveBeenCalledTimes(1);
  });

  it("unsubscribing non-existent listener is a no-op", () => {
    const listener = vi.fn();
    expect(() => bus.unsubscribe("tasks", listener)).not.toThrow();
  });
});

describe("SseEventBus — once", () => {
  let bus: SseEventBus;

  beforeEach(() => {
    bus = new SseEventBus();
  });

  it("fires exactly once even when published multiple times", () => {
    const listener = vi.fn();
    bus.once("tasks", listener);
    bus.publish("tasks", { data: 1 });
    bus.publish("tasks", { data: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ data: 1 });
  });
});

describe("SseEventBus — listenerCount / clear", () => {
  let bus: SseEventBus;

  beforeEach(() => {
    bus = new SseEventBus();
  });

  it("returns correct listener count", () => {
    expect(bus.listenerCount("tasks")).toBe(0);
    const l1 = vi.fn();
    const l2 = vi.fn();
    bus.subscribe("tasks", l1);
    bus.subscribe("tasks", l2);
    expect(bus.listenerCount("tasks")).toBe(2);
  });

  it("clear() removes all listeners from a channel", () => {
    const l1 = vi.fn();
    bus.subscribe("tasks", l1);
    bus.subscribe("tasks", vi.fn());
    bus.clear("tasks");
    expect(bus.listenerCount("tasks")).toBe(0);
    bus.publish("tasks", { data: "x" });
    expect(l1).not.toHaveBeenCalled();
  });

  it("clearAll() removes listeners from all channels", () => {
    bus.subscribe("tasks", vi.fn());
    bus.subscribe("signals", vi.fn());
    bus.clearAll();
    expect(bus.listenerCount("tasks")).toBe(0);
    expect(bus.listenerCount("signals")).toBe(0);
  });

  it("clear() on unknown channel is a no-op", () => {
    expect(() => bus.clear("nonexistent")).not.toThrow();
  });
});

// ── Convenience publishers ────────────────────────────────────────────────────

describe("publishTaskUpdate", () => {
  beforeEach(() => {
    globalBus.clearAll();
  });

  it("delivers to 'tasks' channel", () => {
    const listener = vi.fn();
    globalBus.subscribe("tasks", listener);

    const payload: TaskUpdatePayload = {
      taskId: "t1",
      status: "running",
      updatedAt: new Date().toISOString(),
    };
    publishTaskUpdate(payload);

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0]?.[0] as SseEvent<TaskUpdatePayload>;
    expect(event.event).toBe("task.update");
    expect(event.data.taskId).toBe("t1");
    expect(event.data.status).toBe("running");
  });

  it("also delivers to task-specific channel 'tasks:<taskId>'", () => {
    const specific = vi.fn();
    globalBus.subscribe("tasks:t1", specific);

    publishTaskUpdate({ taskId: "t1", status: "completed", updatedAt: "" });

    expect(specific).toHaveBeenCalledTimes(1);
  });

  it("does not deliver to unrelated task channel", () => {
    const other = vi.fn();
    globalBus.subscribe("tasks:t2", other);

    publishTaskUpdate({ taskId: "t1", status: "failed", updatedAt: "" });

    expect(other).not.toHaveBeenCalled();
  });

  it("event id contains the taskId", () => {
    const listener = vi.fn();
    globalBus.subscribe("tasks", listener);
    publishTaskUpdate({ taskId: "abc-999", status: "queued", updatedAt: "" });

    const event = listener.mock.calls[0]?.[0] as SseEvent;
    expect(event.id).toContain("abc-999");
  });
});

describe("publishSignal", () => {
  beforeEach(() => {
    globalBus.clearAll();
  });

  it("delivers signal.new event to 'signals' channel", () => {
    const listener = vi.fn();
    globalBus.subscribe("signals", listener);

    const payload: SignalPayload = {
      signalId: "s1",
      signalType: "anomaly",
      summary: "Something happened",
      priority: "high",
      createdAt: new Date().toISOString(),
    };
    publishSignal(payload);

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0]?.[0] as SseEvent<SignalPayload>;
    expect(event.event).toBe("signal.new");
    expect(event.data.signalId).toBe("s1");
  });

  it("event id contains the signalId", () => {
    const listener = vi.fn();
    globalBus.subscribe("signals", listener);
    publishSignal({
      signalId: "sig-42",
      signalType: "x",
      summary: "y",
      priority: "low",
      createdAt: "",
    });

    const event = listener.mock.calls[0]?.[0] as SseEvent;
    expect(event.id).toBe("signal-sig-42");
  });
});

describe("publishVerdict", () => {
  beforeEach(() => {
    globalBus.clearAll();
  });

  it("delivers verdict.new event to 'verdicts' channel", () => {
    const listener = vi.fn();
    globalBus.subscribe("verdicts", listener);

    const payload: VerdictPayload = {
      verdictId: "v1",
      outcome: "approved",
      rationale: "All good",
      createdAt: new Date().toISOString(),
    };
    publishVerdict(payload);

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0]?.[0] as SseEvent<VerdictPayload>;
    expect(event.event).toBe("verdict.new");
    expect(event.data.outcome).toBe("approved");
  });

  it("also publishes to verdicts:<taskId> when taskId present", () => {
    const specific = vi.fn();
    globalBus.subscribe("verdicts:task-99", specific);

    publishVerdict({
      verdictId: "v2",
      taskId: "task-99",
      outcome: "rejected",
      rationale: "x",
      createdAt: "",
    });

    expect(specific).toHaveBeenCalledTimes(1);
  });

  it("does NOT publish to verdicts:<taskId> when taskId absent", () => {
    const listener = vi.fn();
    globalBus.subscribe("verdicts:anything", listener);

    publishVerdict({ verdictId: "v3", outcome: "deferred", rationale: "y", createdAt: "" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("event id contains the verdictId", () => {
    const listener = vi.fn();
    globalBus.subscribe("verdicts", listener);
    publishVerdict({ verdictId: "vrd-7", outcome: "escalated", rationale: "", createdAt: "" });

    const event = listener.mock.calls[0]?.[0] as SseEvent;
    expect(event.id).toBe("verdict-vrd-7");
  });
});

// ── dispatchAgentEvent ──────────────────────────────────────────────────────────

describe("dispatchAgentEvent", () => {
  it("fans an agent event to both agent:<stream> and the firehose", () => {
    const scoped = vi.fn();
    const firehose = vi.fn();
    globalBus.subscribe("agent:s1", scoped);
    globalBus.subscribe("agent", firehose);

    dispatchAgentEvent({ stream: "s1", type: "step", data: { stepIndex: 0 }, ts: 123 });

    expect(scoped).toHaveBeenCalledTimes(1);
    expect(firehose).toHaveBeenCalledTimes(1);
    const event = scoped.mock.calls[0]?.[0] as SseEvent<{ stream: string; stepIndex: number }>;
    expect(event.event).toBe("agent.step");
    expect(event.id).toBe("agent-s1-123");
    expect(event.data).toEqual({ stream: "s1", stepIndex: 0 });
  });

  it("does not deliver to a different stream", () => {
    const other = vi.fn();
    globalBus.subscribe("agent:other", other);
    dispatchAgentEvent({ stream: "s2", type: "status", data: { status: "completed" }, ts: 1 });
    expect(other).not.toHaveBeenCalled();
  });
});
