// SPDX-License-Identifier: Apache-2.0
/**
 * mcp-tools — Bridge Model Context Protocol tools into a {@link RuntimeToolSet}.
 *
 * The bridge is a dependency-injection seam: it depends on a narrow
 * {@link McpToolClient} contract (a structural subset of `@nexus/mcp-client`'s
 * `McpClient`), NOT on the package itself. That keeps `agent-runtime` — the agent
 * hot-path — free of the MCP transport dependency, and lets tests drive the bridge
 * with a fake client that makes no outbound calls.
 *
 * Every bridged tool defaults to the `requires_permission` tier: an MCP call
 * reaches an external server, so it is never auto-allowed.
 */

import type { ActionTier, RuntimeTool, ToolContext } from "./index.js";

/** A tool advertised by an MCP server — subset of `@nexus/mcp-client`'s McpToolDefinition. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    description?: string;
  };
}

/** Result of an MCP tool call — subset of `@nexus/mcp-client`'s McpCallResult. */
export interface McpToolResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  /** Convenience: first text content block. */
  text: string;
}

/**
 * The slice of `@nexus/mcp-client`'s `McpClient` this bridge needs. Any object
 * with these two methods works — including a per-user MCP registry entry.
 */
export interface McpToolClient {
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

/** Options for {@link createMcpTools}. */
export interface McpBridgeOptions {
  /**
   * Prefix applied to each bridged tool's advertised name (e.g. `"mcp__docs__"`)
   * to namespace servers and avoid collisions. The ORIGINAL name is still used
   * when calling the server. Defaults to no prefix.
   */
  prefix?: string;
  /** Permission tier for every bridged tool. Defaults to `"requires_permission"`. */
  tier?: ActionTier;
}

function throwIfAborted(ctx?: ToolContext): void {
  if (ctx?.signal?.aborted) throw new Error("aborted");
}

/**
 * Discover the tools advertised by an MCP `client` and bridge each into a
 * {@link RuntimeTool}. The returned tools call back into `client.callTool` with
 * the server's original tool name; an `isError` result is returned verbatim (not
 * thrown) so the agent sees the error content, matching `run_command`'s
 * non-zero-exit passthrough.
 *
 * Async because it calls `client.listTools()` once up front.
 */
export async function createMcpTools(
  client: McpToolClient,
  opts: McpBridgeOptions = {},
): Promise<RuntimeTool[]> {
  const prefix = opts.prefix ?? "";
  const tier: ActionTier = opts.tier ?? "requires_permission";
  const defs = await client.listTools();
  return defs.map((def) => {
    const tool: RuntimeTool = {
      name: `${prefix}${def.name}`,
      description: def.description ?? `MCP tool \`${def.name}\``,
      parameters: def.inputSchema,
      tier,
      async handler(args, ctx) {
        throwIfAborted(ctx);
        // Call with the server's original (un-prefixed) tool name.
        return client.callTool(def.name, args ?? {});
      },
    };
    return tool;
  });
}
