// SPDX-License-Identifier: Apache-2.0
/**
 * MCP aggregation client — focused tests with canned in-process transports:
 * merging, collision namespacing, call routing, per-server error isolation,
 * and the unknown-tool contract.
 */
import { describe, expect, it } from "vitest";
import { McpClient, McpProxyClient } from "./index.js";
import type { McpToolDefinition, McpTransport } from "./index.js";

interface FakeServerOptions {
  failList?: boolean;
  failCallFor?: string;
  onCall?: (name: string, args: Record<string, unknown>) => void;
}

/** Canned transport: serves fixed tools and records calls. */
function fakeServer(name: string, tools: McpToolDefinition[], opts: FakeServerOptions = {}): {
  transport: McpTransport;
  client: McpClient;
} {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const transport: McpTransport = {
    async send(method, params) {
      if (method === "initialize") {
        return { serverInfo: { name, version: "1.0.0" }, capabilities: { tools: {} }, protocolVersion: "2024-11-05" };
      }
      if (method === "tools/list") {
        if (opts.failList) throw new Error(`${name} is down`);
        return { tools };
      }
      if (method === "tools/call") {
        const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
        const toolName = String(p.name);
        const args = (typeof p.arguments === "object" && p.arguments !== null ? p.arguments : {}) as Record<string, unknown>;
        calls.push({ tool: toolName, args });
        if (opts.failCallFor === toolName) throw new Error(`${toolName} exploded`);
        opts.onCall?.(toolName, args);
        return { content: [{ type: "text", text: `${name}:${toolName}:ok` }] };
      }
      return undefined;
    },
  };
  const client = new McpClient(transport);
  return { transport, client, ...(calls ? { calls } : {}) };
}

const hit = (name: string): McpToolDefinition => ({ name, inputSchema: { type: "object" } });

describe("McpProxyClient", () => {
  it("rejects duplicate server names", () => {
    const { client: a } = fakeServer("a", []);
    const { client: b } = fakeServer("a", []);
    expect(() => new McpProxyClient([{ name: "a", client: a }, { name: "a", client: b }])).toThrow(
      /duplicate server name/,
    );
  });

  it("merges unique tools across servers keeping their original names", async () => {
    const { client: a } = fakeServer("alpha", [hit("weather"), hit("geo")]);
    const { client: b } = fakeServer("beta", [hit("search")]);
    const proxy = new McpProxyClient([
      { name: "alpha", client: a },
      { name: "beta", client: b },
    ]);
    const tools = await proxy.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["geo", "search", "weather"]);
    expect(proxy.failures().every((f) => f.ok)).toBe(true);
  });

  it("namespaces colliding tool names as <server>.<tool>", async () => {
    const { client: a } = fakeServer("alpha", [hit("status")]);
    const { client: b } = fakeServer("beta", [hit("status"), hit("unique-beta")]);
    const proxy = new McpProxyClient([
      { name: "alpha", client: a },
      { name: "beta", client: b },
    ]);
    const tools = await proxy.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "alpha.status",
      "beta.status",
      "unique-beta",
    ]);
  });

  it("routes callTool to the owning server with the original tool name", async () => {
    const callsA: string[] = [];
    const { client: a } = fakeServer("alpha", [hit("status"), hit("weather")], {
      onCall: (n) => callsA.push(n),
    });
    const callsB: string[] = [];
    const { client: b } = fakeServer("beta", [hit("status")], { onCall: (n) => callsB.push(n) });
    const proxy = new McpProxyClient([
      { name: "alpha", client: a },
      { name: "beta", client: b },
    ]);
    await proxy.listTools();

    const res1 = await proxy.callTool("alpha.status", { deep: true });
    expect(res1.text).toBe("alpha:status:ok");
    expect(callsA).toEqual(["status"]);
    expect(callsB).toEqual([]);

    const res2 = await proxy.callTool("beta.status");
    expect(res2.text).toBe("beta:status:ok");
    expect(callsB).toEqual(["status"]);

    // Unique (un-namespaced) names route too.
    const res3 = await proxy.callTool("weather");
    expect(res3.text).toBe("alpha:weather:ok");
  });

  it("isolates a failing server from the sweep and records it", async () => {
    const { client: a } = fakeServer("alpha", [hit("healthy-tool")]);
    const { client: b } = fakeServer("beta", [], { failList: true });
    const proxy = new McpProxyClient([
      { name: "alpha", client: a },
      { name: "beta", client: b },
    ]);
    const tools = await proxy.listTools();
    expect(tools.map((t) => t.name)).toEqual(["healthy-tool"]);
    const failures = proxy.failures();
    expect(failures.find((f) => f.name === "beta")).toMatchObject({ ok: false });
    expect(failures.find((f) => f.name === "beta")!.error).toContain("down");

    // The healthy server still answers.
    const res = await proxy.callTool("healthy-tool");
    expect(res.text).toBe("alpha:healthy-tool:ok");

    // The downed server's tools are simply absent → unknown-tool error.
    await expect(proxy.callTool("beta.nothing")).rejects.toThrow(/unknown tool/);
  });

  it("wraps per-call failures with the owning server's name", async () => {
    const { client: a } = fakeServer("alpha", [hit("boom")], { failCallFor: "boom" });
    const proxy = new McpProxyClient([{ name: "alpha", client: a }]);
    await proxy.listTools();
    await expect(proxy.callTool("boom")).rejects.toThrow(/server "alpha" failed.*exploded/);
  });

  it("rejects unknown tools with a helpful message before listTools", async () => {
    const { client: a } = fakeServer("alpha", [hit("weather")]);
    const proxy = new McpProxyClient([{ name: "alpha", client: a }]);
    await expect(proxy.callTool("weather")).rejects.toThrow(/call listTools\(\) first/);
  });
});