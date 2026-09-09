// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentBus, TaskDelegationAgent, type AgentMessage } from "../src/agent-bus.js";
import { EventBus } from "../src/event-bus.js";
import type { ILogger } from "../src/interfaces/logger.interface.js";

const logger: ILogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function makeBus(opts?: { maxMessages?: number }) {
  return new AgentBus(new EventBus(), undefined, undefined, logger, opts);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentBus.send", () => {
  it("stores and publishes a message with an id and timestamp", async () => {
    const bus = makeBus();
    const id = await bus.send({
      from: "a",
      to: "b",
      type: "request",
      subject: "ping",
      body: { n: 1 },
    });
    expect(id).toMatch(/^msg-/);
    const msgs = await bus.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ from: "a", to: "b", subject: "ping", body: { n: 1 } });
    expect(msgs[0]?.id).toBe(id);
  });

  it("persists to the event store and memory store when wired", async () => {
    const eventStore = { saveEvent: vi.fn(async () => {}) };
    const memoryStore = { store: vi.fn(async () => "mem-1") };
    const bus = new AgentBus(new EventBus(), eventStore as never, memoryStore as never, logger);
    await bus.send({ from: "a", type: "broadcast", subject: "note", body: "x" });
    expect(eventStore.saveEvent).toHaveBeenCalledWith(
      "agent_message",
      expect.objectContaining({ subject: "note" }),
    );
    expect(memoryStore.store).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "observation",
        tags: ["agent-bus", "from:a", "type:broadcast"],
        agentId: "a",
      }),
    );
  });

  it("routes to a registered handler for the recipient and logs handler failures", async () => {
    const bus = makeBus();
    const handled: string[] = [];
    bus.registerHandler("agent-b", async (msg) => {
      handled.push(msg.body as string);
    });
    await bus.send({ from: "a", to: "agent-b", type: "request", subject: "s", body: "hello" });
    expect(handled).toEqual(["hello"]);

    // Handler throwing must not reject send — error is logged.
    bus.registerHandler("agent-c", async () => {
      throw new Error("handler exploded");
    });
    await bus.send({ from: "a", to: "agent-c", type: "request", subject: "s", body: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("[agent-bus] Handler for agent-c failed"),
      expect.any(Error),
    );

    bus.unregisterHandler("agent-b");
    bus.unregisterHandler("agent-c");
  });

  it("caps the ring buffer at maxMessages", async () => {
    const bus = makeBus({ maxMessages: 3 });
    for (let i = 0; i < 5; i++) {
      await bus.send({ from: "a", type: "broadcast", subject: `m${i}`, body: i });
    }
    const msgs = await bus.getMessages();
    expect(msgs).toHaveLength(3);
    expect(msgs.map((m) => m.subject)).toEqual(["m2", "m3", "m4"]);
  });

  it("evicts expired TTL messages on read and honors since/limit options", async () => {
    vi.useFakeTimers();
    const bus = makeBus();
    await bus.send({ from: "a", type: "broadcast", subject: "stale", body: 1, ttlMs: 1000 });
    await bus.send({ from: "a", type: "broadcast", subject: "fresh", body: 2, ttlMs: 100_000 });
    vi.advanceTimersByTime(1500);
    const msgs = await bus.getMessages();
    expect(msgs.map((m) => m.subject)).toEqual(["fresh"]);
    expect(await bus.getMessages({ limit: 1 })).toHaveLength(1);
    expect(await bus.getMessages({ since: new Date() })).toHaveLength(0);
  });
});

describe("AgentBus capabilities", () => {
  it("registers/unregisters and finds agents by action, skipping offline ones", async () => {
    const bus = makeBus();
    await bus.registerCapability("worker-1", ["math", "write"], { region: "us" });
    await bus.registerCapability("worker-2", ["write"]);

    expect((await bus.getCapabilities()).map((c) => c.agentId).sort()).toEqual([
      "worker-1",
      "worker-2",
    ]);

    // getCapabilities returns live references — mark worker-2 offline (register
    // always starts agents idle; offline arises from external state changes).
    const caps = await bus.getCapabilities();
    const w2 = caps.find((c) => c.agentId === "worker-2");
    if (w2) w2.status = "offline";

    const writers = await bus.findAgents("write");
    expect(writers.map((c) => c.agentId)).toEqual(["worker-1"]);

    const mathers = await bus.findAgents("math");
    expect(mathers).toHaveLength(1);

    await bus.unregisterCapability("worker-1");
    expect(await bus.findAgents("math")).toEqual([]);
    expect(await bus.findAgents("write")).toEqual([]); // worker-2 is offline
  });
});

describe("AgentBus.delegate", () => {
  it("returns an immediate error when no agent has the capability", async () => {
    const bus = makeBus();
    const result = await bus.delegate({
      id: "r1",
      fromAgent: "a",
      targetCapability: "nothing",
      task: { x: 1 },
      timeoutMs: 100,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No available agents with capability: nothing");
  });

  it("delivers a delegation and resolves the correlated result", async () => {
    const bus = makeBus();
    await bus.registerCapability("worker-1", ["translate"]);
    // The worker answers any delegation it receives.
    bus.registerHandler("worker-1", async (msg: AgentMessage) => {
      await bus.send({
        from: "worker-1",
        to: msg.from,
        type: "result",
        subject: `result:${msg.subject}`,
        body: { translated: "hola" },
        correlationId: msg.correlationId,
      });
    });

    const result = await bus.delegate({
      id: "r2",
      fromAgent: "a",
      targetCapability: "translate",
      task: { text: "hello" },
      timeoutMs: 500,
    });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ translated: "hola" });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // The worker returns to idle after the delegation.
    const caps = await bus.getCapabilities();
    expect(caps.find((c) => c.agentId === "worker-1")?.status).toBe("idle");
  });

  it("times out when the target agent never responds and returns the agent to idle", async () => {
    const bus = makeBus();
    await bus.registerCapability("silent", ["sleep"]);
    const result = await bus.delegate({
      id: "r3",
      fromAgent: "a",
      targetCapability: "sleep",
      task: {},
      timeoutMs: 25,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Delegation timeout after 25ms");
    expect((await bus.getCapabilities()).find((c) => c.agentId === "silent")?.status).toBe("idle");
  });
});

describe("TaskDelegationAgent", () => {
  it("answers a delegation by finding a worker and sending a result", async () => {
    const bus = makeBus();
    await bus.registerCapability("researcher", ["research"]);
    void new TaskDelegationAgent(bus as never);

    await bus.send({
      from: "planner",
      to: "task-delegator",
      type: "delegation",
      subject: "research:climate",
      body: { action: "research", payload: { topic: "climate" } },
      correlationId: "corr-1",
    });

    const results = (await bus.getMessages()).filter((m) => m.correlationId === "corr-1");
    const result = results.find((m) => m.type === "result");
    expect(result).toBeDefined();
    expect(result?.body).toMatchObject({ delegated: true, target: "researcher" });
  });

  it("returns an error message when no worker has the action", async () => {
    const bus = makeBus();
    void new TaskDelegationAgent(bus as never);

    await bus.send({
      from: "planner",
      to: "task-delegator",
      type: "delegation",
      subject: "research:nothing",
      body: { action: "missing-action", payload: {} },
      correlationId: "corr-2",
    });

    const messages = (await bus.getMessages()).filter((m) => m.correlationId === "corr-2");
    const error = messages.find((m) => m.type === "error");
    expect(error).toBeDefined();
    expect(String(error?.body)).toContain("No agent found for action: missing-action");
  });
});
