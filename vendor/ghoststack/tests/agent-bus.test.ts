import { AgentBus, TaskDelegationAgent } from "../orchestration/agent-bus";
import { LocalEventBus } from "../orchestration/event-bus";
import { MemoryStore } from "../orchestration/memory-store";

// ─── Mock MemoryStore ────────────────────────────────────────────────
class MockPersistence {
  private data: Record<string, any> = {};
  async saveState(key: string, state: any): Promise<void> {
    this.data[key] = state;
  }
  async getState<T>(key: string): Promise<T | undefined> {
    return this.data[key] as T;
  }
}

describe("AgentBus", () => {
  let bus: AgentBus;
  let eventBus: LocalEventBus;
  let memoryStore: MemoryStore;

  beforeEach(() => {
    eventBus = new LocalEventBus();
    memoryStore = new MemoryStore(new MockPersistence() as any);
    bus = new AgentBus(eventBus, undefined, memoryStore);
  });

  test("send and retrieve messages", async () => {
    const id = await bus.send({
      from: "agent-a",
      type: "broadcast",
      subject: "hello",
      body: { greeting: "Hello from A" }
    });

    expect(id).toBeTruthy();
    expect(id.startsWith("msg-")).toBe(true);

    const messages = await bus.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe("agent-a");
    expect(messages[0].subject).toBe("hello");
    expect(messages[0].body).toEqual({ greeting: "Hello from A" });
  });

  test("directed messages", async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    bus.registerHandler("target-agent", handler);

    await bus.send({
      from: "sender",
      to: "target-agent",
      type: "request",
      subject: "do-something",
      body: { task: "compute" }
    });

    // Wait for async handler
    await new Promise((r) => setTimeout(r, 50));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].to).toBe("target-agent");
    expect(handler.mock.calls[0][0].subject).toBe("do-something");
  });

  test("register and unregister capabilities", async () => {
    await bus.registerCapability("worker-1", [
      "compute",
      "transform",
      "validate"
    ]);

    const caps = await bus.getCapabilities();
    expect(caps).toHaveLength(1);
    expect(caps[0].agentId).toBe("worker-1");
    expect(caps[0].actions).toEqual(["compute", "transform", "validate"]);
    expect(caps[0].status).toBe("idle");

    await bus.unregisterCapability("worker-1");
    const capsAfter = await bus.getCapabilities();
    expect(capsAfter).toHaveLength(0);
  });

  test("find agents by action", async () => {
    await bus.registerCapability("worker-1", ["compute", "validate"]);
    await bus.registerCapability("worker-2", ["transform", "compute"]);
    await bus.registerCapability("worker-3", ["validate"]);

    const computeAgents = await bus.findAgents("compute");
    expect(computeAgents).toHaveLength(2);

    const transformAgents = await bus.findAgents("transform");
    expect(transformAgents).toHaveLength(1);
    expect(transformAgents[0].agentId).toBe("worker-2");

    const parseAgents = await bus.findAgents("parse");
    expect(parseAgents).toHaveLength(0);
  });

  test("delegation with no available agents", async () => {
    const result = await bus.delegate({
      id: "req-1",
      fromAgent: "requester",
      targetCapability: "nonexistent",
      task: { data: "test" },
      timeoutMs: 1000
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No available agents");
  });

  test("delegation succeeds with available agent", async () => {
    await bus.registerCapability("worker-1", ["compute"]);

    // Set up handler on worker-1 to respond to delegations
    bus.registerHandler("worker-1", async (msg) => {
      if (msg.type === "delegation") {
        await bus.send({
          from: "worker-1",
          to: msg.from,
          type: "result",
          subject: "compute",
          body: { computed: 42 },
          correlationId: msg.correlationId
        });
      }
    });

    const result = await bus.delegate({
      id: "req-2",
      fromAgent: "requester",
      targetCapability: "compute",
      task: { x: 21, y: 21 },
      timeoutMs: 5000
    });

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ computed: 42 });
  });

  test("delegation timeout", async () => {
    await bus.registerCapability("slow-worker", ["slow-op"]);

    // Register handler that never responds
    bus.registerHandler("slow-worker", async () => {
      await new Promise((r) => setTimeout(r, 100000));
    });

    const result = await bus.delegate({
      id: "req-3",
      fromAgent: "requester",
      targetCapability: "slow-op",
      task: { data: "timeout test" },
      timeoutMs: 100
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("timeout");
  });

  test("message ordering and limits", async () => {
    for (let i = 0; i < 5; i++) {
      await bus.send({
        from: "agent",
        type: "broadcast",
        subject: `msg-${i}`,
        body: i
      });
    }

    const allMessages = await bus.getMessages();
    expect(allMessages).toHaveLength(5);

    const limitedMessages = await bus.getMessages({ limit: 3 });
    expect(limitedMessages).toHaveLength(3);

    // Wait 5ms to ensure new Date() is strictly after previous messages
    await new Promise((r) => setTimeout(r, 5));
    const since = new Date();
    const newMessages = await bus.getMessages({ since });
    expect(newMessages).toHaveLength(0); // None after since

    // Add a small delay to ensure the new message timestamp > since
    await new Promise((r) => setTimeout(r, 5));
    await bus.send({
      from: "agent",
      type: "broadcast",
      subject: "after-since",
      body: "new"
    });

    const afterSince = await bus.getMessages({ since });
    expect(afterSince).toHaveLength(1);
    expect(afterSince[0].subject).toBe("after-since");
  });

  test("send persists to memory store", async () => {
    await bus.send({
      from: "agent-x",
      type: "broadcast",
      subject: "persist-test",
      body: { persisted: true }
    });

    const memResult = await memoryStore.query({ tags: ["agent-bus"] });
    expect(memResult.total).toBeGreaterThan(0);
    expect(memResult.entries.some((e) => e.key === "agent:msg:persist-test")).toBe(true);
  });
});

