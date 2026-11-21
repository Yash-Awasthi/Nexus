// SPDX-License-Identifier: Apache-2.0
/**
 * Round trip against a real stdio server: initialize, tools/list, one
 * tools/call, then shutdown. The fixture serves @nexus/scraping-mcp's tools
 * over stdin/stdout, so a missing server or a broken transport fails here.
 */
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { McpClient, McpStdioTransport } from "../src/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/scraping-stdio.ts", import.meta.url));

describe("stdio round trip", () => {
  it("lists tools, calls one, and shuts down", async () => {
    const transport = new McpStdioTransport({
      command: process.execPath,
      args: [fixture],
      timeoutMs: 20_000,
    });
    const client = new McpClient(transport);

    const info = await client.initialize();
    expect(info.name).toContain("nexus-scraping");

    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("open_session");

    const result = await client.callTool("open_session");
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ sessionId: expect.any(String) });

    await transport.close();
  });

  it("rejects when the server cannot start", async () => {
    const transport = new McpStdioTransport({
      command: "nexus-no-such-mcp-server",
      timeoutMs: 5_000,
    });
    const client = new McpClient(transport);
    await expect(client.initialize()).rejects.toThrow();
    await transport.close();
  });
});
