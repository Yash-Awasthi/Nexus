// SPDX-License-Identifier: Apache-2.0
/**
 * Audit log routes
 *   GET /api/v1/audit/log          — paginated audit trail
 *   GET /api/v1/audit/log/verify   — verify HMAC chain integrity
 */

import { db } from "@nexus/db";
import { auditLog, users } from "@nexus/db/schema";
import type { SQL } from "drizzle-orm";
import { desc, gte, lte, and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { requireAuthWithTier } from "../middleware/auth.js";

/**
 * The audit trail spans every account, so only the operator reads it: the
 * master API key (no user identity), the development bypass, or a signed-in
 * admin or owner. A member reading it would see everyone's sign-ins.
 */
async function requireAuditReader(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuthWithTier(request, reply);
  if (reply.sent || !request.nexusUserId) return;
  const [user] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, request.nexusUserId))
    .limit(1)
    .catch(() => []);
  if (!user || (user.role !== "admin" && user.role !== "owner"))
    await reply
      .code(403)
      .send({ error: "admin_required", message: "The audit log is for admins." });
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  // GET /audit/log?entity_type=&entity_id=&since=&until=&limit=&offset=
  app.get<{
    Querystring: {
      entity_type?: string;
      entity_id?: string;
      since?: string;
      until?: string;
      limit?: string;
      offset?: string;
    };
  }>("/audit/log", { preHandler: requireAuditReader }, async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit ?? "100"), 500);
    const offset = parseInt(request.query.offset ?? "0");

    const conditions: SQL[] = [];
    if (request.query.since) {
      conditions.push(gte(auditLog.createdAt, new Date(request.query.since)));
    }
    if (request.query.until) {
      conditions.push(lte(auditLog.createdAt, new Date(request.query.until)));
    }

    const rows = await db
      .select()
      .from(auditLog)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditLog.sequence))
      .limit(limit)
      .offset(offset);

    return reply.send({ entries: rows, limit, offset });
  });

  // GET /audit/log/verify — re-derive chain hashes and check integrity
  app.get(
    "/audit/log/verify",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuditReader,
    },
    async (_request, reply) => {
      const { createHash, createHmac } = await import("node:crypto");
      const { asc } = await import("drizzle-orm");

      const auditKey = process.env.NEXUS_AUDIT_KEY ?? "nexus-dev-audit-key";
      const GENESIS = "NEXUS_AUDIT_CHAIN_GENESIS_V1";

      const rows = await db.select().from(auditLog).orderBy(asc(auditLog.sequence));

      if (rows.length === 0) {
        return reply.send({ valid: true, checked_count: 0, message: "Audit log is empty" });
      }

      let prevChainHash = GENESIS;
      let firstBroken: number | undefined;

      for (const entry of rows) {
        const payloadHash = createHash("sha256")
          .update(JSON.stringify(entry.payload, Object.keys(entry.payload as object).sort()))
          .digest("hex");

        const expected = createHmac("sha256", auditKey)
          .update(prevChainHash + payloadHash)
          .digest("hex");

        if (expected !== entry.chainHash) {
          firstBroken = entry.sequence;
          break;
        }
        prevChainHash = entry.chainHash;
      }

      const valid = firstBroken === undefined;
      return reply.send({
        valid,
        checked_count: rows.length,
        ...(firstBroken !== undefined
          ? { first_broken_sequence: firstBroken, message: "Chain integrity violation detected" }
          : { message: "Chain intact" }),
      });
    },
  );
}
