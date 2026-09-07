// SPDX-License-Identifier: Apache-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveFlociEndpoint: vi.fn(() => "http://localhost:4566"),
  runFederationE2e: vi.fn(),
}));

vi.mock("../src/floci-client.js", () => ({
  resolveFlociEndpoint: mocks.resolveFlociEndpoint,
  probeFlociHealth: vi.fn(),
}));

vi.mock("../src/e2e-federation.js", () => ({
  runFederationE2e: mocks.runFederationE2e,
}));

import { registerConductorMcpBridge, GHOSTSTACK_MCP_TOOLS } from "../src/conductor-mcp-bridge.js";
import { WorkflowRegistry } from "../src/workflow-engine.js";
import { RuntimeGraph } from "../src/runtime-graph.js";

let root: string;
let workspacesDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-bridge-"));
  workspacesDir = path.join(root, "workspaces");
  fs.mkdirSync(workspacesDir, { recursive: true });
  mocks.runFederationE2e.mockResolvedValue({ passed: true, checks: 1 });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function fakeCtx(overrides: Record<string, unknown> = {}) {
  const registry = new WorkflowRegistry();
  registry.registerWorkflow({
    id: "wf-a",
    name: "Workflow A",
    description: "d",
    tasks: [{ id: "t1", title: "T", description: "", priority: "high", status: "pending", dependencies: [] }],
  });
  const ctx = {
    repoRoot: root,
    sandbox: { root, workspacesDir, dataDir: root, specsDir: path.join(root, "specs"), tempDir: root, backupsDir: root },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    flociAdapter: {
      probeHealth: vi.fn().mockResolvedValue({ reachable: true, latencyMs: 2 }),
      executeAction: vi.fn().mockResolvedValue({ success: true, action: "create_s3_bucket" }),
    },
    inspector: {
      getHealth: vi.fn().mockResolvedValue({ status: "healthy", servicesCount: 2 }),
      getSnapshots: vi.fn().mockResolvedValue({ timestamp: "now", services: [] }),
    },
    registry,
    workflowEngine: {
      executeWorkflow: vi.fn().mockResolvedValue({ id: "exec-1", status: "succeeded" }),
      cancelExecution: vi.fn().mockReturnValue({ id: "exec-1", status: "failed" }),
      resumeExecution: vi.fn().mockResolvedValue({ id: "exec-1", status: "succeeded" }),
      listCheckpoints: vi.fn().mockReturnValue([{ executionId: "cp1" }]),
      replayExecution: vi.fn().mockResolvedValue({ id: "exec-1", status: "succeeded" }),
    },
    memoryStore: {
      getStats: vi.fn().mockResolvedValue({ count: 1 }),
      store: vi.fn().mockResolvedValue("mem-1"),
      query: vi.fn().mockResolvedValue({ total: 0, entries: [] }),
    },
    agentBus: {
      getCapabilities: vi.fn().mockResolvedValue([{ agentId: "a1" }]),
      send: vi.fn().mockResolvedValue("msg-1"),
      findAgents: vi.fn().mockResolvedValue([{ id: "a1" }]),
    },
    circuitBreaker: {
      getState: vi.fn().mockReturnValue("closed"),
      getMetrics: vi.fn().mockReturnValue({ failures: 0 }),
      reset: vi.fn(),
    },
    diagnosticEnricher: {
      getRichDiagnostics: vi.fn().mockReturnValue({ healthy: true }),
      getHealthHistory: vi.fn().mockReturnValue({
        getStats: () => ({ checks: 1 }),
        getLatest: () => ({ status: "ok" }),
        getHistory: () => [{ status: "ok" }],
      }),
    },
    runtimeGraph: new RuntimeGraph(),
    eventBus: { publish: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
  return ctx;
}

function stubFetch(ok: boolean, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    }),
  );
}

async function getTransport(ctx: ReturnType<typeof fakeCtx>) {
  const { registry, runtime } = await registerConductorMcpBridge(ctx as never);
  const server = await registry.getServer("conductor");
  return { transport: server!.transport, runtime };
}

async function callTool(
  transport: { send: (m: unknown) => Promise<unknown> },
  name: string,
  args: Record<string, unknown> = {},
) {
  const out = (await transport.send({
    method: "tools/call",
    params: { name, arguments: args },
  })) as { content: { text: string }[] };
  return JSON.parse(out.content[0].text) as Record<string, unknown>;
}

