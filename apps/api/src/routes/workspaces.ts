// SPDX-License-Identifier: Apache-2.0
/**
 * Workspace routes — multi-tenant organisation management.
 *
 * POST   /api/v1/workspaces                        — create workspace
 * GET    /api/v1/workspaces                        — list user's workspaces
 * GET    /api/v1/workspaces/:id                    — get workspace details
 * PATCH  /api/v1/workspaces/:id                    — update name/slug
 * DELETE /api/v1/workspaces/:id                    — soft-delete (owner only)
 *
 * Members:
 * GET    /api/v1/workspaces/:id/members            — list members
 * POST   /api/v1/workspaces/:id/invitations        — invite by email
 * GET    /api/v1/workspaces/invitations/:token     — accept invitation
 * PATCH  /api/v1/workspaces/:id/members/:userId    — change role
 * DELETE /api/v1/workspaces/:id/members/:userId    — remove member
 *
 * RBAC:
 *   owner   — all operations
 *   admin   — manage members, update settings
 *   member  — read workspace + members
 *   viewer  — read workspace only
 */

import { randomBytes } from "node:crypto";

import { db } from "@nexus/db";
import { workspaces, workspaceMembers, workspaceInvitations, users } from "@nexus/db/schema";
import { eq, and, gt, isNull, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { emitAuditEvent } from "../lib/audit-emitter.js";
import { sha256hex } from "../lib/crypto-utils.js";
import { requireAuthWithTier } from "../middleware/auth.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const ROLE_ORDER = { owner: 4, admin: 3, member: 2, viewer: 1 } as const;
type WorkspaceRole = keyof typeof ROLE_ORDER;

function hasMinRole(userRole: string, required: WorkspaceRole): boolean {
  return (ROLE_ORDER[userRole as WorkspaceRole] ?? 0) >= ROLE_ORDER[required];
}

// ── Route plugin ──────────────────────────────────────────────────────────────

/** The caller's membership when it reaches `min`; otherwise the reply to send. */
async function memberOf(workspaceId: string, userId: string | undefined, min: WorkspaceRole) {
  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId ?? "")),
    )
    .limit(1);
  if (!member) return { denied: { code: 404, body: { error: "workspace_not_found" } } } as const;
  if (!hasMinRole(member.role, min))
    return { denied: { code: 403, body: { error: "insufficient_role", required: min } } } as const;
  return { member } as const;
}

