// SPDX-License-Identifier: Apache-2.0
/**
 * Server-Sent Events routes
 *
 *   GET /api/v1/sse/tasks/:taskId      — updates for a single task
 *   GET /api/v1/sse/verdicts/:taskId   — verdict for a specific task
 *   GET /api/v1/sse/agent/:stream      — one agent run's steps
 *
 * Every stream is one the caller owns; there is no cross-account firehose.
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
import { getPgPool } from "../lib/pg-pool.js";
import { makeUserRateLimitPreHandler } from "../lib/rate-limiter.js";
import { requireAuthWithTier } from "../middleware/auth.js";

const PING_INTERVAL_MS = 20_000;

// Per-user limiter applied at SSE connection establishment. Generous limit
// because connections are long-lived (the cap is on how often a user may open
// a new stream, not on streamed traffic).
const sseRL = makeUserRateLimitPreHandler({ limit: 120, windowMs: 60_000, keyPrefix: "sse" });

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no", // prevent Nginx from buffering SSE
} as const;

// ── Shared SSE connection helper ──────────────────────────────────────────────

/**
 * Open an SSE connection, subscribe to the given channel(s), and handle
 * clean-up on client disconnect. Shared with other route modules (e.g.
 * notifications.ts) so every stream uses the same framing + cleanup.
 */
export function openSseConnection(raw: ServerResponse, socket: Socket, channels: string[]): void {
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
    const pool = getPgPool();
    if (!pool) return true; // no DB → allow (single-tenant dev mode)
    try {
      const { rows } = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM agent_sessions WHERE task_id = $1 AND user_id IS NOT NULL LIMIT 1`,
        [streamId],
      );
      if (rows.length === 0) return true; // session not yet persisted → allow
      return rows[0]!.user_id === userId;
    } catch (err) {
      // Fail closed: an unanswerable ownership query is not evidence of
      // ownership. Losing SSE during a database blip is recoverable; serving
      // another tenant's stream is not.
      app.log.error({ err, streamId }, "sse ownership check failed — denying");
      return false;
    }
  }

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
      preHandler: [requireAuthWithTier, sseRL],
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
      preHandler: [requireAuthWithTier, sseRL],
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
  // `:stream` is the run's sessionId or taskId.

  app.get<{ Params: { stream: string } }>(
    "/sse/agent/:stream",
    {
      schema: {
        response: {
          200: {},
          403: {},
        },
      },
      preHandler: [requireAuthWithTier, sseRL],
    },
    async (request, reply): Promise<void> => {
      const { stream } = request.params;
      if (!stream.trim()) {
        reply.code(400);
        return reply.send({ error: "Invalid stream selector" });
      }
      if (!(await verifySessionOwnership(request.nexusUserId, stream))) {
        reply.code(403);
        return reply.send({ error: "Not your agent session" });
      }
      reply.hijack();
      openSseConnection(reply.raw, request.socket, [`agent:${stream}`]);
    },
  );
}
