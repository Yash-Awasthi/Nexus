// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/mcp-client — MCP-over-HTTP server core (Fastify MCP server parity).
 *
 * @nexus/mcp-client is otherwise a *client*; this module closes the
 * server-side gap: a pure JSON-RPC 2.0 handler implementing the MCP HTTP
 * protocol surface for tool servers — `initialize`, `tools/list`,
 * `tools/call`, `ping`, and notifications (202 Accepted, no response).
 * It is transport-agnostic (`handle()` takes a plain HTTP request shape),
 * so it can sit behind Fastify, Node's http, or any framework — the
 * Fastify plugin's job — and it can serve the tools `@nexus/mcp-openapi`
 * converts from OpenAPI specs.
 *
 * Error contract (JSON-RPC): -32700 parse error, -32600 invalid request,
 * -32601 method not found, -32602 invalid params, -32603 internal error.
 * Unknown tools and executor failures never leak stack traces — only the
 * error message is returned.
 *
 * Usage
 * ─────
 * ```ts
 * const server = new McpHttpServer({
 *   name: "my-server", version: "1.0.0",
 *   tools: [{ name: "get_weather", inputSchema: { type: "object" } }],
 *   execute: async (name, args) => ({ content: [{ type: "text", text: "22C" }], text: "22C" }),
 * });
 * const { status, body } = await server.handle({ method: "POST", path: "/mcp", body: request });
 * ```
 */

import type { McpToolDefinition, McpCallResult } from "./index.js";

export interface McpHttpRequest {
  method: string;
  path: string;
  /** Parsed JSON body (or raw value for malformed input detection). */
  body: unknown;
}

export interface McpHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type McpToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => McpCallResult | Promise<McpCallResult>;

export interface McpHttpServerOptions {
  name: string;
  version: string;
  tools: McpToolDefinition[];
  execute: McpToolExecutor;
  protocolVersion?: string;
}

interface JsonRpcEnvelope {
  jsonrpc: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const PROTOCOL_VERSION = "2026-07-28";
const NOTIFICATION_PATHS = new Set([
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/tools/list_changed",
  "notifications/roots/list_changed",
]);

const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });

export class McpHttpServer {
  private readonly name: string;
  private readonly version: string;
  private readonly tools: McpToolDefinition[];
  private readonly execute: McpToolExecutor;
  private readonly protocolVersion: string;

  constructor(options: McpHttpServerOptions) {
    this.name = options.name;
    this.version = options.version;
    this.tools = options.tools;
    this.execute = options.execute;
    this.protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
  }

  /** Handle one HTTP request. Returns the JSON-RPC (or error) response. */
  async handle(req: McpHttpRequest): Promise<McpHttpResponse> {
    if (req.method !== "POST") {
      return { status: 405, body: { error: "Method Not Allowed" }, headers: { Allow: "POST" } };
    }
    if (req.path !== "/mcp" && req.path !== "/") {
      return { status: 404, body: { error: "Not Found" } };
    }

    const envelope = req.body as JsonRpcEnvelope;
    if (typeof req.body !== "object" || req.body === null || envelope.jsonrpc !== "2.0") {
      return {
        status: 400,
        body: rpcError(null, -32600, "Invalid Request: expected a JSON-RPC 2.0 object"),
      };
    }
    if (typeof envelope.id === "undefined") {
      // Notification: never respond.
      if (typeof envelope.method !== "string" || !NOTIFICATION_PATHS.has(envelope.method)) {
        return { status: 400, body: rpcError(null, -32600, "Invalid Request: bad notification") };
      }
      return { status: 202, body: null };
    }
    if (typeof envelope.method !== "string") {
      return { status: 400, body: rpcError(envelope.id, -32600, "Invalid Request: missing method") };
    }

    const id = envelope.id;
    switch (envelope.method) {
      case "initialize": {
        const clientInfo =
          (envelope.params as { clientInfo?: { name?: string; version?: string } } | undefined)
            ?.clientInfo ?? {};
        return {
          status: 200,
          body: rpcResult(id, {
            protocolVersion: this.protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: clientInfo.name ? `${this.name} (for ${clientInfo.name})` : this.name,
              version: this.version,
            },
          }),
        };
      }
      case "tools/list":
        return { status: 200, body: rpcResult(id, { tools: this.tools }) };
      case "tools/call": {
        const params = (envelope.params ?? {}) as { name?: unknown; arguments?: unknown };
        if (typeof params.name !== "string") {
          return {
            status: 200,
            body: rpcError(id, -32602, "Invalid params: tool name required"),
          };
        }
        const tool = this.tools.find((t) => t.name === params.name);
        if (!tool) {
          return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${params.name}`) };
        }
        const args =
          typeof params.arguments === "object" && params.arguments !== null
            ? (params.arguments as Record<string, unknown>)
            : {};
        try {
          const result = await this.execute(tool.name, args);
          return {
            status: 200,
            body: rpcResult(id, { content: result.content, isError: result.isError }),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { status: 200, body: rpcError(id, -32603, `Tool execution failed: ${message}`) };
        }
      }
      case "ping":
        return { status: 200, body: rpcResult(id, {}) };
      default:
        return { status: 200, body: rpcError(id, -32601, `Method not found: ${envelope.method}`) };
    }
  }
}