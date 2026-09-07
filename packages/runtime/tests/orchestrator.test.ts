// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";

import { ConductorOrchestrator } from "../src/orchestrator.js";
import { TaskRouter } from "../src/task-router.js";
import type { Task } from "../src/task-router.js";
import type { IRuntimeManager } from "../src/runtime-manager.js";
import type { IEventStore } from "../src/interfaces/persistence.interface.js";
import type { IQueueBackend } from "../src/interfaces/queue.interface.js";

interface Harness {
  orchestrator: ConductorOrchestrator;
  runtimeManager: { getActiveServices: ReturnType<typeof vi.fn> };
  eventBus: { publish: ReturnType<typeof vi.fn> };
  taskRouter: { route: ReturnType<typeof vi.fn>; replayEvent: ReturnType<typeof vi.fn> };
  eventStore?: { replayEvents: ReturnType<typeof vi.fn> };
  queue: {
    push: ReturnType<typeof vi.fn>;
    getQueueLength: ReturnType<typeof vi.fn>;
    pop: ReturnType<typeof vi.fn>;
  };
  executor: { runLoop: ReturnType<typeof vi.fn> };
  metrics: { increment: ReturnType<typeof vi.fn>; recordTiming: ReturnType<typeof vi.fn>; recordGauge: ReturnType<typeof vi.fn> };
  tracer: { startSpan: ReturnType<typeof vi.fn>; endSpan: ReturnType<typeof vi.fn> };
  planningEngine: { generatePlan: ReturnType<typeof vi.fn> };
  governanceEngine: {
    evaluatePlan: ReturnType<typeof vi.fn>;
    evaluateTask: ReturnType<typeof vi.fn>;
  };
  approvalWorkflow: { createRequest: ReturnType<typeof vi.fn> };
  inspector: { recordPlan: ReturnType<typeof vi.fn> };
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

function makeHarness(opts: { withoutEngines?: boolean } = {}): Harness {
  const runtimeManager = { getActiveServices: vi.fn().mockResolvedValue(["api"]) };
  const eventBus = { publish: vi.fn() };
  const taskRouter = { route: vi.fn().mockResolvedValue(undefined), replayEvent: vi.fn().mockResolvedValue(undefined) };
  const eventStore = { replayEvents: vi.fn().mockResolvedValue([]) };
  const queue = {
    push: vi.fn().mockResolvedValue(undefined),
    getQueueLength: vi.fn().mockResolvedValue(2),
    pop: vi.fn().mockResolvedValue(undefined),
  };
  const executor = { runLoop: vi.fn().mockResolvedValue(3) };
  const metrics = { increment: vi.fn(), recordTiming: vi.fn(), recordGauge: vi.fn(), getMetrics: vi.fn() };
  const tracer = { startSpan: vi.fn().mockReturnValue({ spanId: "s1" }), endSpan: vi.fn() };
  const planningEngine = { generatePlan: vi.fn() };
  const governanceEngine = { evaluatePlan: vi.fn(), evaluateTask: vi.fn() };
  const approvalWorkflow = { createRequest: vi.fn() };
  const inspector = { recordPlan: vi.fn() };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const orchestrator = ConductorOrchestrator.create({
    runtimeManager: runtimeManager as unknown as IRuntimeManager,
    eventBus: eventBus as never,
    taskRouter: taskRouter as unknown as TaskRouter,
    agentRegistry: { register: vi.fn(), getAgent: vi.fn() } as never,
    eventStore: eventStore as unknown as IEventStore,
    logger: logger as never,
    queue: queue as unknown as IQueueBackend,
    executor: executor as never,
    metrics: metrics as never,
    tracer: tracer as never,
    ...(opts.withoutEngines
      ? {}
      : {
          planningEngine: planningEngine as never,
          governanceEngine: governanceEngine as never,
          approvalWorkflow: approvalWorkflow as never,
          inspector,
        }),
  });

  return {
    orchestrator,
    runtimeManager,
    eventBus,
    taskRouter,
    eventStore,
    queue,
    executor,
    metrics,
    tracer,
    planningEngine,
    governanceEngine,
    approvalWorkflow,
    inspector,
    logger,
  };
}

function task(id: string, deps: string[] = []): Task {
  return { id, title: `Task ${id}`, description: "d", priority: "medium", status: "pending", dependencies: deps };
}

describe("ConductorOrchestrator.start", () => {
  it("replays historical events and returns active services", async () => {
    const h = makeHarness();
    h.eventStore!.replayEvents.mockResolvedValue([{ event: "task_routed", payload: {}, timestamp: new Date() }]);
    const services = await h.orchestrator.start();
    expect(services).toEqual(["api"]);
    expect(h.taskRouter.replayEvent).toHaveBeenCalledOnce();
    expect(h.metrics.recordTiming).toHaveBeenCalledWith("replay.duration", expect.any(Number));
    expect(h.metrics.recordGauge).toHaveBeenCalledWith("orchestrator.uptime", 1);
    expect(h.tracer.endSpan).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "success" }));
  });

  it("skips replay without an event store", async () => {
    const h = makeHarness();
    h.eventStore = undefined;
    void h;
    const h2 = makeHarness();
    // sabotage eventStore by removing it through direct construction path
    const noStore = ConductorOrchestrator.create({
      runtimeManager: h2.runtimeManager as never,
      eventBus: h2.eventBus as never,
      taskRouter: h2.taskRouter as unknown as TaskRouter,
      agentRegistry: {} as never,
    });
    const services = await noStore.start();
    expect(services).toEqual(["api"]);
    expect(h2.taskRouter.replayEvent).not.toHaveBeenCalled();
  });
});

