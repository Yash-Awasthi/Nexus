// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";

import { RuntimeInspector } from "../src/runtime-inspector.js";
import type { RuntimeInspector as Insp } from "../src/runtime-inspector.js";

interface Stubs {
  metrics: { getMetrics: ReturnType<typeof vi.fn> };
  queue: {
    getDeadLetterQueue: ReturnType<typeof vi.fn>;
    getQueueLength: ReturnType<typeof vi.fn>;
    getActiveJobs: ReturnType<typeof vi.fn>;
  };
  discovery: { listServices: ReturnType<typeof vi.fn> };
  eventStore: { replayEvents: ReturnType<typeof vi.fn> };
  mcpRuntime?: { getMetrics: ReturnType<typeof vi.fn>; getExecutionsLog: ReturnType<typeof vi.fn> };
  mcpRegistry?: { listServers: ReturnType<typeof vi.fn> };
  governance?: {
    getConstraints: ReturnType<typeof vi.fn>;
    getPolicies: ReturnType<typeof vi.fn>;
    getGuardrails: ReturnType<typeof vi.fn>;
  };
  approval?: { listRecords: ReturnType<typeof vi.fn> };
  browserTelemetry?: {
    browserSessionsActive: number;
    navigationHistory: string[];
    totalBytesWritten: number;
  };
  scrapingTelemetry?: { totalBytesFetched: number; navigationHistory: string[] };
  fsSandbox?: { getWriteLog: ReturnType<typeof vi.fn> };
  envs?: { name: string; capabilities: string[] }[];
  registry?: { listWorkflows: ReturnType<typeof vi.fn>; listTemplates: ReturnType<typeof vi.fn> };
  workflowTelemetry?: { getExecutionHistory: ReturnType<typeof vi.fn> };
  memoryStore?: {
    getStats: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  };
  agentBus?: { getCapabilities: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
  circuitBreaker?: { getMetrics: ReturnType<typeof vi.fn> };
}

function makeDirect(opts: Stubs = {}): { inspector: Insp; stubs: Stubs } {
  const stubs: Stubs = {
    metrics: opts.metrics ?? { getMetrics: vi.fn().mockResolvedValue({ counters: {} }) },
    queue: opts.queue ?? {
      getDeadLetterQueue: vi.fn().mockResolvedValue([]),
      getQueueLength: vi.fn().mockResolvedValue(3),
      getActiveJobs: vi.fn().mockResolvedValue([{ id: "j1", priority: "high", retries: 1 }]),
    },
    discovery: opts.discovery ?? { listServices: vi.fn().mockResolvedValue([]) },
    eventStore: opts.eventStore ?? { replayEvents: vi.fn().mockResolvedValue([]) },
    ...opts,
  };
  const inspector = new RuntimeInspector(
    stubs.metrics as never,
    stubs.queue as never,
    stubs.discovery as never,
    stubs.eventStore as never,
    stubs.mcpRuntime as never,
    stubs.mcpRegistry as never,
    stubs.governance as never,
    stubs.approval as never,
    stubs.browserTelemetry as never,
    stubs.scrapingTelemetry as never,
    stubs.fsSandbox as never,
    stubs.envs as never,
    stubs.registry as never,
    stubs.workflowTelemetry as never,
    undefined,
    stubs.memoryStore as never,
    stubs.agentBus as never,
    stubs.circuitBreaker as never,
  );
  return { inspector, stubs };
}

function makeInspector(opts: Stubs = {}): { inspector: Insp; stubs: Stubs } {
  const stubs: Stubs = {
    metrics: opts.metrics ?? { getMetrics: vi.fn().mockResolvedValue({ counters: {} }) },
    queue: opts.queue ?? {
      getDeadLetterQueue: vi.fn().mockResolvedValue([]),
      getQueueLength: vi.fn().mockResolvedValue(3),
      getActiveJobs: vi.fn().mockResolvedValue([{ id: "j1", priority: "high", retries: 1 }]),
    },
    discovery: opts.discovery ?? { listServices: vi.fn().mockResolvedValue([]) },
    eventStore: opts.eventStore ?? { replayEvents: vi.fn().mockResolvedValue([]) },
    ...opts,
  };
  const inspector = RuntimeInspector.fromContext({
    metrics: stubs.metrics as never,
    queue: stubs.queue as never,
    discovery: stubs.discovery as never,
    eventStore: stubs.eventStore as never,
    governanceEngine: stubs.governance as never,
    approval: stubs.approval as never,
    browserTelemetry: stubs.browserTelemetry as never,
    scrapingTelemetry: stubs.scrapingTelemetry as never,
    registry: stubs.registry as never,
    workflowTelemetry: stubs.workflowTelemetry as never,
    workflowEngine: undefined,
    memoryStore: stubs.memoryStore as never,
    agentBus: stubs.agentBus as never,
    circuitBreaker: stubs.circuitBreaker as never,
  });
  return { inspector, stubs };
}

const wfDef = (id: string) => ({
  id,
  name: `wf ${id}`,
  description: "d",
  tasks: [{ id: "t" }],
});

const wfHistory = [
  { id: "e1", workflowId: "wf1", status: "succeeded", taskResults: {}, startedAt: new Date() },
  { id: "e2", workflowId: "wf1", status: "failed", taskResults: {}, startedAt: new Date() },
  { id: "e3", workflowId: "wf1", status: "pending", taskResults: {}, startedAt: new Date() },
  {
    id: "e4-replay",
    workflowId: "wf1",
    status: "succeeded",
    taskResults: {},
    startedAt: new Date(),
  },
];

describe("RuntimeInspector", () => {
  it("reports healthy when all services are healthy", async () => {
    const { inspector, stubs } = makeInspector();
    stubs.discovery!.listServices.mockResolvedValue([
      { name: "s1", status: "healthy", lastCheck: new Date(), details: { port: 80, type: "http" } },
    ]);
    const health = (await inspector.getHealth()) as {
      status: string;
      uptimeSeconds: number;
      servicesCount: number;
    };
    expect(health.status).toBe("healthy");
    expect(health.servicesCount).toBe(1);
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("reports degraded when any service is unhealthy", async () => {
    const { inspector, stubs } = makeInspector();
    stubs.discovery!.listServices.mockResolvedValue([
      { name: "s1", status: "unhealthy", lastCheck: new Date() },
    ]);
    expect(((await inspector.getHealth()) as { status: string }).status).toBe("degraded");
  });

  it("reports healthy with zero services", async () => {
    const { inspector } = makeInspector();
    expect(((await inspector.getHealth()) as { status: string }).status).toBe("healthy");
  });

  it("returns raw metrics", async () => {
    const { inspector } = makeInspector();
    await expect(inspector.getMetrics()).resolves.toEqual({ counters: {} });
  });

  it("builds task snapshots from replayed events", async () => {
    const { inspector, stubs } = makeInspector();
    stubs.eventStore!.replayEvents.mockResolvedValue([
      {
        event: "task_routed",
        payload: { id: "t1", status: "routed", priority: "high", dependencies: ["t0"], retries: 0 },
      },
      { event: "execution_succeeded", payload: { taskId: "t1", durationMs: 42 } },
      { event: "task_queued", payload: { id: "t2", status: "queued", priority: "low" } },
      {
        event: "execution_failed",
        payload: { taskId: "t2", attempts: 3 },
      },
      { event: "unrelated", payload: {} },
    ]);
    const tasks = (await inspector.getTasks()) as Array<Record<string, unknown>>;
    const t1 = tasks.find((t) => t.id === "t1")!;
    expect(t1.status).toBe("succeeded");
    expect(t1.executionTimeMs).toBe(42);
    const t2 = tasks.find((t) => t.id === "t2")!;
    expect(t2.retries).toBe(3);
  });

  it("maps events into snapshots", async () => {
    const { inspector, stubs } = makeInspector();
    stubs.eventStore!.replayEvents.mockResolvedValue([
      { event: "task_routed", timestamp: new Date("2026-01-01"), payload: {} },
    ]);
    const events = (await inspector.getEvents()) as Array<{ event: string; timestamp: Date }>;
    expect(events[0].event).toBe("task_routed");
    expect(events[0].timestamp).toBeInstanceOf(Date);
  });

  it("summarizes queues with DLQ and active jobs", async () => {
    const { inspector, stubs } = makeInspector();
    stubs.queue!.getDeadLetterQueue.mockResolvedValue([
      { id: "dead", priority: "low", retries: 9 },
    ]);
    const snap = (await inspector.getQueues()) as {
      activeJobsCount: number;
      deadLetterJobsCount: number;
      jobs: unknown[];
    };
    expect(snap.activeJobsCount).toBe(3);
    expect(snap.deadLetterJobsCount).toBe(1);
    expect(snap.jobs).toHaveLength(1);
  });

  it("maps discovered services to summary fields", async () => {
    const { inspector, stubs } = makeInspector();
    stubs.discovery!.listServices.mockResolvedValue([
      {
        name: "api",
        status: "healthy",
        lastCheck: new Date(),
        details: { port: 3000, type: "http" },
      },
    ]);
    const services = (await inspector.getServices()) as Array<Record<string, unknown>>;
    expect(services[0]).toMatchObject({ name: "api", port: 3000, type: "http" });
  });

  it("exposes MCP summary/servers/tools/executions when wired via the constructor", async () => {
    const { inspector } = makeDirect({
      mcpRuntime: {
        getMetrics: vi.fn().mockResolvedValue({ calls: 1 }),
        getExecutionsLog: vi.fn().mockResolvedValue([{ id: "x" }]),
      },
      mcpRegistry: {
        listServers: vi.fn().mockResolvedValue([
          { name: "srv-a", tools: ["tool1", "tool2"] },
          { name: "srv-b", tools: ["tool3"] },
        ]),
      },
    });
    expect((await inspector.getMCPSummary()) as object).toMatchObject({
      serversCount: 2,
      executionsCount: 1,
    });
    expect(await inspector.getMCPServers()).toHaveLength(2);
    expect(await inspector.getMCPTools()).toEqual(["srv-a:tool1", "srv-a:tool2", "srv-b:tool3"]);
    expect(await inspector.getMCPExecutions()).toHaveLength(1);
  });

  it("returns empty MCP data when not wired", async () => {
    const { inspector } = makeInspector();
    expect((await inspector.getMCPSummary()) as object).toMatchObject({
      serversCount: 0,
      executionsCount: 0,
    });
    expect(await inspector.getMCPServers()).toEqual([]);
    expect(await inspector.getMCPTools()).toEqual([]);
    expect(await inspector.getMCPExecutions()).toEqual([]);
  });

  it("surfaces governance info and approvals", async () => {
    const { inspector, stubs } = makeInspector({
      governance: {
        getConstraints: vi.fn().mockReturnValue([{ name: "budget" }]),
        getPolicies: vi.fn().mockReturnValue([{ name: "danger" }]),
        getGuardrails: vi.fn().mockReturnValue([{ name: "loop-guard" }]),
      },
      approval: { listRecords: vi.fn().mockResolvedValue([{ approvalId: "a1" }]) },
    });
    const gov = (await inspector.getGovernanceInfo()) as Record<string, string[]>;
    expect(gov.constraints).toEqual(["budget"]);
    expect(gov.policies).toEqual(["danger"]);
    expect(gov.guardrails).toEqual(["loop-guard"]);
    expect((await inspector.getGuardrailsInfo()) as { activeGuardrailsCount: number }).toEqual({
      activeGuardrailsCount: 1,
      stormThreshold: 5,
    });
    expect(await inspector.getApprovalsList()).toHaveLength(1);
    void stubs;
  });

  it("defaults governance info when the engine is absent", async () => {
    const { inspector } = makeInspector();
    expect(await inspector.getGovernanceInfo()).toEqual({});
    expect(await inspector.getGuardrailsInfo()).toEqual({});
    expect(await inspector.getApprovalsList()).toEqual([]);
  });

  it("reports plan log and records plans", async () => {
    const { inspector } = makeInspector();
    expect(await inspector.getPlansList()).toEqual([]);
    const plan = { planId: "p1", objective: "o", synthesisResults: [], timestamp: new Date() };
    inspector.recordPlan(plan);
    expect(await inspector.getPlansList()).toEqual([plan]);
  });

  it("reads environment telemetry metrics", () => {
    const { inspector } = makeDirect({
      browserTelemetry: {
        browserSessionsActive: 2,
        navigationHistory: ["https://a"],
        totalBytesWritten: 99,
      },
      scrapingTelemetry: { totalBytesFetched: 10, navigationHistory: ["https://b"] },
      fsSandbox: { getWriteLog: vi.fn().mockReturnValue([{ op: "write" }]) },
      envs: [{ name: "sandbox", capabilities: ["fs"] }],
    });
    expect(inspector.getBrowserMetrics()).toMatchObject({
      activeSessions: 2,
      totalBytesWritten: 99,
    });
    expect(inspector.getScrapingMetrics()).toMatchObject({ totalBytesFetched: 10 });
    expect((inspector.getSandboxMetrics() as { writeLog: unknown[] }).writeLog).toHaveLength(1);
    expect(inspector.getEnvironmentsList()).toEqual([{ name: "sandbox", capabilities: ["fs"] }]);
    expect((inspector as unknown as { browserTelemetry: unknown }).browserTelemetry).toBeDefined();
  });

  it("defaults environment metrics when absent", () => {
    const { inspector } = makeInspector();
    expect(inspector.getBrowserMetrics()).toEqual({});
    expect(inspector.getScrapingMetrics()).toEqual({});
    expect(inspector.getSandboxMetrics()).toEqual({});
    expect(inspector.getEnvironmentsList()).toEqual([]);
  });

  it("lists workflows, templates, executions, replays and telemetry stats", () => {
    const { inspector, stubs } = makeInspector({
      registry: {
        listWorkflows: vi.fn().mockReturnValue([wfDef("wf1"), wfDef("wf2")]),
        listTemplates: vi
          .fn()
          .mockReturnValue([{ templateId: "tpl", name: "T", description: "d" }]),
      },
      workflowTelemetry: { getExecutionHistory: vi.fn().mockReturnValue(wfHistory) },
    });
    expect(inspector.getWorkflowsList()).toHaveLength(2);
    expect((inspector.getWorkflowExecution("e1") as { id: string }).id).toBe("e1");
    expect(inspector.getWorkflowExecution("ghost")).toBeNull();
    expect(inspector.getWorkflowExecutionHistory()).toHaveLength(4);
    expect(inspector.getWorkflowReplays()).toHaveLength(1);
    expect(inspector.getWorkflowTemplates()).toEqual([
      { templateId: "tpl", name: "T", description: "d" },
    ]);
    expect(inspector.getWorkflowTelemetryStats()).toMatchObject({
      totalExecutions: 4,
      succeededCount: 2,
      failedCount: 1,
      pendingCount: 1,
    });
    void stubs;
  });

  it("defaults workflow inspection when deps are absent", () => {
    const { inspector } = makeInspector();
    expect(inspector.getWorkflowsList()).toEqual([]);
    expect(inspector.getWorkflowExecution("x")).toBeNull();
    expect(inspector.getWorkflowExecutionHistory()).toEqual([]);
    expect(inspector.getWorkflowReplays()).toEqual([]);
    expect(inspector.getWorkflowTemplates()).toEqual([]);
    expect(inspector.getWorkflowTelemetryStats()).toEqual({});
  });

  it("reports memory stats and entries", async () => {
    const entry = {
      id: "m1",
      type: "observation",
      key: "k",
      agentId: "agent",
      workflowId: "wf",
      tags: ["t"],
      timestamp: new Date("2026-01-01"),
    };
    const { inspector, stubs } = makeInspector({
      memoryStore: {
        getStats: vi.fn().mockResolvedValue({
          count: 1,
          oldest: new Date("2026-01-01"),
          newest: new Date("2026-01-02"),
        }),
        query: vi.fn().mockResolvedValue({ entries: [entry] }),
      },
    });
    const stats = (await inspector.getMemoryStats()) as { available: boolean; oldest: string };
    expect(stats.available).toBe(true);
    expect(stats.oldest).toBe("2026-01-01T00:00:00.000Z");
    const entries = (await inspector.getMemoryEntries({
      types: ["observation"],
      keyPrefix: "k",
      limit: 5,
    })) as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe("k");
    expect(stubs.memoryStore!.query).toHaveBeenCalledWith(
      expect.objectContaining({ keyPrefix: "k", limit: 5 }),
    );
  });

  it("reports memory unavailable when the store is absent", async () => {
    const { inspector } = makeInspector();
    expect(await inspector.getMemoryStats()).toEqual({ available: false });
    expect(await inspector.getMemoryEntries()).toEqual([]);
  });

  it("reports agent capabilities and messages", async () => {
    const { inspector, stubs } = makeInspector({
      agentBus: {
        getCapabilities: vi
          .fn()
          .mockResolvedValue([{ agentId: "a1", capabilities: [], status: "idle" }]),
        getMessages: vi.fn().mockResolvedValue([{ id: "msg1" }]),
      },
    });
    expect(await inspector.getAgentCapabilities()).toHaveLength(1);
    expect(await inspector.getAgentMessages({ limit: 1 })).toHaveLength(1);
    expect(stubs.agentBus!.getMessages).toHaveBeenCalledWith({ limit: 1 });
    const bare = makeInspector();
    expect(await bare.inspector.getAgentCapabilities()).toEqual([]);
    expect(await bare.inspector.getAgentMessages()).toEqual([]);
  });

  it("reports circuit breaker state", () => {
    const { inspector } = makeInspector({
      circuitBreaker: {
        getMetrics: vi.fn().mockReturnValue({ state: "closed", failures: 2 }),
      },
    });
    expect(inspector.getCircuitBreakerState()).toMatchObject({ available: true, state: "closed" });
    const bare = makeInspector();
    expect(bare.inspector.getCircuitBreakerState()).toEqual({ available: false });
  });

  it("produces a full snapshot bundle", async () => {
    const { inspector, stubs } = makeInspector();
    stubs.discovery!.listServices.mockResolvedValue([]);
    const snap = (await inspector.getSnapshots()) as Record<string, unknown>;
    expect(snap).toHaveProperty("timestamp");
    expect(snap).toHaveProperty("health");
    expect(snap).toHaveProperty("metrics");
    expect(snap).toHaveProperty("queues");
    expect(snap).toHaveProperty("services");
    expect(snap).toHaveProperty("events");
    expect(snap).toHaveProperty("tasks");
    expect(snap).toHaveProperty("mcp");
    expect(snap).toHaveProperty("governance");
    expect(snap).toHaveProperty("memory");
    expect(snap).toHaveProperty("circuitBreaker");
  });
});
