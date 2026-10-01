// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  classifyTool,
  createMcpTools,
  RuntimeToolSet,
  type McpToolClient,
  type McpToolInfo,
  type McpToolResult,
} from "../src/index.js";

// A fake MCP client that records calls and makes no outbound requests.
function fakeClient(
  tools: McpToolInfo[],
  onCall?: (name: string, args: Record<string, unknown>) => McpToolResult,
): { client: McpToolClient; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: McpToolClient = {
    async listTools() {
      return tools;
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return onCall?.(name, args) ?? { content: [{ type: "text", text: "ok" }], text: "ok" };
    },
  };
  return { client, calls };
}

const SEARCH: McpToolInfo = {
  name: "search_web",
  description: "Search the web",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

describe("createMcpTools", () => {
  it("bridges each advertised tool, preserving name/description/schema", async () => {
    const { client } = fakeClient([SEARCH]);
    const tools = await createMcpTools(client);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("search_web");
    expect(tools[0].description).toBe("Search the web");
    expect(tools[0].parameters).toEqual(SEARCH.inputSchema);
  });

  it("defaults every bridged tool to requires_permission", async () => {
    const { client } = fakeClient([SEARCH]);
    const [tool] = await createMcpTools(client);
    expect(tool.tier).toBe("requires_permission");
    // Even with an override in RuntimeToolSet, the explicit tier wins over classifyTool.
    expect(classifyTool(tool.name)).toBe("requires_permission");
  });

  it("invokes the client with the ORIGINAL name even when prefixed", async () => {
    const { client, calls } = fakeClient([SEARCH]);
    const [tool] = await createMcpTools(client, { prefix: "mcp__docs__" });
    expect(tool.name).toBe("mcp__docs__search_web");
    const out = (await tool.handler({ query: "nexus" })) as McpToolResult;
    expect(out.text).toBe("ok");
    expect(calls).toEqual([{ name: "search_web", args: { query: "nexus" } }]);
  });

  it("returns an isError result verbatim (does not throw)", async () => {
    const { client } = fakeClient([SEARCH], () => ({
      content: [{ type: "text", text: "boom" }],
      isError: true,
      text: "boom",
    }));
    const [tool] = await createMcpTools(client);
    const out = (await tool.handler({ query: "x" })) as McpToolResult;
    expect(out.isError).toBe(true);
    expect(out.text).toBe("boom");
  });

  it("falls back to a generated description when the server omits one", async () => {
    const { client } = fakeClient([{ name: "noop", inputSchema: { type: "object" } }]);
    const [tool] = await createMcpTools(client);
    expect(tool.description).toContain("noop");
  });

  it("honours a custom tier override", async () => {
    const { client } = fakeClient([SEARCH]);
    const [tool] = await createMcpTools(client, { tier: "auto_allowed" });
    expect(tool.tier).toBe("auto_allowed");
  });

  it("rejects an already-aborted signal before calling the server", async () => {
    const { client, calls } = fakeClient([SEARCH]);
    const [tool] = await createMcpTools(client);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(tool.handler({ query: "x" }, { signal: ctrl.signal })).rejects.toThrow(/aborted/);
    expect(calls).toHaveLength(0);
  });

  it("registers into a RuntimeToolSet and invokes end-to-end", async () => {
    const { client } = fakeClient([SEARCH]);
    const set = new RuntimeToolSet();
    for (const t of await createMcpTools(client, { prefix: "mcp__x__" })) set.add(t);
    expect(set.names()).toEqual(["mcp__x__search_web"]);
    const res = await set.invoke("mcp__x__search_web", { query: "nexus" });
    expect(res.error).toBeUndefined();
    expect((res.output as McpToolResult).text).toBe("ok");
  });
});
