// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";

import { RuntimeDiagnosticAPI } from "../src/diagnostic-api.js";

function stubInspector(overrides: Record<string, unknown> = {}) {
  const fn = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    getHealth: fn({ status: "healthy" }),
    getMetrics: fn({ counters: {} }),
    getSnapshots: fn({ timestamp: "t" }),
    getTasks: fn([]),
    getEvents: fn([]),
    getQueues: fn({ activeJobsCount: 0 }),
    getServices: fn([]),
    getMCPSummary: fn({}),
    getMCPServers: fn([]),
    getMCPTools: fn([]),
    getMCPExecutions: fn([]),
    getGovernanceInfo: fn({}),
    getApprovalsList: fn([]),
    getPlansList: fn([]),
    getGuardrailsInfo: fn({}),
    getBrowserMetrics: () => ({}),
    getScrapingMetrics: () => ({}),
    getSandboxMetrics: () => ({}),
    getEnvironmentsList: () => [],
    getWorkflowsList: () => [{ id: "wf" }],
    getWorkflowExecution: () => ({ id: "exec" }),
    getWorkflowReplays: () => [],
    getWorkflowTemplates: () => [],
    getWorkflowTelemetryStats: () => ({}),
    getMemoryStats: fn({ count: 1 }),
    getMemoryEntries: fn([]),
    getAgentCapabilities: fn([]),
    getAgentMessages: fn([]),
    getCircuitBreakerState: () => ({ available: true }),
    ...overrides,
  };
}

describe("RuntimeDiagnosticAPI", () => {
  it("rejects non-GET methods", async () => {
    const api = new RuntimeDiagnosticAPI(stubInspector() as never);
    await expect(api.handle("POST", "/health")).rejects.toThrow(/Unsupported method/);
  });

  it("routes core runtime endpoints", async () => {
    const inspector = stubInspector();
    const api = new RuntimeDiagnosticAPI(inspector as never);
    expect(await api.handle("GET", "/health")).toMatchObject({ status: "healthy" });
    expect(await api.handle("GET", "/metrics")).toHaveProperty("counters");
    expect(await api.handle("GET", "/runtime/state")).toHaveProperty("timestamp");
    expect(await api.handle("GET", "/runtime/tasks")).toEqual([]);
    expect(await api.handle("GET", "/runtime/events")).toEqual([]);
    expect(await api.handle("GET", "/runtime/queues")).toHaveProperty("activeJobsCount");
    expect(await api.handle("GET", "/runtime/services")).toEqual([]);
    expect(await api.handle("GET", "/runtime/snapshots")).toHaveProperty("timestamp");
  });

  it("routes MCP, governance, and environment endpoints", async () => {
    const inspector = stubInspector();
    const api = new RuntimeDiagnosticAPI(inspector as never);
    await api.handle("GET", "/runtime/mcp");
    await api.handle("GET", "/runtime/mcp/servers");
    await api.handle("GET", "/runtime/mcp/tools");
    await api.handle("GET", "/runtime/mcp/executions");
    await api.handle("GET", "/runtime/governance");
    await api.handle("GET", "/runtime/approvals");
    await api.handle("GET", "/runtime/plans");
    await api.handle("GET", "/runtime/guardrails");
    expect(inspector.getMCPSummary).toHaveBeenCalled();
    expect(await api.handle("GET", "/runtime/browser")).toEqual({});
    expect(await api.handle("GET", "/runtime/scraping")).toEqual({});
    expect(await api.handle("GET", "/runtime/sandbox")).toEqual({});
    expect(await api.handle("GET", "/runtime/environments")).toEqual([]);
  });

  it("routes workflow, memory, agent, and circuit endpoints", async () => {
    const inspector = stubInspector();
    const api = new RuntimeDiagnosticAPI(inspector as never);
    expect(await api.handle("GET", "/runtime/workflows")).toHaveLength(1);
    expect(await api.handle("GET", "/runtime/memory")).toHaveProperty("count");
    expect(await api.handle("GET", "/runtime/memory/entries")).toEqual([]);
    expect(await api.handle("GET", "/runtime/agents")).toEqual([]);
    expect(await api.handle("GET", "/runtime/agents/messages")).toEqual([]);
    expect(await api.handle("GET", "/runtime/circuits")).toMatchObject({ available: true });
    expect(inspector.getMemoryEntries).toHaveBeenCalledWith({ limit: 50 });
  });

  it("resolves dynamic workflow sub-routes", async () => {
    const inspector = stubInspector();
    const api = new RuntimeDiagnosticAPI(inspector as never);
    expect(await api.handle("GET", "/runtime/workflows/exec-1")).toMatchObject({ id: "exec" });
    expect(await api.handle("GET", "/runtime/workflows/exec-1/replays")).toEqual([]);
    expect(await api.handle("GET", "/runtime/workflows/exec-1/templates")).toEqual([]);
    expect(await api.handle("GET", "/runtime/workflows/exec-1/telemetry")).toEqual({});
  });

  it("throws for unknown paths and missing inspector methods degrade", async () => {
    const api = new RuntimeDiagnosticAPI(stubInspector() as never);
    await expect(api.handle("GET", "/nope")).rejects.toThrow(/Not Found/);
    const bare = {} as never;
    const sparseApi = new RuntimeDiagnosticAPI(bare);
    expect(await sparseApi.handle("GET", "/runtime/mcp")).toBeUndefined();
    expect(await sparseApi.handle("GET", "/runtime/memory")).toEqual({ available: false });
    expect(await sparseApi.handle("GET", "/runtime/circuits")).toEqual({ available: false });
  });
});
