// SPDX-License-Identifier: Apache-2.0
// MCP-over-HTTP server core — focused tests.
import { describe, it, expect } from "vitest";
import { McpHttpServer } from "./server.js";
import type { McpToolDefinition } from "./index.js";

const WEATHER: McpToolDefinition = {
  name: "get_weather",
  description: "Get the weather for a city",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

function makeServer(execute = async (name: string, args: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: `${name}:${JSON.stringify(args)}` }],
  text: "",
})) {
  return new McpHttpServer({
    name: "test-server",
    version: "1.2.3",
    tools: [WEATHER],
    execute,
  });
}

describe("McpHttpServer", () => {
  it("handles initialize with protocol version, capabilities, and server info", async () => {
    const res = await makeServer().handle({
      method: "POST",
      path: "/mcp",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2026-07-28", clientInfo: { name: "test-client" } },
      },
    });
    expect(res.status).toBe(200);
    expect((res.body as { result: unknown }).result).toEqual({
      protocolVersion: "2026-07-28",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "test-server (for test-client)", version: "1.2.3" },
    });
  });

  it("lists registered tools", async () => {
    const res = await makeServer().handle({
      method: "POST",
      path: "/mcp",
      body: { jsonrpc: "2.0", id: "l", method: "tools/list" },
    });
    expect((res.body as { result: { tools: McpToolDefinition[] } }).result.tools).toEqual([
      WEATHER,
    ]);
  });

  it("calls a tool with parsed arguments", async () => {
    const called: Array<[string, Record<string, unknown>]> = [];
    const server = makeServer(async (name, args) => {
      called.push([name, args]);
      return { content: [{ type: "text", text: "22C" }], text: "22C" };
    });
    const res = await server.handle({
      method: "POST",
      path: "/mcp",
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_weather", arguments: { city: "Paris" } },
      },
    });
    expect(called).toEqual([["get_weather", { city: "Paris" }]]);
    expect((res.body as { result: { content: unknown[] } }).result).toEqual({
      content: [{ type: "text", text: "22C" }],
    });
  });

  it("rejects unknown tools with invalid params", async () => {
    const res = await makeServer().handle({
      method: "POST",
      path: "/mcp",
      body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } },
    });
    expect((res.body as { error: { code: number; message: string } }).error.code).toBe(-32602);
    expect((res.body as { error: { message: string } }).error.message).toBe("Unknown tool: nope");
  });

  it("returns internal error without leaking stacks when the executor throws", async () => {
    const server = makeServer(async () => {
      throw new Error("boom inside");
    });
    const res = await server.handle({
      method: "POST",
      path: "/mcp",
      body: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_weather" } },
    });
    const error = (res.body as { error: { code: number; message: string } }).error;
    expect(error.code).toBe(-32603);
    expect(error.message).toContain("boom inside");
    expect(JSON.stringify(res.body)).not.toContain("at ");
  });

  it("returns method-not-found for unknown methods and ping for ping", async () => {
    const server = makeServer();
    const missing = await server.handle({
      method: "POST",
      path: "/mcp",
      body: { jsonrpc: "2.0", id: 5, method: "resources/list" },
    });
    expect((missing.body as { error: { code: number } }).error.code).toBe(-32601);
    const ping = await server.handle({
      method: "POST",
      path: "/mcp",
      body: { jsonrpc: "2.0", id: 6, method: "ping" },
    });
    expect((ping.body as { result: unknown }).result).toEqual({});
  });

  it("rejects non-POST and wrong paths", async () => {
    const server = makeServer();
    const get = await server.handle({ method: "GET", path: "/mcp", body: null });
    expect(get.status).toBe(405);
    const wrong = await server.handle({ method: "POST", path: "/other", body: null });
    expect(wrong.status).toBe(404);
  });

  it("acknowledges notifications without responding", async () => {
    const res = await makeServer().handle({
      method: "POST",
      path: "/mcp",
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(res.status).toBe(202);
    expect(res.body).toBeNull();
  });

  it("rejects non-JSON-RPC bodies with a parse/invalid error", async () => {
    const server = makeServer();
    const bad = await server.handle({ method: "POST", path: "/mcp", body: "not json" });
    expect((bad.body as { error: { code: number } }).error.code).toBe(-32600);
  });

  it("serves tools converted from an OpenAPI spec (mcp-openapi parity)", async () => {
    // A tool in the shape @nexus/mcp-openapi produces.
    const converted: McpToolDefinition = {
      name: "list_repos",
      inputSchema: { type: "object", properties: { org: { type: "string" } } },
    };
    const server = new McpHttpServer({
      name: "openapi-bridge",
      version: "0.1.0",
      tools: [converted],
      execute: async (name, args) => ({
        content: [{ type: "text", text: `repos of ${args.org ?? "?"}` }],
        text: "",
      }),
    });
    const list = await server.handle({
      method: "POST",
      path: "/mcp",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect((list.body as { result: { tools: McpToolDefinition[] } }).result.tools[0].name).toBe(
      "list_repos",
    );
    const call = await server.handle({
      method: "POST",
      path: "/mcp",
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_repos", arguments: { org: "acme" } },
      },
    });
    expect((call.body as { result: { content: Array<{ text: string }> } }).result.content[0].text).toBe(
      "repos of acme",
    );
  });
});