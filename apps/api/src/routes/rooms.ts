// SPDX-License-Identifier: Apache-2.0
/**
 * Rooms surface OWNER — extracted from api-bridge.ts (§16.7).
 *
 * In-memory room CRUD with byte-identical response shapes. The store was a
 * plain module-level Map in the bridge — it moves here unchanged.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";

const now = (): string => new Date().toISOString();

const _roomsStore = new Map<
  string,
  { id: string; name: string; createdAt: string; members: string[] }
>();

/** Register the /rooms surface. Called from apiBridgeRoutes. */
export async function roomsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/rooms", async (_req, reply) => {
    return reply.send([..._roomsStore.values()]);
  });

  app.post<{ Body: { name: string } }>("/rooms", async (request, reply) => {
    const id = crypto.randomUUID();
    const room = { id, name: request.body.name, createdAt: now(), members: [] };
    _roomsStore.set(id, room);
    return reply.code(201).send(room);
  });

  app.delete<{ Params: { id: string } }>("/rooms/:id", async (request, reply) => {
    _roomsStore.delete(request.params.id);
    return reply.code(204).send();
  });
}