describe("ConductorOrchestrator.submitAndExecuteTasks", () => {
  it("routes tasks in topological order and pushes them onto the queue", async () => {
    const h = makeHarness();
    const processed = await h.orchestrator.submitAndExecuteTasks(
      [task("b", ["a"]), task("a")],
      5,
      1,
    );
    expect(processed).toBe(3); // executor runLoop result
    // topological order: a before b
    expect(h.taskRouter.route.mock.calls.map((c) => (c[0] as Task).id)).toEqual(["a", "b"]);
    expect(h.queue.push).toHaveBeenCalledTimes(2);
    const payload = h.queue.push.mock.calls[0][0];
    expect(payload).toMatchObject({ id: "a", priority: "medium", retries: 0, maxRetries: 3 });
    expect(payload.payload.type).toBeTruthy();
    expect(h.executor.runLoop).toHaveBeenCalledWith(5, 1);
    expect(h.metrics.increment).toHaveBeenCalledWith("task.submitted");
  });

  it("does not run the executor when none is registered", async () => {
    const h = makeHarness();
    const noExec = ConductorOrchestrator.create({
      runtimeManager: h.runtimeManager as never,
      eventBus: h.eventBus as never,
      taskRouter: h.taskRouter as unknown as TaskRouter,
      agentRegistry: {} as never,
      queue: h.queue as never,
    });
    const processed = await noExec.submitAndExecuteTasks([task("a")]);
    expect(processed).toBe(0);
    expect(h.queue.push).toHaveBeenCalledTimes(1);
  });
});

