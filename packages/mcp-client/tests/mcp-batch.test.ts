// SPDX-License-Identifier: Apache-2.0
/** JSON-RPC batch invocation on the MCP server. */
import { describe, expect, it } from "vitest";

import { McpHttpServer } from "../src/index.js";

const server = new McpHttpServer({
  name: "t",
  version: "1",
  tools: [{ name: "echo", inputSchema: { type: "object" } }],
  execute: async (_name, args) => ({
    content: [{ type: "text", text: String(args["say"]) }],
    text: String(args["say"]),
  }),
});

describe("batch invocation", () => {
  it("answers every call in a batch, in order, and skips notifications", async () => {
    const res = await server.handle({
      method: "POST",
      path: "/mcp",
      body: [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "echo", arguments: { say: "a" } },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "echo", arguments: { say: "b" } },
        },
        { jsonrpc: "2.0", id: 3, method: "nope" },
      ],
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      id: number;
      result?: { content: { text: string }[] };
      error?: { code: number };
    }[];
    expect(body.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(body[0]!.result!.content[0]!.text).toBe("a");
    expect(body[1]!.result!.content[0]!.text).toBe("b");
    expect(body[2]!.error!.code).toBe(-32601);
  });

  it("rejects an empty batch", async () => {
    const res = await server.handle({ method: "POST", path: "/mcp", body: [] });
    expect(res.status).toBe(400);
  });
});
