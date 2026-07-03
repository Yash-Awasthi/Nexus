// SPDX-License-Identifier: Apache-2.0
/**
 * agent-mcp — bridge external MCP servers into the agent loop as RuntimeTools.
 *
 * Connects to an MCP server via @nexus/mcp-client, lists its tools, and wraps each
 * as a RuntimeTool whose handler calls `callTool`. The MCP tool's `inputSchema`
 * becomes the RuntimeTool's `parameters` (advertised to native tool-calling), so
 * the model can invoke MCP tools exactly like built-in ones. Tool names are
 * namespaced `<server>__<tool>` to avoid collisions across servers.
 *
 * This mirrors jcode's "convert MCP tools → the harness Tool type" pattern.
 * The per-user encrypted MCP registry (apps/api `/mcp/servers`) is the eventual
 * source of these configs; for now they arrive on the job payload.
 */
import type { RuntimeTool } from "@nexus/agent-runtime";
import { McpClient, type McpToolDefinition } from "@nexus/mcp-client";

export interface McpServerConfig {
  /** Short label; also the tool-name prefix. */
  name: string;
  serverUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** Provider tool names must match ^[a-zA-Z0-9_-]{1,64}$ (Anthropic + OpenAI). */
function toToolName(server: string, tool: string): string {
  const name = `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  return name.length > 64 ? name.slice(0, 64) : name;
}

/** Coerce an MCP inputSchema into a usable JSON-Schema object for tool-calling. */
function toParameters(schema: unknown): Record<string, unknown> {
  return schema && typeof schema === "object"
    ? (schema as Record<string, unknown>)
    : { type: "object", properties: {} };
}

function wrapMcpTool(client: McpClient, server: string, def: McpToolDefinition): RuntimeTool {
  return {
    name: toToolName(server, def.name),
    description: def.description ?? `MCP tool '${def.name}' from server '${server}'`,
    parameters: toParameters(def.inputSchema),
    handler: async (args) => {
      const result = await client.callTool(def.name, args);
      if (result.isError) throw new Error(result.text || "MCP tool returned an error");
      return result.text || JSON.stringify(result.content);
    },
  };
}

/** Connect to one MCP server and wrap its tools. */
export async function mcpToolsFromServer(cfg: McpServerConfig): Promise<RuntimeTool[]> {
  const client = new McpClient({
    serverUrl: cfg.serverUrl,
    apiKey: cfg.apiKey,
    extraHeaders: cfg.headers,
    timeoutMs: cfg.timeoutMs ?? 20_000,
  });
  await client.initialize();
  const defs = await client.listTools();
  return defs.map((def) => wrapMcpTool(client, cfg.name, def));
}

/** Connect to multiple MCP servers; a failed server is logged and skipped. */
export async function mcpToolsFromServers(servers: McpServerConfig[]): Promise<RuntimeTool[]> {
  const settled = await Promise.allSettled(servers.map((s) => mcpToolsFromServer(s)));
  const tools: RuntimeTool[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") tools.push(...r.value);
    else
      console.error(
        JSON.stringify({
          level: "error",
          event: "mcp.connect_failed",
          server: servers[i]?.name,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        }),
      );
  });
  return tools;
}
