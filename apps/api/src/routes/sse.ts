// SPDX-License-Identifier: Apache-2.0
/**
 * Server-Sent Events routes
 *
 *   GET /api/v1/sse/tasks              — all task status updates
 *   GET /api/v1/sse/tasks/:taskId      — updates for a single task
 *   GET /api/v1/sse/signals            — new ingest signals
 *   GET /api/v1/sse/verdicts           — all council verdicts
 *   GET /api/v1/sse/verdicts/:taskId   — verdict for a specific task
 *
 * Protocol
 * --------
 * Clients connect via EventSource (browser) or any SSE-capable HTTP client.
 * The server hijacks the Fastify reply and writes raw SSE frames:
 *
 *   event: task.update\n
 *   id: task-<id>-<ts>\n
 *   data: {"taskId":"...","status":"running",...}\n
 *   \n
 *
 * A `:ping` comment is written every PING_INTERVAL_MS to keep the TCP
 * connection alive through intermediary proxies.
 *
 * Clean-up
 * --------
 * When the client disconnects (`socket close`), the channel listener and ping
 * timer are removed to prevent memory leaks.
 */

import type { ServerResponse } from "http";
import type { Socket } from "net";

import { globalBus, formatSseEvent, formatPing, type SseEvent } from "@nexus/sse";
import type { FastifyInstance } from "fastify";

import { startAgentEventsBridge, stopAgentEventsBridge } from "../lib/agent-events-bridge.js";
import { requireAuthWithTier } from "../middleware/auth.js";

const PING_INTERVAL_MS = 20_000;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no", // prevent Nginx from buffering SSE
} as const;

// ── Shared SSE connection helper ──────────────────────────────────────────────

/**
 * Open an SSE connection, subscribe to the given channel(s), and handle
 * clean-up on client disconnect.
 */
