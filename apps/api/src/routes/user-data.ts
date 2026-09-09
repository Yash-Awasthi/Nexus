// SPDX-License-Identifier: Apache-2.0
/**
 * User-data routes — GDPR right to erasure (§14.4).
 *
 * DELETE /api/v1/users/:id/data — erases every user-scoped row and the account.
 * Self-service only: the caller must match `:id` (403 otherwise). The cascade is
 * @nexus/db `eraseUserData`; this route is a thin guard + audit-log wrapper.
 */
import { db, eraseUserData, type ErasableDb } from "@nexus/db";
import type { FastifyInstance } from "fastify";

import { handleSelfErasure } from "../lib/gdpr-erasure.js";
import { requireAuthWithTier } from "../middleware/auth.js";

export async function userDataRoutes(app: FastifyInstance): Promise<void> {
  app.delete<{ Params: { id: string } }>(
    // Mounted inside the /api/v1 scope (see server.ts) — path is scope-relative.
    "/users/:id/data",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const outcome = await handleSelfErasure(
        request.nexusUserId,
        request.params.id,
        // Narrow cast: the Neon HTTP driver's thenable result doesn't structurally
        // satisfy ErasableDb (weak-type check on the optional rowCount), but the
        // real client does expose rowCount at runtime. The cascade is otherwise
        // unit-tested against a fake ErasableDb in @nexus/db.
        (userId) => eraseUserData(db as ErasableDb, userId),
        request.log,
      );

      if (outcome.status === 403) return reply.code(403).send(outcome.body);
      if (outcome.status === 500) return reply.code(500).send(outcome.body);
      return reply.code(204).send();
    },
  );
}
