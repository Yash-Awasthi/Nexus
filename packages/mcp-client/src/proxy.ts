// SPDX-License-Identifier: Apache-2.0
/**
 * MCP aggregation client — one facade in front of many MCP servers.
 *
 * mcp-proxy's transport-bridging role is already covered in TS by McpClient /
 * McpHttpTransport (client side) + McpHttpServer (server side); this module is
 * the client-side aggregation half: a single {@link McpProxyClient} fans
 * `tools/list` across every registered server and merges the results, then
 * routes `tools/call` to whichever server owns the requested tool.
 *
 * Name policy: a tool name exposed by exactly one server keeps its original
 * name; a name exposed by several servers is namespaced as
 * `<server>.<tool>` for each owner, so a call to `weather.get` and
 * `search.get` stays unambiguous while single-server tools keep their plain
 * names. The routing map is rebuilt on every `listTools()`.
 *
 * Error isolation is structural: tools/call is routed to exactly one server,
 * and a server that fails its tools/list contributes no tools (recorded in
 * {@link McpProxyClient#failures}) instead of breaking the others.
 */

import { McpClient, McpClientError, type McpCallResult, type McpToolDefinition } from "./index.js";

/** One backend server behind the facade. */
export interface McpProxyServer {
  /** Namespace used when this server's tool names collide with others'. */
  name: string;
  /** Any McpClient (constructed from a URL or a raw transport). */
  client: McpClient;
}

/** Per-server outcome of the latest `listTools()` sweep. */
export interface McpProxyServerStatus {
  name: string;
  ok: boolean;
  /** Tools contributed by this server (post-rename). */
  toolCount: number;
  error?: string;
}

/** A resolved route for one logical tool name. */
export interface McpProxyRoute {
  /** Logical name callers use (namespaced on collision). */
  logical: string;
  server: string;
  /** The tool's original name on its server. */
  original: string;
  definition: McpToolDefinition;
}

/**
 * Facade over several MCP servers. Call {@link listTools} first — it discovers
 * tools and builds the routing map; {@link callTool} then routes by name.
 */
export class McpProxyClient {
  private readonly servers: McpProxyServer[];
  private routes = new Map<string, McpProxyRoute>();
  private lastFailures: McpProxyServerStatus[] = [];

  constructor(servers: McpProxyServer[]) {
    if (servers.length === 0) throw new Error("proxy: at least one server is required");
    const seen = new Set<string>();
    for (const s of servers) {
      if (seen.has(s.name)) throw new Error(`proxy: duplicate server name "${s.name}"`);
      seen.add(s.name);
    }
    this.servers = servers;
  }

  /** Names of the registered servers, in order. */
  serverNames(): string[] {
    return this.servers.map((s) => s.name);
  }

  /** Outcomes of the most recent listTools sweep (all successes by default). */
  failures(): McpProxyServerStatus[] {
    return this.lastFailures;
  }

  /**
   * Sweep every server and merge their tools into one namespace. Names exposed
   * by multiple servers are renamed `<server>.<tool>` for each owner; unique
   * names stay as-is. A server that errors contributes nothing (its failure is
   * recorded for {@link failures}) without blocking the others.
   */
  async listTools(): Promise<McpToolDefinition[]> {
    const settled = await Promise.allSettled(
      this.servers.map(async (s) => {
        const tools = await s.client.listTools();
        return { server: s.name, tools };
      }),
    );

    const perServer: Map<string, McpToolDefinition[]> = new Map();
    this.lastFailures = [];
    settled.forEach((outcome, i) => {
      const server = this.servers[i]!.name;
      if (outcome.status === "fulfilled") {
        perServer.set(server, outcome.value.tools);
        this.lastFailures.push({ name: server, ok: true, toolCount: outcome.value.tools.length });
      } else {
        perServer.set(server, []);
        const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        this.lastFailures.push({ name: server, ok: false, toolCount: 0, error });
      }
    });

    // ── Build the merged namespace ──────────────────────────────────────
    const byToolName = new Map<string, string[]>(); // original name → owning servers
    for (const [server, tools] of perServer) {
      for (const tool of tools) {
        const owners = byToolName.get(tool.name) ?? [];
        owners.push(server);
        byToolName.set(tool.name, owners);
      }
    }

    this.routes = new Map();
    const merged: McpToolDefinition[] = [];
    for (const [original, owners] of byToolName) {
      const collides = owners.length > 1;
      for (const server of owners) {
        const definition = perServer
          .get(server)!
          .find((t) => t.name === original)!;
        const logical = collides ? `${server}.${original}` : original;
        const routed: McpToolDefinition =
          collides ? { ...definition, name: logical } : definition;
        merged.push(routed);
        this.routes.set(logical, {
          logical,
          server,
          original,
          definition: routed,
        });
      }
    }
    return merged;
  }

  /**
   * Call a tool on the server that owns it. Unknown names raise an error that
   * lists the known tools. Errors from the owning server propagate (wrapped
   * with the server name) and never touch the other servers.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
    const route = this.routes.get(name);
    if (!route) {
      const known = Array.from(this.routes.keys()).sort().slice(0, 25).join(", ");
      throw new McpClientError(
        `proxy: unknown tool "${name}" — call listTools() first (known tools: ${known})`,
        "UNKNOWN_TOOL",
      );
    }
    const server = this.servers.find((s) => s.name === route.server);
    if (!server) throw new McpClientError(`proxy: server "${route.server}" is not registered`, "NO_SERVER");
    try {
      return await server.client.callTool(route.original, args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new McpClientError(`proxy: server "${route.server}" failed: ${message}`, "SERVER_ERROR");
    }
  }
}