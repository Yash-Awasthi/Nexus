// SPDX-License-Identifier: Apache-2.0
/**
 * MCP endpoint — MCP JSON-RPC 2.0 server over HTTP POST + SSE event stream.
 *
 * POST /mcp         — MCP JSON-RPC dispatcher (initialize, tools/list, tools/call)
 * GET  /mcp/info    — server capabilities (human-readable, no auth required)
 * GET  /mcp/events  — SSE stream for live tool call event notifications
 *
 * Protocol: MCP 2024-11-05, JSON-RPC 2.0 over HTTP POST.
 * Tools exposed: all ScrapingMcpServer tools (open_session, get, bulk_get,
 *   fetch, fetch_stealthy, screenshot, close_session, list_sessions).
 *
 * External MCP clients (e.g. Claude Desktop, Cursor) can point to this
 * endpoint to use Nexus scraping capabilities as MCP tools.
 */

import {
  MockScrapingBackend,
  ScrapingMcpServer,
  SessionStore,
  type ScrapingBackend,
} from "@nexus/scraping-mcp";
import {
  createStealthBackend,
  isPatchrightAvailable,
} from "@nexus/stealth-browser";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Backend factory ───────────────────────────────────────────────────────────
// Independent instance from scraping-mcp.ts; MCP clients get their own session store.

async function _buildMcpBackend(): Promise<ScrapingBackend> {
  if (process.env.STEALTH_BROWSER_URL || await isPatchrightAvailable()) {
    return createStealthBackend({ poolSize: 2 });
  }
  return new MockScrapingBackend();
}

// ── SSE event bus ─────────────────────────────────────────────────────────────

interface McpEvent {
  type: "tool_call" | "tool_result" | "session_opened" | "session_closed";
  toolName?: string;
  sessionId?: string;
  isError?: boolean;
  timestamp: string;
}

const _subscribers = new Set<(event: McpEvent) => void>();

function emit(event: McpEvent): void {
  for (const sub of _subscribers) {
    try { sub(event); } catch { /* ignore dead subscribers */ }
  }
}

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

function rpcOk(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcErr(id: string | number | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  // Resolve backend once at plugin registration
  const _backend  = await _buildMcpBackend();
  const _sessions = new SessionStore();
  const _server   = new ScrapingMcpServer(_backend, _sessions);

  /**
   * GET /mcp/events
   *
   * Server-Sent Events stream. Emits MCP tool call lifecycle events so browser
   * clients can observe tool activity without polling.
   *
   * Event types:
   *   tool_call    — a tool was invoked (before execution)
   *   tool_result  — a tool completed (after execution, includes isError)
   *   session_opened / session_closed — session lifecycle
   *
   * Clients should reconnect on drop; no history is replayed.
   */
  app.get("/mcp/events", { preHandler: requireAuth }, async (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send a heartbeat every 20 s to keep the connection alive
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) {
        reply.raw.write(": heartbeat\n\n");
      }
    }, 20_000);

    const send = (event: McpEvent): void => {
      if (!reply.raw.destroyed) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };

    _subscribers.add(send);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      _subscribers.delete(send);
    });

    // Fastify must not close the reply automatically
    await new Promise<void>((resolve) => {
      request.raw.on("close", resolve);
    });
  });

  /**
   * GET /mcp/info
   * Returns server capabilities without requiring auth.
   * Useful for MCP client discovery.
   */
  app.get("/mcp/info", async (_request, reply) => {
    return reply.send({
      name:            "nexus-mcp-server",
      version:         "0.1.0",
      protocolVersion: "2024-11-05",
      capabilities: {
        tools:     { listChanged: false },
        resources: {},
      },
      tools: _server.toolNames(),
    });
  });

  /**
   * POST /mcp
   *
   * MCP JSON-RPC 2.0 dispatcher.
   * Supported methods:
   *   initialize               — handshake, returns server info + capabilities
   *   notifications/initialized — client ready notification (no-op)
   *   tools/list               — enumerate available tools
   *   tools/call               — invoke a tool by name with arguments
   */
  app.post<{
    Body: {
      jsonrpc: "2.0";
      id: string | number | null;
      method: string;
      params?: unknown;
    };
  }>("/mcp", { preHandler: requireAuth }, async (request, reply) => {
    const { id = null, method, params } = request.body;

    // ── initialize ──────────────────────────────────────────────────────────
    if (method === "initialize") {
      return reply.send(rpcOk(id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools:     { listChanged: false },
          resources: {},
        },
        serverInfo: {
          name:    "nexus-mcp-server",
          version: "0.1.0",
        },
      }));
    }

    // ── notifications/initialized ───────────────────────────────────────────
    if (method === "notifications/initialized") {
      return reply.code(204).send();
    }

    // ── tools/list ──────────────────────────────────────────────────────────
    if (method === "tools/list") {
      const tools = _server.listTools().map((t) => ({
        name:        t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return reply.send(rpcOk(id, { tools }));
    }

    // ── tools/call ──────────────────────────────────────────────────────────
    if (method === "tools/call") {
      const p = params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      const toolName = p?.name;
      const args     = p?.arguments ?? {};

      if (!toolName) {
        return reply.send(rpcErr(id, -32602, "Missing required param: name"));
      }

      emit({ type: "tool_call", toolName, timestamp: new Date().toISOString() });

      try {
        const result = await _server.call(toolName, args);

        emit({
          type:      "tool_result",
          toolName,
          isError:   result.isError,
          timestamp: new Date().toISOString(),
        });

        return reply.send(rpcOk(id, {
          content: result.content,
          isError: result.isError,
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ type: "tool_result", toolName, isError: true, timestamp: new Date().toISOString() });
        return reply.send(rpcErr(id, -32603, `Tool execution error: ${msg}`));
      }
    }

    // ── Unknown method ──────────────────────────────────────────────────────
    return reply.send(rpcErr(id, -32601, `Method not found: ${method}`));
  });
}
