// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ObservationBus,
  ObservationStore,
  AutoObserver,
  ObservingLLMProvider,
  ObservationError,
  makeAutoObserver,
  type ObservationEvent,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from "../src/index.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function mockProvider(response = "ok"): LLMProvider {
  return {
    name: "mock",
    models: ["gpt-4o"],
    async complete(req: LLMRequest): Promise<LLMResponse> {
      return { id: "r1", model: req.model, content: response, provider: "mock", latencyMs: 10 };
    },
  };
}

// ── ObservationBus ────────────────────────────────────────────────────────────

describe("ObservationBus", () => {
  it("emits event to typed listener", async () => {
    const bus = new ObservationBus();
    const received: ObservationEvent[] = [];
    bus.on("llm.request", (e) => received.push(e));
    await bus.emit({
      id: "1",
      type: "llm.request",
      source: "router",
      data: {},
      timestamp: Date.now(),
    });
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("llm.request");
  });

  it("wildcard listener receives all events", async () => {
    const bus = new ObservationBus();
    const received: ObservationEvent[] = [];
    bus.on("*", (e) => received.push(e));
    await bus.emit({
      id: "1",
      type: "tool.call",
      source: "agent",
      data: {},
      timestamp: Date.now(),
    });
    await bus.emit({
      id: "2",
      type: "llm.response",
      source: "router",
      data: {},
      timestamp: Date.now(),
    });
    expect(received).toHaveLength(2);
  });

  it("unsubscribe stops further events", async () => {
    const bus = new ObservationBus();
    const received: ObservationEvent[] = [];
    const unsub = bus.on("agent.start", (e) => received.push(e));
    await bus.emit({ id: "1", type: "agent.start", source: "a", data: {}, timestamp: Date.now() });
    unsub();
    await bus.emit({ id: "2", type: "agent.start", source: "a", data: {}, timestamp: Date.now() });
    expect(received).toHaveLength(1);
  });

  it("listenerCount returns count for type", () => {
    const bus = new ObservationBus();
    bus.on("tool.call", () => {});
    bus.on("tool.call", () => {});
    expect(bus.listenerCount("tool.call")).toBe(2);
    expect(bus.listenerCount("llm.request")).toBe(0);
  });

  it("removeAll removes listeners for a specific type", async () => {
    const bus = new ObservationBus();
    const received: ObservationEvent[] = [];
    bus.on("agent.step", (e) => received.push(e));
    bus.removeAll("agent.step");
    await bus.emit({ id: "1", type: "agent.step", source: "a", data: {}, timestamp: Date.now() });
    expect(received).toHaveLength(0);
  });

  it("removeAll with no arg clears all listeners", async () => {
    const bus = new ObservationBus();
    let count = 0;
    bus.on("llm.request", () => count++);
    bus.on("*", () => count++);
    bus.removeAll();
    await bus.emit({ id: "1", type: "llm.request", source: "x", data: {}, timestamp: Date.now() });
    expect(count).toBe(0);
  });

  it("multiple listeners for same type all receive events", async () => {
    const bus = new ObservationBus();
    let a = 0,
      b = 0;
    bus.on("tool.result", () => a++);
    bus.on("tool.result", () => b++);
    await bus.emit({ id: "1", type: "tool.result", source: "t", data: {}, timestamp: Date.now() });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});

// ── ObservationStore ──────────────────────────────────────────────────────────

describe("ObservationStore", () => {
  let store: ObservationStore;

  beforeEach(() => {
    store = new ObservationStore();
  });

  function makeEvent(
    type: string,
    source = "test",
    tags?: Record<string, string>,
  ): ObservationEvent {
    return { id: Math.random().toString(36), type, source, data: {}, timestamp: Date.now(), tags };
  }

  it("records and returns events", () => {
    store.record(makeEvent("llm.request"));
    expect(store.size()).toBe(1);
  });

  it("query with no filter returns all events", () => {
    store.record(makeEvent("llm.request"));
    store.record(makeEvent("tool.call"));
    expect(store.query()).toHaveLength(2);
  });

  it("query filters by type", () => {
    store.record(makeEvent("llm.request"));
    store.record(makeEvent("tool.call"));
    expect(store.query({ type: "llm.request" })).toHaveLength(1);
  });

  it("query filters by source", () => {
    store.record(makeEvent("llm.request", "router"));
    store.record(makeEvent("llm.request", "agent"));
    expect(store.query({ source: "router" })).toHaveLength(1);
  });

  it("query filters by since timestamp", () => {
    const early = { ...makeEvent("llm.request"), timestamp: 1000 };
    const late = { ...makeEvent("llm.request"), timestamp: 2000 };
    store.record(early);
    store.record(late);
    expect(store.query({ since: 1500 })).toHaveLength(1);
  });

  it("query filters by until timestamp", () => {
    const early = { ...makeEvent("llm.request"), timestamp: 1000 };
    const late = { ...makeEvent("llm.request"), timestamp: 2000 };
    store.record(early);
    store.record(late);
    expect(store.query({ until: 1500 })).toHaveLength(1);
  });

  it("query filters by tags", () => {
    store.record(makeEvent("llm.request", "x", { env: "prod" }));
    store.record(makeEvent("llm.request", "x", { env: "test" }));
    expect(store.query({ tags: { env: "prod" } })).toHaveLength(1);
  });

  it("query respects limit (returns latest N)", () => {
    for (let i = 0; i < 10; i++) store.record(makeEvent("llm.request"));
    expect(store.query({ limit: 3 })).toHaveLength(3);
  });

  it("latest returns most recent event", () => {
    const a = { ...makeEvent("agent.start"), timestamp: 100 };
    const b = { ...makeEvent("agent.start"), timestamp: 200 };
    store.record(a);
    store.record(b);
    expect(store.latest({ type: "agent.start" })!.timestamp).toBe(200);
  });

  it("latest returns undefined when no match", () => {
    expect(store.latest({ type: "agent.end" })).toBeUndefined();
  });

  it("clear empties the store", () => {
    store.record(makeEvent("llm.request"));
    store.clear();
    expect(store.size()).toBe(0);
  });

  it("enforces maxSize with FIFO eviction", () => {
    const small = new ObservationStore(5);
    for (let i = 0; i < 8; i++) small.record({ ...makeEvent("x"), id: String(i) });
    expect(small.size()).toBe(5);
    // The oldest ones are evicted — all remaining should be recent
    const ids = small.all().map((e) => e.id);
    expect(ids).not.toContain("0");
    expect(ids).not.toContain("1");
    expect(ids).not.toContain("2");
  });

  it("all() returns readonly array", () => {
    store.record(makeEvent("x"));
    expect(Array.isArray(store.all())).toBe(true);
  });
});

// ── AutoObserver ──────────────────────────────────────────────────────────────

describe("AutoObserver", () => {
  let obs: AutoObserver;

  beforeEach(() => {
    obs = new AutoObserver();
  });

  it("emit records event in store", async () => {
    await obs.emit("llm.request", "router", { model: "gpt-4o" });
    expect(obs.store.size()).toBe(1);
  });

  it("emitted event has all fields", async () => {
    const event = await obs.emit("tool.call", "agent", { tool: "search" }, { tags: { run: "1" } });
    expect(event.type).toBe("tool.call");
    expect(event.source).toBe("agent");
    expect(event.tags!.run).toBe("1");
    expect(typeof event.id).toBe("string");
    expect(typeof event.timestamp).toBe("number");
  });

  it("on listener receives emitted events", async () => {
    const received: ObservationEvent[] = [];
    obs.on("agent.start", (e) => received.push(e));
    await obs.emit("agent.start", "scheduler", {});
    expect(received).toHaveLength(1);
  });

  it("wildcard on receives all event types", async () => {
    const received: ObservationEvent[] = [];
    obs.on("*", (e) => received.push(e));
    await obs.emit("llm.request", "r", {});
    await obs.emit("tool.call", "a", {});
    expect(received.length).toBeGreaterThanOrEqual(2);
  });

  it("query delegates to store", async () => {
    await obs.emit("memory.read", "store", {});
    await obs.emit("memory.write", "store", {});
    expect(obs.query({ type: "memory.read" })).toHaveLength(1);
  });

  it("latest returns most recent matching event", async () => {
    await obs.emit("llm.response", "r", { latencyMs: 100 });
    await obs.emit("llm.response", "r", { latencyMs: 200 });
    const latest = obs.latest({ type: "llm.response" });
    expect((latest!.data as any).latencyMs).toBe(200);
  });

  it("clear empties the store", async () => {
    await obs.emit("x", "src", {});
    obs.clear();
    expect(obs.store.size()).toBe(0);
  });

  it("custom id is preserved", async () => {
    const event = await obs.emit("agent.end", "a", {}, { id: "my-custom-id" });
    expect(event.id).toBe("my-custom-id");
  });
});

// ── ObservingLLMProvider ──────────────────────────────────────────────────────

describe("ObservingLLMProvider", () => {
  it("emits llm.request and llm.response events", async () => {
    const obs = new AutoObserver();
    const provider = new ObservingLLMProvider(mockProvider("hello"), obs);
    await provider.complete({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(obs.query({ type: "llm.request" })).toHaveLength(1);
    expect(obs.query({ type: "llm.response" })).toHaveLength(1);
  });

  it("passes through the response unchanged", async () => {
    const obs = new AutoObserver();
    const provider = new ObservingLLMProvider(mockProvider("the answer"), obs);
    const res = await provider.complete({
      model: "gpt-4o",
      messages: [{ role: "user", content: "?" }],
    });
    expect(res.content).toBe("the answer");
  });

  it("name wraps inner provider name", () => {
    const obs = new AutoObserver();
    const provider = new ObservingLLMProvider(mockProvider(), obs);
    expect(provider.name).toBe("observed(mock)");
  });

  it("models proxies inner models list", () => {
    const obs = new AutoObserver();
    const provider = new ObservingLLMProvider(mockProvider(), obs);
    expect(provider.models).toEqual(["gpt-4o"]);
  });

  it("emits llm.error when provider throws", async () => {
    const obs = new AutoObserver();
    const failing: LLMProvider = {
      name: "fail",
      models: [],
      async complete() {
        throw new Error("overload");
      },
    };
    const provider = new ObservingLLMProvider(failing, obs);
    await expect(provider.complete({ model: "x", messages: [] })).rejects.toThrow("overload");
    expect(obs.query({ type: "llm.error" })).toHaveLength(1);
  });

  it("uses custom source when provided", async () => {
    const obs = new AutoObserver();
    const provider = new ObservingLLMProvider(mockProvider(), obs, "my-agent");
    await provider.complete({ model: "gpt-4o", messages: [] });
    expect(obs.query({ source: "my-agent" })).toHaveLength(2); // request + response
  });

  it("llm.request data includes messageCount", async () => {
    const obs = new AutoObserver();
    const provider = new ObservingLLMProvider(mockProvider(), obs);
    await provider.complete({
      model: "gpt-4o",
      messages: [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
      ],
    });
    const req = obs.query({ type: "llm.request" })[0];
    expect((req!.data as any).messageCount).toBe(2);
  });
});

// ── ObservationError ──────────────────────────────────────────────────────────

describe("ObservationError", () => {
  it("has correct name, code, and message", () => {
    const e = new ObservationError("store full", "STORE_FULL");
    expect(e.name).toBe("ObservationError");
    expect(e.code).toBe("STORE_FULL");
    expect(e instanceof Error).toBe(true);
  });
});

// ── makeAutoObserver factory ──────────────────────────────────────────────────

describe("makeAutoObserver", () => {
  it("creates a functional AutoObserver", async () => {
    const obs = makeAutoObserver({ maxStoreSize: 100 });
    await obs.emit("agent.start", "test", {});
    expect(obs.store.size()).toBe(1);
  });
});
