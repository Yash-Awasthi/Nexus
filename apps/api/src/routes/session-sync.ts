// SPDX-License-Identifier: Apache-2.0
/**
 * Session-sync routes — cross-device session synchronisation via @nexus/session-sync.
 *
 * POST /api/v1/session-sync/:sessionId/push  — apply a batch of ops from a device
 * GET  /api/v1/session-sync/:sessionId/pull  — pull ops since a logical clock
 * GET  /api/v1/session-sync/:sessionId/state — return full session state snapshot
 *
 * Backing store:
 *   DrizzleSyncStore — when DATABASE_URL is set (persists ops to sync_patches table)
 *   SyncStore        — in-memory fallback (lost on process restart)
 *
 * Note: SyncManager and SyncStore are stateful in-process singletons.
 *   In a multi-replica deployment, pair with DrizzleSyncStore for cross-process
 *   consistency (pull-on-restart restores ops from the sync_patches table).
 */

import { DrizzleSyncStore, SyncManager, SyncStore, type OpType } from "@nexus/session-sync";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Singleton SyncManager ─────────────────────────────────────────────────────

async function buildManager(): Promise<SyncManager> {
  if (process.env.DATABASE_URL) {
    const drizzleStore = await DrizzleSyncStore.connect(process.env.DATABASE_URL);
    return new SyncManager("api-server", { store: drizzleStore });
  }
  return new SyncManager("api-server", { store: new SyncStore() });
}

// Eagerly initialise; route registration waits for the promise.
const managerPromise: Promise<SyncManager> = buildManager().catch((err) => {
  console.warn("[session-sync] DrizzleSyncStore init failed, falling back to InMemory:", err.message);
  return new SyncManager("api-server", { store: new SyncStore() });
});

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function sessionSyncRoutes(app: FastifyInstance): Promise<void> {
  const manager = await managerPromise;

  /**
   * POST /session-sync/:sessionId/push
   *
   * Apply one or more ops from a client device.  The session must exist —
   * if not, a new session is auto-created with an empty data payload.
   *
   * Body: {
   *   ops: Array<{ type: "set"|"delete"|"merge"; key: string; value?: unknown }>;
   *   deviceId?: string;
   *   userId?: string;
   * }
   */
  app.post<{
    Params: { sessionId: string };
    Body: {
      ops: Array<{ type: string; key: string; value?: unknown }>;
      deviceId?: string;
      userId?: string;
    };
  }>("/session-sync/:sessionId/push", { preHandler: requireAuth }, async (request, reply) => {
    const { sessionId } = request.params;
    const { ops, userId = "default", deviceId } = request.body;

    // Auto-create session when it doesn't exist yet
    const store = manager.getStore();
    if (!store.get(sessionId)) {
      const created = store.createSession(userId, deviceId ?? "api-server");
      // Override the generated id with the requested sessionId by replanting into store
      // (SyncStore stores by session.id — create a fresh session with the caller's id)
      const patched = { ...created, id: sessionId };
      store.delete(created.id);
      // Re-use applyOp to trigger DrizzleSyncStore persistence if applicable
      store.applyOp({
        sessionId,
        deviceId:    deviceId ?? "api-server",
        type:        "set",
        key:         "__init__",
        value:       { userId },
        timestamp:   new Date().toISOString(),
        logicalTime: 0,
      });
    }

    const validOps = ops.map((op) => ({
      type:  op.type as OpType,
      key:   op.key,
      value: op.value,
    }));

    const result = manager.push(sessionId, validOps);
    return reply.code(201).send(result);
  });

  /**
   * GET /session-sync/:sessionId/pull?since=<logicalTime>
   *
   * Pull all ops for the session after `since` (default: 0 = all ops).
   * Returns the ops list and the current session state.
   *
   * Query:
   *   since — logical time cursor; only ops with logicalTime > since are returned
   */
  app.get<{
    Params: { sessionId: string };
    Querystring: { since?: string };
  }>("/session-sync/:sessionId/pull", { preHandler: requireAuth }, async (request, reply) => {
    const { sessionId } = request.params;
    const since = parseInt(request.query.since ?? "0", 10) || 0;

    const result = manager.pull(sessionId, since);

    if (!result.session) {
      return reply.code(404).send({ error: `Session '${sessionId}' not found` });
    }

    return reply.send(result);
  });

  /**
   * GET /session-sync/:sessionId/state
   *
   * Return the full current state snapshot for a session.
   */
  app.get<{
    Params: { sessionId: string };
  }>("/session-sync/:sessionId/state", { preHandler: requireAuth }, async (request, reply) => {
    const { sessionId } = request.params;
    const session = manager.getStore().get(sessionId);

    if (!session) {
      return reply.code(404).send({ error: `Session '${sessionId}' not found` });
    }

    return reply.send({
      sessionId,
      data:        session.data,
      vectorClock: session.vectorClock,
      status:      session.status,
      version:     session.version,
      updatedAt:   session.updatedAt,
    });
  });
}
