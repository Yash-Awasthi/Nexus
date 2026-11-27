// SPDX-License-Identifier: Apache-2.0
/**
 * User-data routes — GDPR portability (Art. 20) and erasure (Art. 17), §14.4.
 *
 * GET    /api/v1/users/:id/export — every durable row the account owns, as one JSON download.
 * DELETE /api/v1/users/:id/data   — erases every user-scoped row and the account, and returns what was kept.
 *
 * Both are self-service: the caller must match `:id` (403 otherwise), so a stolen admin token cannot export or
 * erase somebody else's account through this pair. The cascade is @nexus/db `eraseUserData`; these routes are a
 * guard, an audit event, and — for the delete — a receipt.
 */
import { db, eraseUserData, type ErasableDb } from "@nexus/db";
import type { FastifyInstance } from "fastify";

import { emitAuditEvent } from "../lib/audit-emitter.ts";
import { handleSelfErasure } from "../lib/gdpr-erasure.ts";
import { eraseStoredRecords } from "../lib/persistent-store.ts";
import { getPgPool } from "../lib/pg-pool.ts";
import { endAccountAccess } from "../lib/session-revocation.ts";
import { collectUserExport, exportFilename, RETAINED_AFTER_DELETION } from "../lib/user-export.ts";
import { requireAuthWithTier } from "../middleware/auth.ts";

export async function userDataRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    // Mounted inside the /api/v1 scope (see server.ts) — path is scope-relative.
    "/users/:id/export",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const callerId = request.nexusUserId;
      const { id } = request.params;
      if (!callerId || callerId !== id)
        return reply
          .code(403)
          .send({ code: "FORBIDDEN", message: "You may only export your own data" });

      // `getPgPool()` may be undefined when the server runs without a database; the collector then returns an
      // empty archive rather than the route failing, so a local install still answers the question.
      const archive = await collectUserExport(getPgPool() ?? undefined, id);

      await emitAuditEvent(
        {
          entityType: "user",
          entityId: id,
          action: "account.exported",
          actor: id,
          payload: {
            sessions: archive.sessions.length,
            memories: archive.memories.length,
            verdicts: archive.verdicts.length,
            storedRecords: archive.storedRecords.length,
          },
        },
        request.log,
      );

      return reply
        .header("content-type", "application/json; charset=utf-8")
        .header("content-disposition", `attachment; filename="${exportFilename(id)}"`)
        .send(archive);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/users/:id/data",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const erased: { table: string; deleted: number }[] = [];
      const outcome = await handleSelfErasure(
        request.nexusUserId,
        request.params.id,
        async (userId) => {
          // Narrow cast: the Neon HTTP driver's thenable result doesn't structurally
          // satisfy ErasableDb (weak-type check on the optional rowCount), but the
          // real client does expose rowCount at runtime. The cascade is otherwise
          // unit-tested against a fake ErasableDb in @nexus/db.
          const results = await eraseUserData(db as ErasableDb, userId);
          await eraseStoredRecords(userId);
          erased.push(...results.map((row) => ({ table: row.table, deleted: row.deleted })));
          return results;
        },
        request.log,
      );

      if (outcome.status === 403) return reply.code(403).send(outcome.body);
      if (outcome.status === 500) return reply.code(500).send(outcome.body);

      await emitAuditEvent(
        {
          entityType: "user",
          entityId: request.params.id,
          action: "account.erased",
          actor: request.params.id,
          payload: { erased, retained: RETAINED_AFTER_DELETION.map((item) => item.what) },
        },
        request.log,
      );
      await endAccountAccess(request.params.id);

      // 200 with a receipt instead of a bare 204: the person asked what happened to their data, and "the server
      // said nothing" is not an answer. The body lists rows removed and what remains, with the reason.
      return reply.code(200).send({
        erased,
        retained: RETAINED_AFTER_DELETION,
      });
    },
  );
}