/** Bridge errors are returned as tool error content, never thrown. */
async function expectToolError(
  transport: { send: (m: unknown) => Promise<unknown> },
  name: string,
  args: Record<string, unknown>,
  contains: RegExp | string,
): Promise<void> {
  const out = (await transport.send({
    method: "tools/call",
    params: { name, arguments: args },
  })) as { content: { text: string }[] };
  const parsed = JSON.parse(out.content[0].text) as { error?: string };
  expect(parsed.error).toBeDefined();
  expect(parsed.error).toMatch(contains);
}

describe("conductor MCP tool registry", () => {
  it("registers the conductor server with all tool names", async () => {
    const { registry, runtime } = await registerConductorMcpBridge(fakeCtx() as never);
    const server = await registry.getServer("conductor");
    expect(server?.info.name).toBe("conductor");
    expect(server?.info.tools).toHaveLength(GHOSTSTACK_MCP_TOOLS.length);
    expect(GHOSTSTACK_MCP_TOOLS).toContain("conductor_health");
    expect((await runtime.getMetrics()).invocations).toBe(0);
  });

  it("rejects messages before connect and answers non-tool methods", async () => {
    const { transport } = await getTransport(fakeCtx());
    await expect(transport.send({ method: "tools/call" })).rejects.toThrow(/not connected/);
    await transport.connect();
    const out = (await transport.send({ method: "ping" })) as { content: { text: string }[] };
    expect(out.content[0].text).toContain('"ok":true');
    await transport.disconnect();
    await expect(transport.send({ method: "x" })).rejects.toThrow(/not connected/);
  });
});

