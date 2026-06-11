import { LocalEventBus } from "../orchestration/event-bus";
import { TaskRouter, Task } from "../orchestration/task-router";
import { LocalAgentRegistry, Agent } from "../orchestration/agent-registry";
import { RuntimeManager } from "../orchestration/runtime-manager";
import { YAMLConfigLoader } from "../runtime/config-loader";
import { GhostStackOrchestrator } from "../runtime/orchestrator";
import { FileEventStore } from "../orchestration/persistence-manager";
import { StructuredLogger } from "../orchestration/logger";
import * as path from "path";
import * as fs from "fs";

describe("Event Bus & Task Routing Pipeline", () => {
  it("should process and route agent tasks with dependency resolution", async () => {
    const bus = new LocalEventBus();
    const router = new TaskRouter(bus);

    const task: Task = {
      id: "task-01",
      title: "Scrape Data",
      description: "Extract news feed",
      priority: "high",
      status: "pending",
      dependencies: []
    };

    let emittedEvent: Task | null = null;
    bus.subscribe("task_routed", (data) => {
      emittedEvent = data as Task;
    });

    const resolved = await router.route(task);
    expect(resolved.status).toBe("routed");
    expect(emittedEvent).not.toBeNull();
    expect(emittedEvent!.id).toBe("task-01");
  });
});

describe("Agent Registry Operations", () => {
  it("should register, retrieve, and filter active agents dynamically", async () => {
    const registry = new LocalAgentRegistry();

    const agent: Agent = {
      id: "agent-01",
      name: "ghoststack-agent",
      type: "refactor",
      capabilities: ["ts-edit", "lint"],
      status: "idle"
    };

    await registry.register(agent);

    const retrieved = await registry.getAgent("agent-01");
    expect(retrieved).toEqual(agent);

    const listers = await registry.findAgentsByCapability("ts-edit");
    expect(listers.length).toBe(1);
    expect(listers[0].name).toBe("ghoststack-agent");

    await registry.deregister("agent-01");
    const gone = await registry.getAgent("agent-01");
    expect(gone).toBeUndefined();
  });
});

describe("GhostStack Orchestrator Crash Recovery & Core Integration", () => {
  const testDir = path.join(__dirname, "../temp-integration-db");
  const eventLogPath = path.join(testDir, "integration_events.jsonl");

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should boot, record task routes persistently, and reconstruct queue after cold restart", async () => {
    const loader = new YAMLConfigLoader({
      portsPath: path.join(__dirname, "../runtime/ports.yaml"),
      servicesPath: path.join(__dirname, "../runtime/services.yaml"),
      healthchecksPath: path.join(__dirname, "../runtime/healthchecks.yaml"),
      runtimePath: path.join(__dirname, "../runtime/ghoststack.runtime.yaml")
    });

    const rm = new RuntimeManager(loader);
    const bus = new LocalEventBus();
    const eventStore = new FileEventStore(eventLogPath);
    const router = new TaskRouter(bus, eventStore);
    const registry = new LocalAgentRegistry();
    const logger = new StructuredLogger();

    // 1. Initial boot and route a task
    const orchestrator1 = new GhostStackOrchestrator(rm, bus, router, registry, eventStore, logger);
    await orchestrator1.start();

    const task: Task = {
      id: "task-durable-01",
      title: "Write Specs",
      description: "Generate kit layout",
      priority: "medium",
      status: "pending",
      dependencies: []
    };

    await router.route(task);
    expect(router.getQueue().length).toBe(1);

    // 2. Simulate Cold Crash / Restart by creating a completely fresh memory context
    const freshBus = new LocalEventBus();
    // Use the exact same persistent event store log
    const sameEventStore = new FileEventStore(eventLogPath);
    const freshRouter = new TaskRouter(freshBus, sameEventStore);
    const freshRegistry = new LocalAgentRegistry();

    const orchestrator2 = new GhostStackOrchestrator(rm, freshBus, freshRouter, freshRegistry, sameEventStore, logger);

    // Assert queue is empty before boot recovery
    expect(freshRouter.getQueue().length).toBe(0);

    // 3. Boot new orchestrator and verify recovery
    await orchestrator2.start();

    // Queue should be restored from historical log!
    const restoredQueue = freshRouter.getQueue();
    expect(restoredQueue.length).toBe(1);
    expect(restoredQueue[0].id).toBe("task-durable-01");
    expect(restoredQueue[0].title).toBe("Write Specs");
  });
});
