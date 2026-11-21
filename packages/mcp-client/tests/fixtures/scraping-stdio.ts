// SPDX-License-Identifier: Apache-2.0
/**
 * Test-only stdio MCP server: serves the real @nexus/scraping-mcp tools over
 * newline-delimited JSON-RPC on stdin/stdout, so the client's stdio transport
 * is exercised against Nexus code rather than a mock protocol.
 */
import { createInterface } from "node:readline";

import { MockScrapingBackend, ScrapingMcpServer } from "../../../scraping-mcp/src/index.ts";
import { McpHttpServer, type McpToolDefinition } from "../../src/server.ts";

const scraping = new ScrapingMcpServer(
  new MockScrapingBackend({ html: "<html><body><p>ok</p></body></html>", status: 200 }),
);

const tools: McpToolDefinition[] = scraping.listTools().map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
}));

const server = new McpHttpServer({
  name: "nexus-scraping",
  version: "0.1.0",
  tools,
  execute: (name, args) => scraping.call(name, args),
});

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  void (async () => {
    let body: unknown;
    try {
      body = JSON.parse(line);
    } catch {
      return;
    }
    const response = await server.handle({ method: "POST", path: "/mcp", body });
    if (response.body) process.stdout.write(`${JSON.stringify(response.body)}\n`);
  })();
});
lines.on("close", () => process.exit(0));