describe("conductor MCP tools", () => {
  async function make() {
    const ctx = fakeCtx();
    const { transport } = await getTransport(ctx);
    await transport.connect();
    return { ctx, transport: transport as { send: (m: unknown) => Promise<unknown> } };
  }

  it("reports health and runtime snapshots", async () => {
    const { transport } = await make();
    const health = await callTool(transport, "conductor_health");
    expect(health).toHaveProperty("orchestrator");
    expect((health as { floci: { reachable: boolean } }).floci.reachable).toBe(true);
    const snap = await callTool(transport, "conductor_runtime_snapshot");
    expect(snap).toHaveProperty("timestamp");
  });

  it("lists and executes workflows", async () => {
    const { transport } = await make();
    const list = await callTool(transport, "conductor_list_workflows");
    expect(list).toEqual([{ id: "wf-a", name: "Workflow A", tasks: 1 }]);
    const exec = await callTool(transport, "conductor_execute_workflow", { workflowId: "wf-a", executionId: "exec-1" });
    expect(exec.status).toBe("succeeded");
    await expectToolError(transport, "conductor_execute_workflow", {}, /workflowId is required/);
  });

  it("cancels, resumes, replays and lists checkpoints", async () => {
    const { transport } = await make();
    const cancelled = await callTool(transport, "conductor_workflow_cancel", { executionId: "exec-1" });
    expect(cancelled.cancelled).toBe(true);
    const resumed = await callTool(transport, "conductor_workflow_resume", { executionId: "exec-1" });
    expect(resumed.resumed).toBe(true);
    const replayed = await callTool(transport, "conductor_workflow_replay", { executionId: "exec-1" });
    expect(replayed.replayed).toBe(true);
    const cps = await callTool(transport, "conductor_workflow_checkpoints");
    expect(cps.count).toBe(1);
    await expectToolError(transport, "conductor_workflow_cancel", {}, /executionId is required/);
  });

  it("runs the federation e2e suite", async () => {
    const { transport } = await make();
    const out = await callTool(transport, "conductor_run_e2e", { strict: false });
    expect(out.passed).toBe(true);
    expect(mocks.runFederationE2e).toHaveBeenCalledWith(expect.anything(), { strict: false, cleanup: true });
  });

  it("executes floci actions through the adapter", async () => {
    const { transport } = await make();
    const out = await callTool(transport, "conductor_floci_execute", { action: "create_s3_bucket", bucketName: "b" });
    expect(out.success).toBe(true);
    await expectToolError(transport, "conductor_floci_execute", {}, /action is required/);
  });

  it("writes, reads, and lists sandbox files", async () => {
    const { transport } = await make();
    const written = await callTool(transport, "conductor_sandbox_write", {
      path: "notes/a.txt",
      content: "hello sandbox",
    });
    expect(written).toHaveProperty("written");
    expect(fs.existsSync(path.join(workspacesDir, "notes", "a.txt"))).toBe(true);
    const read = await callTool(transport, "conductor_sandbox_read", { path: "notes/a.txt" });
    expect(read.content).toBe("hello sandbox");
    const list = await callTool(transport, "conductor_sandbox_list", { path: "notes" });
    expect(list.entries).toContainEqual({ name: "a.txt", type: "file" });
    await expectToolError(transport, "conductor_sandbox_read", {}, /path is required/);
  });

  it("blocks sandbox path traversal", async () => {
    const { transport } = await make();
    await expectToolError(
      transport,
      "conductor_sandbox_read",
      { path: "../../outside" },
      /descends from|outside|Path/i,
    );
  });

  it("reports memory stats, stores entries, and queries", async () => {
    const { transport } = await make();
    const stats = await callTool(transport, "conductor_memory_stats");
    expect(stats).toHaveProperty("count");
    const stored = await callTool(transport, "conductor_memory_store", {
      key: "k1",
      value: { a: 1 },
      type: "knowledge",
    });
    expect(stored.id).toBe("mem-1");
    const queried = await callTool(transport, "conductor_memory_query", { keyPrefix: "k" });
    expect(queried).toHaveProperty("total");
  });

  it("lists capabilities, sends agent messages, and finds agents", async () => {
    const { transport } = await make();
    const caps = await callTool(transport, "conductor_agent_capabilities");
    expect(caps).toHaveLength(1);
    const sent = await callTool(transport, "conductor_agent_send", {
      from: "a1",
      to: "a2",
      type: "broadcast",
      subject: "hi",
      body: { x: 1 },
    });
    expect(sent.messageId).toBe("msg-1");
    const found = await callTool(transport, "conductor_agent_find", { action: "code_edit" });
    expect(found).toHaveLength(1);
  });

  it("reads and resets circuit breaker state", async () => {
    const { transport } = await make();
    const state = await callTool(transport, "conductor_circuit_state");
    expect(state.state).toBe("closed");
    const reset = await callTool(transport, "conductor_circuit_reset");
    expect(reset.reset).toBe(true);
  });

  it("returns diagnostics and health history", async () => {
    const { transport } = await make();
    const diag = await callTool(transport, "conductor_diagnostics");
    expect(diag.healthy).toBe(true);
    const history = await callTool(transport, "conductor_health_history");
    expect(history.stats.checks).toBe(1);
    expect(history.history).toHaveLength(1);
  });

  it("returns the runtime graph snapshot and handles a missing graph", async () => {
    const { transport } = await make();
    const snap = await callTool(transport, "conductor_runtime_graph");
    expect(snap).toBeDefined();
    const noGraph = fakeCtx({ runtimeGraph: undefined });
    const { transport: t2 } = await getTransport(noGraph);
    await t2.connect();
    const out = (await t2.send({
      method: "tools/call",
      params: { name: "conductor_runtime_graph", arguments: {} },
    })) as { content: { text: string }[] };
    expect(JSON.parse(out.content[0].text)).toMatchObject({ available: false });
  });

  it("dispatches extended floci actions and validates the action list", async () => {
    stubFetch(true, { ok: true });
    const { transport } = await make();
    const out = await callTool(transport, "conductor_floci_extended", {
      action: "create_s3_bucket",
      bucketName: "b",
    });
    expect(out.ok).toBe(true);
    await expectToolError(transport, "conductor_floci_extended", { action: "bogus" }, /Unknown extended Floci action/);
  });

  it("reports unknown tools as errors", async () => {
    const { transport } = await make();
    const out = (await transport.send({
      method: "tools/call",
      params: { name: "conductor_unknown_tool", arguments: {} },
    })) as { content: { text: string }[] };
    expect(JSON.parse(out.content[0].text).error).toContain("Unknown Conductor MCP tool");
  });
});
