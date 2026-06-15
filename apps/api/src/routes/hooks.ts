// SPDX-License-Identifier: Apache-2.0
/**
 * Hooks routes — expose the global HookRegistry over HTTP.
 *
 * GET  /hooks/handlers     — list all registered handlers (event, label, priority)
 * GET  /hooks/log          — recent emit results (last 200, in-memory ring buffer)
 * POST /hooks/emit         — manually fire a hook event (admin/debug use)
 * DELETE /hooks/handlers/:id — deregister a handler by id
 *
 * The globalHooks singleton is imported from @nexus/hooks so gateway.ts,
 * memory.ts, and this route all share the same registry.
 */

import { globalHooks, HOOK_EVENTS, type HookEvent } from "@nexus/hooks";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Emit log ring buffer ──────────────────────────────────────────────────────

interface EmitLogEntry {
  id:        string;
  event:     string;
  timestamp: string;
  handled:   number;
  aborted:   boolean;
  errors:    unknown[];
}

const _emitLog: EmitLogEntry[] = [];
const EMIT_LOG_MAX = 200;

function recordEmit(entry: EmitLogEntry): void {
  _emitLog.push(entry);
  if (_emitLog.length > EMIT_LOG_MAX) _emitLog.shift();
}

// Patch globalHooks.emit to record results — thin observer wrapper
const _origEmit = globalHooks.emit.bind(globalHooks);
// @ts-expect-error — wrapping the bound method for observability
globalHooks.emit = async function (event: HookEvent, payload: unknown) {
  const result = await _origEmit(event, payload as Parameters<typeof _origEmit>[1]);
  recordEmit({
    id:        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    event:     event as string,
    timestamp: new Date().toISOString(),
    handled:   result.handled,
    aborted:   result.aborted,
    errors:    result.errors,
  });
  return result;
};

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function hooksRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /hooks/handlers
   *
   * List all registered handler registrations across all hook events.
   */
  app.get("/hooks/handlers", { preHandler: requireAuth }, async (_request, reply) => {
    const handlers: Array<{
      id: string;
      event: string;
      label?: string;
      priority: number;
    }> = [];

    for (const event of HOOK_EVENTS) {
      const regs = globalHooks.listHandlers(event as HookEvent);
      for (const reg of regs) {
        handlers.push({ id: reg.id, event: reg.event, label: reg.label, priority: reg.priority });
      }
    }

    return reply.send({ handlers, total: handlers.length, events: HOOK_EVENTS });
  });

  /**
   * GET /hooks/log?event=&limit=
   *
   * Return recent emit results from the ring buffer (newest first).
   */
  app.get<{
    Querystring: { event?: string; limit?: string };
  }>("/hooks/log", { preHandler: requireAuth }, async (request, reply) => {
    const { event, limit: limitStr } = request.query;
    const limit = Math.min(parseInt(limitStr ?? "50", 10) || 50, 200);

    let entries = [..._emitLog].reverse();
    if (event) entries = entries.filter((e) => e.event === event);
    entries = entries.slice(0, limit);

    return reply.send({ entries, total: entries.length });
  });

  /**
   * POST /hooks/emit
   *
   * Manually fire a hook event. Useful for admin dashboards and debugging.
   * Body: { event: string, payload?: Record<string, unknown> }
   */
  app.post<{
    Body: { event: string; payload?: Record<string, unknown> };
  }>("/hooks/emit", { preHandler: requireAuth }, async (request, reply) => {
    const { event, payload = {} } = request.body;

    if (!HOOK_EVENTS.includes(event as HookEvent)) {
      return reply.code(400).send({
        error: "unknown_event",
        validEvents: HOOK_EVENTS,
      });
    }

    const result = await globalHooks.emit(event as HookEvent, payload as never);
    return reply.send(result);
  });
}