describe("TaskDelegationAgent", () => {
  test("delegates to available agents", async () => {
    const eventBus = new LocalEventBus();
    const bus = new AgentBus(eventBus);

    await bus.registerCapability("executor", ["bench-press"]);
    const _delegator = new TaskDelegationAgent(bus);

    const _messageId = await bus.send({
      from: "planner",
      to: "task-delegator",
      type: "delegation",
      subject: "bench-press",
      body: { action: "bench-press", payload: { weight: 225 } },
      correlationId: "corr-1"
    });

    // Wait for handler to process
    await new Promise((r) => setTimeout(r, 100));

    const messages = await bus.getMessages({ limit: 10 });
    // Filter by result/error type to exclude the original delegation request with same correlationId
    const resultMessages = messages.filter((m) => m.correlationId === "corr-1" && m.type === "result");
    expect(resultMessages.length).toBe(1);
    expect(resultMessages[0].type).toBe("result");
    expect(resultMessages[0].body).toHaveProperty("delegated", true);
  });

  test("reports error when no agent found", async () => {
    const eventBus = new LocalEventBus();
    const bus = new AgentBus(eventBus);
    const _delegator = new TaskDelegationAgent(bus);

    const _messageId = await bus.send({
      from: "planner",
      to: "task-delegator",
      type: "delegation",
      subject: "missing-capability",
      body: { action: "fly-to-moon", payload: {} },
      correlationId: "corr-2"
    });

    // Wait for handler to process
    await new Promise((r) => setTimeout(r, 100));

    const messages = await bus.getMessages({ limit: 10 });
    // Filter by error type to exclude the original delegation request with same correlationId
    const errorMessages = messages.filter((m) => m.correlationId === "corr-2" && m.type === "error");
    expect(errorMessages.length).toBe(1);
    expect(errorMessages[0].type).toBe("error");
    expect(errorMessages[0].body).toContain("No agent found");
  });
});