export async function workspacesRoutes(app: FastifyInstance): Promise<void> {
  if (!process.env.DATABASE_URL) {
    const na = async (
      _: unknown,
      reply: { code: (n: number) => { send: (v: unknown) => unknown } },
    ) => reply.code(503).send({ error: "DATABASE_URL not configured" });
    for (const method of ["get", "post", "patch", "delete"] as const)
      app[method]("/workspaces*", na);
    return;
  }

  /** POST /workspaces — create a new workspace */
  app.post<{ Body: { name: string; slug?: string } }>(
    "/workspaces",
    {
      preHandler: requireAuthWithTier,
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 64 },
            slug: { type: "string", minLength: 1, maxLength: 48, pattern: "^[a-z0-9-]+$" },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(403).send({ error: "jwt_required" });

      const slug = request.body.slug ?? slugify(request.body.name);

      // Ensure slug is unique
      const [existing] = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(eq(workspaces.slug, slug), isNull(workspaces.deletedAt)))
        .limit(1);

      if (existing) {
        return reply
          .code(409)
          .send({ error: "slug_taken", message: `Slug "${slug}" is already in use` });
      }

      const [ws] = await db
        .insert(workspaces)
        .values({ name: request.body.name.trim(), slug, ownerId: userId, tier: "free" })
        .returning();

      if (!ws) return reply.code(500).send({ error: "insert_failed" });

      // Creator gets "owner" role
      await db.insert(workspaceMembers).values({
        workspaceId: ws.id,
        userId,
        role: "owner",
        acceptedAt: new Date(),
      });

      emitAuditEvent(
        {
          entityType: "workspace",
          entityId: ws.id,
          action: "workspace.created",
          actor: userId,
          payload: { name: ws.name, slug: ws.slug },
        },
        app.log,
      );

      return reply.code(201).send(ws);
    },
  );

  /** GET /workspaces — list workspaces the caller belongs to */
  app.get("/workspaces", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const userId = request.nexusUserId;
    if (!userId) return reply.send({ workspaces: [], total: 0 });

    const memberships = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId));

    if (memberships.length === 0) return reply.send({ workspaces: [], total: 0 });

    const wsIds = memberships.map((m) => m.workspaceId);
    const wsList = await db
      .select()
      .from(workspaces)
      .where(and(inArray(workspaces.id, wsIds), isNull(workspaces.deletedAt)));

    const result = wsList.map((ws) => ({
      ...ws,
      role: memberships.find((m) => m.workspaceId === ws.id)?.role ?? "member",
    }));

    return reply.send({ workspaces: result, total: result.length });
  });

  /** GET /workspaces/:id — workspace details (member+) */
  app.get<{ Params: { id: string } }>(
    "/workspaces/:id",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const { id } = request.params;
      const { member, denied } = await memberOf(id, request.nexusUserId, "viewer");
      if (denied) return reply.code(denied.code).send(denied.body);

      const [ws] = await db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.id, id), isNull(workspaces.deletedAt)))
        .limit(1);

      if (!ws) return reply.code(404).send({ error: "workspace_not_found" });

      return reply.send({ ...ws, role: member.role });
    },
  );

  /** PATCH /workspaces/:id — update name/slug (admin+) */
  app.patch<{ Params: { id: string }; Body: { name?: string; slug?: string } }>(
    "/workspaces/:id",
    {
      preHandler: requireAuthWithTier,
      schema: {
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 64 },
            slug: { type: "string", minLength: 1, maxLength: 48, pattern: "^[a-z0-9-]+$" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { denied } = await memberOf(id, request.nexusUserId, "admin");
      if (denied) return reply.code(denied.code).send(denied.body);

      const updates: Record<string, unknown> = {};
      if (request.body.name) updates.name = request.body.name.trim();
      if (request.body.slug) {
        const [conflict] = await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(and(eq(workspaces.slug, request.body.slug), isNull(workspaces.deletedAt)))
          .limit(1);
        if (conflict && conflict.id !== id) {
          return reply.code(409).send({ error: "slug_taken" });
        }
        updates.slug = request.body.slug;
      }

      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: "no_changes" });
      }

      const [updated] = await db
        .update(workspaces)
        .set(updates)
        .where(eq(workspaces.id, id))
        .returning();

      return reply.send(updated);
    },
  );

  /** DELETE /workspaces/:id — soft-delete (owner only) */
  app.delete<{ Params: { id: string } }>(
    "/workspaces/:id",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const userId = request.nexusUserId;
      const { id } = request.params;
      const { denied } = await memberOf(id, userId, "owner");
      if (denied) return reply.code(denied.code).send(denied.body);

      await db.update(workspaces).set({ deletedAt: new Date() }).where(eq(workspaces.id, id));

      emitAuditEvent(
        {
          action: "workspace.deleted",
          actor: userId ?? "unknown",
          entityType: "workspace",
          entityId: id,
          payload: { workspaceId: id },
        },
        request.log,
      );

      return reply.code(204).send();
    },
  );

  // ── Members ──────────────────────────────────────────────────────────────────

  /** GET /workspaces/:id/members — list members (member+) */
  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/members",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const { id } = request.params;
      const { denied } = await memberOf(id, request.nexusUserId, "member");
      if (denied) return reply.code(denied.code).send(denied.body);

      const members = await db
        .select({
          id: workspaceMembers.id,
          userId: workspaceMembers.userId,
          role: workspaceMembers.role,
          acceptedAt: workspaceMembers.acceptedAt,
          createdAt: workspaceMembers.createdAt,
          name: users.name,
          email: users.email,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(workspaceMembers.userId, users.id))
        .where(eq(workspaceMembers.workspaceId, id));

      return reply.send({ members, total: members.length });
    },
  );

  /** POST /workspaces/:id/invitations — invite by email (admin+) */
  app.post<{
    Params: { id: string };
    Body: { email: string; role?: string };
  }>(
    "/workspaces/:id/invitations",
    {
      preHandler: requireAuthWithTier,
      schema: {
        body: {
          type: "object",
          required: ["email"],
          properties: {
            email: { type: "string", format: "email" },
            role: { type: "string", enum: ["admin", "member", "viewer"] },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.nexusUserId;
      const { id } = request.params;
      const { denied } = await memberOf(id, userId, "admin");
      if (denied) return reply.code(denied.code).send(denied.body);

      const email = request.body.email.trim().toLowerCase();
      const role = (request.body.role ?? "member") as "admin" | "member" | "viewer";

      // Check if already a member
      const [existingUser] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existingUser) {
        const [alreadyMember] = await db
          .select()
          .from(workspaceMembers)
          .where(
            and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, existingUser.id)),
          )
          .limit(1);
        if (alreadyMember) {
          return reply.code(409).send({ error: "already_member" });
        }
      }

      const rawToken = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 72 * 3600 * 1000); // 72 hours

      const [invitation] = await db
        .insert(workspaceInvitations)
        .values({
          workspaceId: id,
          email,
          role,
          tokenHash: sha256hex(rawToken),
          invitedByUserId: userId!,
          expiresAt,
        })
        .returning();

      // In production: send email with invitation link containing rawToken
      // For now: return the token directly (caller sends it via their email provider)
      return reply.code(201).send({
        invitation: { ...invitation, tokenHash: undefined },
        invitationToken: rawToken,
        acceptUrl: `${process.env.OAUTH_REDIRECT_BASE_URL ?? "http://localhost:3001"}/invitations/${rawToken}`,
        message: "Invitation created. Send acceptUrl to the invitee.",
      });
    },
  );

  /** GET /workspaces/:id/invitations — pending invitations (admin+) */
  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/invitations",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const { denied } = await memberOf(request.params.id, request.nexusUserId, "admin");
      if (denied) return reply.code(denied.code).send(denied.body);
      const invitations = await db
        .select({
          id: workspaceInvitations.id,
          email: workspaceInvitations.email,
          role: workspaceInvitations.role,
          expiresAt: workspaceInvitations.expiresAt,
          createdAt: workspaceInvitations.createdAt,
        })
        .from(workspaceInvitations)
        .where(
          and(
            eq(workspaceInvitations.workspaceId, request.params.id),
            isNull(workspaceInvitations.acceptedAt),
            gt(workspaceInvitations.expiresAt, new Date()),
          ),
        );
      return reply.send({ invitations });
    },
  );

  /** DELETE /workspaces/:id/invitations/:invitationId — revoke a pending invitation (admin+) */
  app.delete<{ Params: { id: string; invitationId: string } }>(
    "/workspaces/:id/invitations/:invitationId",
    {
      preHandler: requireAuthWithTier,
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" }, invitationId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const { denied } = await memberOf(request.params.id, request.nexusUserId, "admin");
      if (denied) return reply.code(denied.code).send(denied.body);
      const removed = await db
        .delete(workspaceInvitations)
        .where(
          and(
            eq(workspaceInvitations.id, request.params.invitationId),
            eq(workspaceInvitations.workspaceId, request.params.id),
            isNull(workspaceInvitations.acceptedAt),
          ),
        )
        .returning({ id: workspaceInvitations.id });
      if (removed.length === 0) return reply.code(404).send({ error: "invitation_not_found" });
      return reply.code(204).send();
    },
  );

  /** GET /workspaces/invitations/:token — accept invitation */
  app.get<{ Params: { token: string } }>(
    "/workspaces/invitations/:token",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(403).send({ error: "jwt_required" });

      const tokenHash = sha256hex(request.params.token);
      const now = new Date();

      const [invitation] = await db
        .select()
        .from(workspaceInvitations)
        .where(
          and(
            eq(workspaceInvitations.tokenHash, tokenHash),
            isNull(workspaceInvitations.acceptedAt),
          ),
        )
        .limit(1);

      if (!invitation || invitation.expiresAt < now) {
        return reply.code(410).send({ error: "invitation_expired_or_invalid" });
      }

      const [caller] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (caller?.email.trim().toLowerCase() !== invitation.email) {
        return reply.code(403).send({ error: "invitation_email_mismatch" });
      }

      await db
        .insert(workspaceMembers)
        .values({
          workspaceId: invitation.workspaceId,
          userId,
          role: invitation.role as WorkspaceRole,
          acceptedAt: now,
        })
        .onConflictDoNothing();

      // Mark invitation as accepted
      await db
        .update(workspaceInvitations)
        .set({ acceptedAt: now })
        .where(eq(workspaceInvitations.id, invitation.id));

      return reply.send({
        joined: true,
        workspaceId: invitation.workspaceId,
        role: invitation.role,
      });
    },
  );

  /** PATCH /workspaces/:id/members/:userId — change role (owner can change any; admin can change member/viewer) */
  app.patch<{
    Params: { id: string; userId: string };
    Body: { role: string };
  }>(
    "/workspaces/:id/members/:userId",
    {
      preHandler: requireAuthWithTier,
      schema: {
        body: {
          type: "object",
          required: ["role"],
          properties: { role: { type: "string", enum: ["admin", "member", "viewer"] } },
        },
      },
    },
    async (request, reply) => {
      const callerId = request.nexusUserId;
      const { id: workspaceId, userId: targetUserId } = request.params;

      const { denied } = await memberOf(workspaceId, callerId, "admin");
      if (denied) return reply.code(denied.code).send(denied.body);

      // Owners can't have their role changed except by themselves (prevent accidental lockout)
      const [targetMembership] = await db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, targetUserId),
          ),
        )
        .limit(1);

      if (!targetMembership) return reply.code(404).send({ error: "member_not_found" });
      if (targetMembership.role === "owner" && callerId !== targetUserId) {
        return reply.code(403).send({ error: "cannot_change_owner_role" });
      }

      const [updated] = await db
        .update(workspaceMembers)
        .set({ role: request.body.role as WorkspaceRole })
        .where(eq(workspaceMembers.id, targetMembership.id))
        .returning();

      emitAuditEvent(
        {
          action: "workspace.member.role_changed",
          actor: callerId ?? "unknown",
          entityType: "workspace_member",
          entityId: targetMembership.id,
          payload: {
            workspaceId,
            targetUserId,
            previousRole: targetMembership.role,
            newRole: request.body.role,
          },
        },
        request.log,
      );

      return reply.send(updated);
    },
  );

  /** DELETE /workspaces/:id/members/:userId — remove member (admin+; owner can remove any) */
  app.delete<{ Params: { id: string; userId: string } }>(
    "/workspaces/:id/members/:userId",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const callerId = request.nexusUserId;
      const { id: workspaceId, userId: targetUserId } = request.params;

      // Anyone may leave; removing someone else needs admin.
      const { member: callerMembership, denied } = await memberOf(
        workspaceId,
        callerId,
        callerId === targetUserId ? "viewer" : "admin",
      );
      if (denied) return reply.code(denied.code).send(denied.body);

      // Can't remove the last owner
      if (targetUserId === callerMembership.userId && callerMembership.role === "owner") {
        const ownerCount = await db
          .select()
          .from(workspaceMembers)
          .where(
            and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "owner")),
          );
        if (ownerCount.length <= 1) {
          return reply
            .code(409)
            .send({ error: "last_owner", message: "Transfer ownership before leaving" });
        }
      }

      const [removed] = await db
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, targetUserId),
          ),
        )
        .returning({ id: workspaceMembers.id });
      if (!removed) return reply.code(404).send({ error: "not_a_member" });

      // The audit log keys entries by uuid, so the membership row stands for the pair.
      emitAuditEvent(
        {
          action: "workspace.member.removed",
          actor: callerId ?? "unknown",
          entityType: "workspace_member",
          entityId: removed.id,
          payload: { workspaceId, targetUserId, self: callerId === targetUserId },
        },
        request.log,
      );

      return reply.code(204).send();
    },
  );
}
