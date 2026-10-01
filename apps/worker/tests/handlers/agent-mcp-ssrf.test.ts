// SPDX-License-Identifier: Apache-2.0
/** A run's MCP servers are caller-named URLs: on a server none may reach a private address. */
import { afterEach, expect, it, vi } from "vitest";

import { mcpToolsFromServers } from "../../src/handlers/agent-mcp.js";

afterEach(() => {
  delete process.env.NEXUS_DESKTOP;
});

it("never connects to a private address off the desktop", async () => {
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(line));
  const tools = await mcpToolsFromServers([
    { name: "inside", serverUrl: "http://169.254.169.254/latest/meta-data/" },
  ]);
  expect(tools).toEqual([]);
  expect(errors.join("\n")).toMatch(/SSRF guard|private address/i);
});
