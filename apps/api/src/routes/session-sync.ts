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
import type { FastifyInstance, FastifyRequest } from "fastify";

import { isNeonCompatibleUrl } from "../lib/pg-pool.js";
import { requireAuth } from "../middleware/auth.js";

// ── Singleton SyncManager ─────────────────────────────────────────────────────

async function buildManager(): Promise<SyncManager> {
  if (isNeonCompatibleUrl(process.env.DATABASE_URL)) {
    const drizzleStore = await DrizzleSyncStore.connect(process.env.DATABASE_URL);
    return new SyncManager("api-server", { store: drizzleStore });
  }
  return new SyncManager("api-server", { store: new SyncStore() });
}

// Eagerly initialise; route registration waits for the promise.
const managerPromise: Promise<SyncManager> = buildManager().catch((err) => {
  console.warn(
    "[session-sync] DrizzleSyncStore init failed, falling back to InMemory:",
    err.message,
  );
  return new SyncManager("api-server", { store: new SyncStore() });
});

const ANON = "anon";

/** Sessions are stored per account, so two accounts naming the same id never share one. */
function ownedKey(request: FastifyRequest, sessionId: string): string {
  return `${request.nexusUserId ?? ANON}:${sessionId}`;
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function sessionSyncRoutes(app: FastifyInstance): Promise<void> {
  const manager = await managerPromise;

  /**
   * POST /session-sync/:sessionId/push
   *
   * Apply one or more ops from a client device, creating the session on first push.
   *
   * Body: {
   *   ops: Array<{ type: "set"|"delete"|"merge"; key: string; value?: unknown }>;
   *   deviceId?: string;
   * }
   */
  app.post<{
    Params: { sessionId: string };
    Body: {
      ops: { type: string; key: string; value?: unknown }[];
      deviceId?: string;
    };
  }>(
    "/session-sync/:sessionId/push",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          required: ["ops"],
          properties: {
            ops: {
              type: "array",
              items: {
                type: "object",
                required: ["type", "key"],
                properties: { type: { type: "string" }, key: { type: "string" } },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params;
      const { ops, deviceId } = request.body;
      const key = ownedKey(request, sessionId);

      const store = manager.getStore();
      if (!store.get(key))
        store.createSession(request.nexusUserId ?? ANON, deviceId ?? "api-server", {}, key);

      const validOps = ops.map((op) => ({
        type: op.type as OpType,
        key: op.key,
        value: op.value,
      }));

      const result = manager.push(key, validOps);
      return reply.code(201).send({ ...result, sessionId });
    },
  );

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

    const result = manager.pull(ownedKey(request, sessionId), since);

    if (!result.session) {
      return reply.code(404).send({ error: `Session '${sessionId}' not found` });
    }

    return reply.send({
      sessionId,
      ops: result.ops.map((op) => ({ ...op, sessionId })),
      session: { ...result.session, id: sessionId },
    });
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
    const session = manager.getStore().get(ownedKey(request, sessionId));

    if (!session) {
      return reply.code(404).send({ error: `Session '${sessionId}' not found` });
    }

    return reply.send({
      sessionId,
      data: session.data,
      vectorClock: session.vectorClock,
      status: session.status,
      version: session.version,
      updatedAt: session.updatedAt,
    });
  });
}