describe("ConductorOrchestrator cognitive objectives", () => {
  const synth = (id: string, extra: Record<string, unknown> = {}) => ({
    taskId: id,
    action: "create_s3_bucket",
    arguments: { bucket: id },
    dependencies: [],
    priority: "high" as const,
    ...extra,
  });

  it("throws when planning/governance engines are missing", async () => {
    const h = makeHarness({ withoutEngines: true });
    await expect(h.orchestrator.submitCognitiveObjective("deploy")).rejects.toThrow(/not registered/);
  });

  it("records plans and blocks disallowed plans", async () => {
    const h = makeHarness();
    h.planningEngine.generatePlan.mockResolvedValue({ planId: "p1", objective: "o", synthesisResults: [], timestamp: new Date() });
    h.governanceEngine.evaluatePlan.mockResolvedValue({ allowed: false, reason: "over budget" });
    const result = await h.orchestrator.submitCognitiveObjective("big deploy");
    expect(result).toEqual({ planId: "p1", allowed: false, reason: "over budget", processed: 0 });
    expect(h.inspector.recordPlan).toHaveBeenCalledOnce();
  });

  it("blocks when an individual task is disallowed", async () => {
    const h = makeHarness();
    h.planningEngine.generatePlan.mockResolvedValue({
      planId: "p2",
      objective: "o",
      synthesisResults: [synth("t1")],
      timestamp: new Date(),
    });
    h.governanceEngine.evaluatePlan.mockResolvedValue({ allowed: true });
    h.governanceEngine.evaluateTask.mockResolvedValue({ allowed: false, requiresApproval: false, reason: "dangerous" });
    const result = await h.orchestrator.submitCognitiveObjective("risky");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("dangerous");
    expect(h.approvalWorkflow.createRequest).not.toHaveBeenCalled();
    expect(h.queue.push).not.toHaveBeenCalled();
  });

  it("creates approval requests and skips dispatch when approvals block", async () => {
    const h = makeHarness();
    h.planningEngine.generatePlan.mockResolvedValue({
      planId: "p3",
      objective: "o",
      synthesisResults: [synth("t1"), synth("t2", { requiresApproval: false })],
      timestamp: new Date(),
    });
    h.governanceEngine.evaluatePlan.mockResolvedValue({ allowed: true });
    h.governanceEngine.evaluateTask
      .mockResolvedValueOnce({ allowed: true, requiresApproval: true })
      .mockResolvedValueOnce({ allowed: true, requiresApproval: false });
    const result = await h.orchestrator.submitCognitiveObjective("governed deploy");
    expect(h.approvalWorkflow.createRequest).toHaveBeenCalledTimes(1);
    expect(h.approvalWorkflow.createRequest).toHaveBeenCalledWith("t1");
    expect(result).toEqual({ planId: "p3", allowed: true, processed: 0 });
    expect(h.queue.push).not.toHaveBeenCalled();
  });

  it("executes the full plan when nothing requires approval", async () => {
    const h = makeHarness();
    h.planningEngine.generatePlan.mockResolvedValue({
      planId: "p4",
      objective: "o",
      synthesisResults: [synth("t1"), synth("t2", { dependencies: ["t1"] })],
      timestamp: new Date(),
    });
    h.governanceEngine.evaluatePlan.mockResolvedValue({ allowed: true });
    h.governanceEngine.evaluateTask.mockResolvedValue({ allowed: true, requiresApproval: false });
    const result = await h.orchestrator.submitCognitiveObjective("go", { maxIterations: 7, idleDelayMs: 2 });
    expect(result.allowed).toBe(true);
    expect(result.processed).toBe(3);
    expect(h.executor.runLoop).toHaveBeenCalledWith(7, 2);
    expect(h.queue.push).toHaveBeenCalledTimes(2);
  });

  it("submitAndRun drains once and forwards run options", async () => {
    const h = makeHarness();
    h.planningEngine.generatePlan.mockResolvedValue({
      planId: "p5",
      objective: "o",
      synthesisResults: [synth("t1")],
      timestamp: new Date(),
    });
    h.governanceEngine.evaluatePlan.mockResolvedValue({ allowed: true });
    h.governanceEngine.evaluateTask.mockResolvedValue({ allowed: true, requiresApproval: false });
    const result = await h.orchestrator.submitAndRun("one shot", { maxIterations: 2 });
    expect(result.processed).toBe(3);
  });
});

describe("ConductorOrchestrator.run and queue access", () => {
  it("throws without an executor", async () => {
    const h = makeHarness();
    const noExec = ConductorOrchestrator.create({
      runtimeManager: h.runtimeManager as never,
      eventBus: h.eventBus as never,
      taskRouter: h.taskRouter as unknown as TaskRouter,
      agentRegistry: {} as never,
    });
    await expect(noExec.run()).rejects.toThrow(/no TaskExecutor/);
  });

  it("drains via the executor run loop", async () => {
    const h = makeHarness();
    expect(await h.orchestrator.run(50, 5)).toBe(3);
    expect(h.executor.runLoop).toHaveBeenCalledWith(50, 5);
  });

  it("exposes the queue backend", () => {
    const h = makeHarness();
    expect(h.orchestrator.getQueue()).toBe(h.queue);
  });
});