function openSseConnection(raw: ServerResponse, socket: Socket, channels: string[]): void {
  // Write status line + headers (hijacked reply, no Fastify layer)
  raw.writeHead(200, SSE_HEADERS);

  // Initial flush comment — triggers EventSource to fire the `open` event
  raw.write(":\n\n");

  // Subscribe to each channel
  const listeners: [string, (e: SseEvent) => void][] = channels.map((channel) => {
    const listener = (event: SseEvent): void => {
      if (!raw.destroyed) {
        raw.write(formatSseEvent(event));
      }
    };
    globalBus.subscribe(channel, listener);
    return [channel, listener];
  });

  // Keepalive ping
  const pingTimer = setInterval(() => {
    if (!raw.destroyed) {
      raw.write(formatPing());
    }
  }, PING_INTERVAL_MS);

  // Clean up on client disconnect
  const cleanup = (): void => {
    clearInterval(pingTimer);
    for (const [channel, listener] of listeners) {
      globalBus.unsubscribe(channel, listener);
    }
    if (!raw.destroyed) raw.end();
  };

  socket.once("close", cleanup);
  socket.once("error", cleanup);
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function sseRoutes(app: FastifyInstance): Promise<void> {
  // Start the worker→API Redis bridge so agent-run events published by the
  // worker process reach SSE clients here (no-op without REDIS_URL).
  await startAgentEventsBridge();
  app.addHook("onClose", async () => {
    await stopAgentEventsBridge();
  });

  // ── Tenant-isolation helper ──────────────────────────────────────────────
  // Verifies the authenticated user owns the given agent-session (by taskId).
  async function verifySessionOwnership(
    userId: string | undefined,
    streamId: string,
  ): Promise<boolean> {
    if (!userId) return false; // no user context → deny
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return true; // no DB → allow (single-tenant dev mode)
    try {
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
      const { rows } = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM agent_sessions WHERE task_id = $1 AND user_id IS NOT NULL LIMIT 1`,
        [streamId],
      );
      await pool.end();
      if (rows.length === 0) return true; // session not yet persisted → allow
      return rows[0]!.user_id === userId;
    } catch {
      return true; // DB unreachable → fail open (don't break SSE for transient issues)
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Firehose routes — enterprise/admin tier only
  // ══════════════════════════════════════════════════════════════════════════

  // ── All task updates ─────────────────────────────────────────────────────

  app.get(
    "/sse/tasks",
    { preHandler: requireAuthWithTier },
    async (request, reply): Promise<void> => {
      if (request.nexusTier !== "enterprise") {
        reply.code(403);
        return reply.send({ error: "Firehose requires enterprise tier" });
      }
      reply.hijack();
      openSseConnection(reply.raw, request.socket, ["tasks"]);
    },
  );

  // ── Single task updates (tenant-isolated) ────────────────────────────────

  app.get<{ Params: { taskId: string } }>(
    "/sse/tasks/:taskId",
    {
      schema: {
        response: {
          200: {},
          403: {},
        },
      },
      preHandler: requireAuthWithTier,
    },
    async (request, reply): Promise<void> => {
      if (!(await verifySessionOwnership(request.nexusUserId, request.params.taskId))) {
        reply.code(403);
        return reply.send({ error: "Not your task" });
      }
      reply.hijack();
      openSseConnection(reply.raw, request.socket, [`tasks:${request.params.taskId}`]);
    },
  );

  // ── All signals (enterprise only) ────────────────────────────────────────

  app.get(
    "/sse/signals",
    {
      schema: {
        response: {
          200: {},
          403: {},
        },
      },
      preHandler: requireAuthWithTier,
    },
    async (request, reply): Promise<void> => {
      if (request.nexusTier !== "enterprise") {
        reply.code(403);
        return reply.send({ error: "Firehose requires enterprise tier" });
      }
      reply.hijack();
      openSseConnection(reply.raw, request.socket, ["signals"]);
    },
  );

  // ── All verdicts (enterprise only) ───────────────────────────────────────

  app.get(
    "/sse/verdicts",
    {
      schema: {
        response: {
          200: {},
          403: {},
        },
      },
      preHandler: requireAuthWithTier,
    },
    async (request, reply): Promise<void> => {
      if (request.nexusTier !== "enterprise") {
        reply.code(403);
        return reply.send({ error: "Firehose requires enterprise tier" });
      }
      reply.hijack();
      openSseConnection(reply.raw, request.socket, ["verdicts"]);
    },
  );

  // ── Verdict for a specific task ─────────────────────────────────────────

  app.get<{ Params: { taskId: string } }>(
    "/sse/verdicts/:taskId",
    {
      schema: {
        response: {
          200: {},
          403: {},
        },
      },
      preHandler: requireAuthWithTier,
    },
    async (request, reply): Promise<void> => {
      if (!(await verifySessionOwnership(request.nexusUserId, request.params.taskId))) {
        reply.code(403);
        return reply.send({ error: "Not your task" });
      }
      reply.hijack();
      openSseConnection(reply.raw, request.socket, [`verdicts:${request.params.taskId}`]);
    },
  );

  // ── Live agent-run stream (step / compaction / status) ───────────────────
  // `:stream` is the run's sessionId or taskId. "all" = firehose (enterprise only).

  app.get<{ Params: { stream: string } }>(
    "/sse/agent/:stream",
    {
      schema: {
        response: {
          200: {},
          403: {},
        },
      },
      preHandler: requireAuthWithTier,
    },
    async (request, reply): Promise<void> => {
      const { stream } = request.params;
      // Firehose → enterprise only
      if (stream === "all") {
        if (request.nexusTier !== "enterprise") {
          reply.code(403);
          return reply.send({ error: "Agent firehose requires enterprise tier" });
        }
      } else {
        // Specific session → verify ownership
        if (!(await verifySessionOwnership(request.nexusUserId, stream))) {
          reply.code(403);
          return reply.send({ error: "Not your agent session" });
        }
      }
      const channel = stream === "all" ? "agent" : `agent:${stream}`;
      reply.hijack();
      openSseConnection(reply.raw, request.socket, [channel]);
    },
  );
}
