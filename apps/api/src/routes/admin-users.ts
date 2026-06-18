// SPDX-License-Identifier: Apache-2.0
/**
 * Admin user management routes — platform-level user administration.
 *
 * GET    /api/v1/admin/users               — list all users (admin only)
 * GET    /api/v1/admin/users/:id           — get user details
 * PATCH  /api/v1/admin/users/:id           — update tier, role, suspend
 * DELETE /api/v1/admin/users/:id           — hard-delete (irreversible)
 * POST   /api/v1/admin/users/:id/suspend   — soft-delete (deactivate)
 * POST   /api/v1/admin/users/:id/restore   — restore from soft-delete
 * GET    /api/v1/admin/users/:id/sessions  — list active sessions
 * DELETE /api/v1/admin/users/:id/sessions  — revoke all sessions
 *
 * Requires: JWT with role="admin" — enforced by requireAdminRole middleware.
 */

import { db } from "@nexus/db";
import { users, refreshTokens } from "@nexus/db/schema";
import { eq, isNull, isNotNull, desc, and } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Admin role guard ──────────────────────────────────────────────────────────

async function requireAdminRole(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(request, reply);
  if (reply.sent) return;

  const userId = request.nexusUserId;
  if (!userId) {
    await reply.code(403).send({ error: "jwt_required" });
    return;
  }

  const [user] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || (user.role !== "admin" && user.role !== "owner")) {
    await reply.code(403).send({ error: "admin_required", message: "This endpoint requires the admin role" });
  }
}

// ── Safe user view ────────────────────────────────────────────────────────────

