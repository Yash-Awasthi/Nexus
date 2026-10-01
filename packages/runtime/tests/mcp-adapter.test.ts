// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";

import { MCPRuntime } from "../src/mcp-adapter.js";
import type { IMCPTask } from "../src/interfaces/mcp.interface.js";
import type { IMCPTransport } from "../src/interfaces/mcp.interface.js";
import { MCPServerRegistry } from "../src/mcp-registry.js";

function task(overrides: Partial<IMCPTask> = {}): IMCPTask {
  return {
    id: "m1",
    serverName: "svc",
    toolName: "read_file",
    arguments: { path: "/tmp/x" },
    correlationId: "c1",
    timeoutMs: 5000,
    ...overrides,
  };
}

function transport(
  opts: { send?: () => Promise<unknown>; connectFail?: boolean } = {},
): IMCPTransport {
  return {
    connect: vi.fn(async () => {
      if (opts.connectFail) throw new Error("connect refused");
    }),
    disconnect: vi.fn(async () => {}),
    send:
      opts.send ??
      (async () => ({
        content: [{ type: "text", text: JSON.stringify({ ok: 1 }) }],
      })),
  };
}

const metrics = {
  increment: vi.fn(),
  recordTiming: vi.fn(),
  recordGauge: vi.fn(),
  getMetrics: vi.fn(),
};

describe("MCPRuntime", () => {
  it("blocks blocklisted tools before dispatch", async () => {
    const runtime = new MCPRuntime(new MCPServerRegistry(), metrics as never);
    const res = await runtime.executeTask(task({ toolName: "shell_execute" }));
    expect(res.success).toBe(false);
    expect(res.error).toContain("blocked by safety policy");
    expect((await runtime.getMetrics()).failures).toBe(1);
  });

  it("rejects tasks for unknown servers", async () => {
    const runtime = new MCPRuntime(new MCPServerRegistry(), metrics as never);
    const res = await runtime.executeTask(task({ serverName: "missing" }));
    expect(res.success).toBe(false);
    expect(res.error).toContain("Server not found");
  });

  it("invokes tools through the transport and extracts text content", async () => {
    const registry = new MCPServerRegistry();
    const send = vi.fn(async () => ({
      content: [{ type: "text", text: "the answer" }],
    }));
    const t = transport({ send });
    await registry.registerServer(
      {
        name: "svc",
        transportType: "stdio",
        endpoint: "x",
        status: "active",
        tools: ["read_file"],
      },
      t,
    );
    const tracer = { startSpan: vi.fn().mockReturnValue({ spanId: "sp" }), endSpan: vi.fn() };
    const runtime = new MCPRuntime(registry, metrics as never, tracer as never);
    const res = await runtime.executeTask(task());
    expect(res.success).toBe(true);
    expect(res.output).toBe("the answer");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "tools/call",
        params: { name: "read_file", arguments: { path: "/tmp/x" } },
      }),
    );
    expect(tracer.endSpan).toHaveBeenCalledWith(
      "sp",
      expect.objectContaining({ status: "success" }),
    );
  });

  it("keeps the raw result when there is no text content", async () => {
    const registry = new MCPServerRegistry();
    await registry.registerServer(
      { name: "svc", transportType: "stdio", endpoint: "x", status: "active", tools: [] },
      transport({ send: async () => ({ binary: true }) }),
    );
    const runtime = new MCPRuntime(registry);
    const res = await runtime.executeTask(task());
    expect(res.success).toBe(true);
    expect(res.output).toEqual({ binary: true });
  });

  it("surfaces transport failures and records timeouts", async () => {
    const registry = new MCPServerRegistry();
    await registry.registerServer(
      { name: "svc", transportType: "stdio", endpoint: "x", status: "active", tools: [] },
      transport({
        send: async () => {
          throw new Error("tool blew up");
        },
      }),
    );
    const runtime = new MCPRuntime(registry, metrics as never);
    const failed = await runtime.executeTask(task());
    expect(failed.success).toBe(false);
    expect(failed.error).toBe("tool blew up");
    expect((await runtime.getMetrics()).failures).toBe(1);

    // timeout path with a never-resolving transport
    const registry2 = new MCPServerRegistry();
    await registry2.registerServer(
      { name: "svc", transportType: "stdio", endpoint: "x", status: "active", tools: [] },
      transport({ send: () => new Promise(() => {}) }),
    );
    const rt = new MCPRuntime(registry2, metrics as never);
    const timedOut = await rt.executeTask(task({ timeoutMs: 5 }));
    expect(timedOut.success).toBe(false);
    expect(timedOut.error).toContain("Execution Timeout");
    const m = await rt.getMetrics();
    expect(m.timeouts).toBe(1);
    expect(m.avgDurationMs).toBeGreaterThan(0);
    expect(await rt.getExecutionsLog()).toHaveLength(1);
  });

  it("reports connect failures as tool errors", async () => {
    const registry = new MCPServerRegistry();
    await registry.registerServer(
      { name: "svc", transportType: "stdio", endpoint: "x", status: "active", tools: [] },
      transport({ connectFail: true }),
    );
    const runtime = new MCPRuntime(registry);
    const res = await runtime.executeTask(task());
    expect(res.success).toBe(false);
    expect(res.error).toBe("connect refused");
  });

  it("supports a custom blocklist", async () => {
    const runtime = new MCPRuntime(new MCPServerRegistry(), undefined, undefined, ["my_tool"]);
    const res = await runtime.executeTask(task({ toolName: "my_tool" }));
    expect(res.success).toBe(false);
  });
});
