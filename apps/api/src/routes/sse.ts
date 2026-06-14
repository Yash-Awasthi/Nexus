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

import {
  globalBus,
  formatSseEvent,
  formatPing,
  type SseEvent,
} from "@nexus/sse";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

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
function openSseConnection(
  raw: import("http").ServerResponse,
  socket: import("net").Socket,
  channels: string[],
): void {
  // Write status line + headers (hijacked reply, no Fastify layer)
  raw.writeHead(200, SSE_HEADERS);

  // Initial flush comment — triggers EventSource to fire the `open` event
  raw.write(":\n\n");

  // Subscribe to each channel
  const listeners: Array<[string, (e: SseEvent) => void]> = channels.map((channel) => {
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
  // ── All task updates ─────────────────────────────────────────────────────

  app.get(
    "/sse/tasks",
    { preHandler: requireAuth },
    async (request, reply): Promise<void> => {
      reply.hijack();
      openSseConnection(reply.raw, request.socket, ["tasks"]);
    },
  );

  // ── Single task updates ──────────────────────────────────────────────────

  app.get<{ Params: { taskId: string } }>(
    "/sse/tasks/:taskId",
    { preHandler: requireAuth },
    async (request, reply): Promise<void> => {
      reply.hijack();
      openSseConnection(reply.raw, request.socket, [
        `tasks:${request.params.taskId}`,
      ]);
    },
  );

  // ── All signals ──────────────────────────────────────────────────────────

  app.get(
    "/sse/signals",
    { preHandler: requireAuth },
    async (request, reply): Promise<void> => {
      reply.hijack();
      openSseConnection(reply.raw, request.socket, ["signals"]);
    },
  );

  // ── All verdicts ─────────────────────────────────────────────────────────

  app.get(
    "/sse/verdicts",
    { preHandler: requireAuth },
    async (request, reply): Promise<void> => {
      reply.hijack();
      openSseConnection(reply.raw, request.socket, ["verdicts"]);
    },
  );

  // ── Verdict for a specific task ──────────────────────────────────────────

  app.get<{ Params: { taskId: string } }>(
    "/sse/verdicts/:taskId",
    { preHandler: requireAuth },
    async (request, reply): Promise<void> => {
      reply.hijack();
      openSseConnection(reply.raw, request.socket, [
        `verdicts:${request.params.taskId}`,
      ]);
    },
  );
}