function safeUserAdmin(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    tier: u.tier,
    emailVerified: u.emailVerified,
    mfaEnabled: u.mfaEnabled,
    stripeCustomerId: u.stripeCustomerId,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
    deletedAt: u.deletedAt?.toISOString() ?? null,
    active: u.deletedAt === null,
  };
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function adminUsersRoutes(app: FastifyInstance): Promise<void> {
  if (!process.env.DATABASE_URL) {
    const na = async (_: unknown, reply: { code: (n: number) => { send: (v: unknown) => unknown } }) =>
      reply.code(503).send({ error: "DATABASE_URL not configured" });
    app.get("/admin/users*", na);
    app.post("/admin/users*", na);
    app.patch("/admin/users*", na);
    app.delete("/admin/users*", na);
    return;
  }

  /** GET /admin/users?active=true&tier=pro&limit=100&offset=0 */
  app.get<{
    Querystring: { active?: string; tier?: string; role?: string; limit?: string; offset?: string };
  }>(
    "/admin/users",
    { preHandler: requireAdminRole },
    async (request, reply) => {
      const limit = Math.min(parseInt(request.query.limit ?? "100", 10), 500);
      const offset = parseInt(request.query.offset ?? "0", 10);

      let query = db.select().from(users);

      if (request.query.active === "true") {
        query = query.where(isNull(users.deletedAt)) as typeof query;
      } else if (request.query.active === "false") {
        query = query.where(isNotNull(users.deletedAt)) as typeof query;
      }

      const rows = await query.orderBy(desc(users.createdAt)).limit(limit).offset(offset);

      let filtered = rows;
      if (request.query.tier) {
        filtered = filtered.filter((u) => u.tier === request.query.tier);
      }
      if (request.query.role) {
        filtered = filtered.filter((u) => u.role === request.query.role);
      }

      return reply.send({
        users: filtered.map(safeUserAdmin),
        total: filtered.length,
        limit,
        offset,
      });
    },
  );

  /** GET /admin/users/:id */
  app.get<{ Params: { id: string } }>(
    "/admin/users/:id",
    { preHandler: requireAdminRole },
    async (request, reply) => {
      const [user] = await db.select().from(users).where(eq(users.id, request.params.id)).limit(1);
      if (!user) return reply.code(404).send({ error: "user_not_found" });
      return reply.send(safeUserAdmin(user));
    },
  );

  /** PATCH /admin/users/:id — update tier, role, emailVerified */
  app.patch<{
    Params: { id: string };
    Body: { tier?: string; role?: string; emailVerified?: boolean; name?: string };
  }>(
    "/admin/users/:id",
    {
      preHandler: requireAdminRole,
      schema: {
        body: {
          type: "object",
          properties: {
            tier: { type: "string", enum: ["free", "pro", "enterprise"] },
            role: { type: "string", enum: ["owner", "admin", "member", "viewer"] },
            emailVerified: { type: "boolean" },
            name: { type: "string", maxLength: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const updates: Record<string, unknown> = {};
      if (request.body.tier) updates.tier = request.body.tier;
      if (request.body.role) updates.role = request.body.role;
      if (request.body.emailVerified !== undefined) updates.emailVerified = request.body.emailVerified;
      if (request.body.name !== undefined) updates.name = request.body.name.trim();

      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: "no_changes" });
      }

      const [updated] = await db
        .update(users)
        .set(updates)
        .where(eq(users.id, request.params.id))
        .returning();

      if (!updated) return reply.code(404).send({ error: "user_not_found" });
      return reply.send(safeUserAdmin(updated));
    },
  );

  /** POST /admin/users/:id/suspend — deactivate user (soft-delete) */
  app.post<{ Params: { id: string } }>(
    "/admin/users/:id/suspend",
    { preHandler: requireAdminRole },
    async (request, reply) => {
      // Revoke all sessions
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, request.params.id), isNull(refreshTokens.revokedAt)));

      const [updated] = await db
        .update(users)
        .set({ deletedAt: new Date() })
        .where(eq(users.id, request.params.id))
        .returning();

      if (!updated) return reply.code(404).send({ error: "user_not_found" });
      return reply.send({ suspended: true, userId: updated.id });
    },
  );

  /** POST /admin/users/:id/restore — restore suspended user */
  app.post<{ Params: { id: string } }>(
    "/admin/users/:id/restore",
    { preHandler: requireAdminRole },
    async (request, reply) => {
      const [updated] = await db
        .update(users)
        .set({ deletedAt: null })
        .where(eq(users.id, request.params.id))
        .returning();

      if (!updated) return reply.code(404).send({ error: "user_not_found" });
      return reply.send({ restored: true, userId: updated.id });
    },
  );

  /** GET /admin/users/:id/sessions — list active sessions */
  app.get<{ Params: { id: string } }>(
    "/admin/users/:id/sessions",
    { preHandler: requireAdminRole },
    async (request, reply) => {
      const sessions = await db
        .select()
        .from(refreshTokens)
        .where(and(eq(refreshTokens.userId, request.params.id), isNull(refreshTokens.revokedAt)))
        .orderBy(desc(refreshTokens.createdAt));

      return reply.send({
        sessions: sessions.map((s) => ({
          id: s.id,
          createdAt: s.createdAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
          userAgent: s.userAgent,
          expired: s.expiresAt < new Date(),
        })),
        total: sessions.length,
      });
    },
  );

  /** DELETE /admin/users/:id/sessions — revoke all sessions (force logout) */
  app.delete<{ Params: { id: string } }>(
    "/admin/users/:id/sessions",
    { preHandler: requireAdminRole },
    async (request, reply) => {
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, request.params.id), isNull(refreshTokens.revokedAt)));

      return reply.send({ revoked: true, userId: request.params.id });
    },
  );

  /** DELETE /admin/users/:id — hard delete (irreversible) */
  app.delete<{ Params: { id: string } }>(
    "/admin/users/:id",
    { preHandler: requireAdminRole },
    async (request, reply) => {
      // Revoke sessions first
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.userId, request.params.id));

      await db.delete(users).where(eq(users.id, request.params.id));
      return reply.code(204).send();
    },
  );
}
