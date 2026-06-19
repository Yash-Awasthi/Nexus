// SPDX-License-Identifier: Apache-2.0
/**
 * SCIM 2.0 routes — automated user provisioning (RFC 7644).
 *
 * Enterprise identity providers (Okta, Azure AD, OneLogin) use SCIM to
 * automatically create, update, and deactivate user accounts.
 *
 * GET    /api/v1/scim/v2/Users           — list users (filter, pagination)
 * POST   /api/v1/scim/v2/Users           — provision a new user
 * GET    /api/v1/scim/v2/Users/:id       — get user by id
 * PUT    /api/v1/scim/v2/Users/:id       — replace user (full update)
 * PATCH  /api/v1/scim/v2/Users/:id       — partial update (add/replace/remove ops)
 * DELETE /api/v1/scim/v2/Users/:id       — deprovision (soft-delete)
 *
 * GET    /api/v1/scim/v2/Groups          — list groups (mapped to workspaces)
 * POST   /api/v1/scim/v2/Groups          — create group → workspace
 * GET    /api/v1/scim/v2/Groups/:id      — get group
 * PATCH  /api/v1/scim/v2/Groups/:id      — add/remove members
 * DELETE /api/v1/scim/v2/Groups/:id      — delete group → soft-delete workspace
 *
 * GET    /api/v1/scim/v2/ServiceProviderConfig  — SCIM capabilities declaration
 * GET    /api/v1/scim/v2/Schemas                — SCIM schema definitions
 *
 * Auth: Bearer token must equal NEXUS_SCIM_TOKEN env var.
 * All responses use SCIM media type: application/scim+json
 *
 * Ref: RFC 7644 (SCIM Protocol), RFC 7643 (SCIM Core Schema)
 */

import { randomBytes } from "node:crypto";

import { db } from "@nexus/db";
import { users, workspaces, workspaceMembers } from "@nexus/db/schema";
import { eq, isNull, and, ilike, or } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

// ── SCIM media type ───────────────────────────────────────────────────────────

const SCIM_MEDIA = "application/scim+json";

// ── SCIM auth ─────────────────────────────────────────────────────────────────

async function requireScimAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const scimToken = process.env.NEXUS_SCIM_TOKEN;
  if (!scimToken) {
    await reply.code(503).send({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "503",
      detail: "SCIM not configured — set NEXUS_SCIM_TOKEN",
    });
    return;
  }
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ") || auth.slice(7) !== scimToken) {
    await reply
      .code(401)
      .header("Content-Type", SCIM_MEDIA)
      .send({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "401",
        detail: "Unauthorized",
      });
  }
}

// ── SCIM user representation ──────────────────────────────────────────────────

function toScimUser(u: {
  id: string;
  email: string;
  name: string | null;
  role: string;
  tier: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  createdAt: Date;
  deletedAt: Date | null;
}) {
  const active = u.deletedAt === null;
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: u.id,
    externalId: u.email,
    userName: u.email,
    name: {
      formatted: u.name ?? u.email,
      givenName: u.name?.split(" ")[0] ?? "",
      familyName: u.name?.split(" ").slice(1).join(" ") ?? "",
    },
    displayName: u.name ?? u.email,
    emails: [{ value: u.email, primary: true, type: "work" }],
    active,
    meta: {
      resourceType: "User",
      created: u.createdAt.toISOString(),
      location: `/scim/v2/Users/${u.id}`,
    },
    // Nexus extension attributes
    "urn:ietf:params:scim:schemas:extension:nexus:2.0:User": {
      tier: u.tier,
      role: u.role,
      mfaEnabled: u.mfaEnabled,
      emailVerified: u.emailVerified,
    },
  };
}

// ── SCIM group representation (workspace) ─────────────────────────────────────

function toScimGroup(
  ws: { id: string; name: string; slug: string; createdAt: Date; deletedAt: Date | null },
  members: { userId: string; email: string }[],
) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    id: ws.id,
    externalId: ws.slug,
    displayName: ws.name,
    members: members.map((m) => ({
      value: m.userId,
      display: m.email,
      $ref: `/scim/v2/Users/${m.userId}`,
    })),
    meta: {
      resourceType: "Group",
      created: ws.createdAt.toISOString(),
      location: `/scim/v2/Groups/${ws.id}`,
    },
  };
}

// ── SCIM list response ────────────────────────────────────────────────────────

function scimList(resources: unknown[], totalResults: number, startIndex = 1) {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function scimRoutes(app: FastifyInstance): Promise<void> {
  // Content-type for all SCIM responses
  app.addHook("onSend", async (_req, reply) => {
    if (reply.request.url.includes("/scim/")) {
      reply.header("Content-Type", SCIM_MEDIA);
    }
  });

  // ── ServiceProviderConfig ──────────────────────────────────────────────────

  app.get("/scim/v2/ServiceProviderConfig", async (_req, reply) =>
    reply.send({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      documentationUri: "https://github.com/Yash-Awasthi/Nexus",
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 500 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: "oauthbearertoken",
          name: "OAuth Bearer Token",
          description: "Bearer token auth (NEXUS_SCIM_TOKEN)",
        },
      ],
    }),
  );

  // ── Schemas ────────────────────────────────────────────────────────────────

  app.get("/scim/v2/Schemas", async (_req, reply) =>
    reply.send({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 2,
      Resources: [
        { id: "urn:ietf:params:scim:schemas:core:2.0:User", name: "User" },
        { id: "urn:ietf:params:scim:schemas:core:2.0:Group", name: "Group" },
      ],
    }),
  );

  // ── Users ──────────────────────────────────────────────────────────────────

  /** GET /scim/v2/Users?filter=userName eq "..."&startIndex=1&count=100 */
  app.get<{
    Querystring: { filter?: string; startIndex?: string; count?: string };
  }>("/scim/v2/Users", { preHandler: requireScimAuth }, async (request, reply) => {
    const start = Math.max(1, parseInt(request.query.startIndex ?? "1", 10));
    const count = Math.min(parseInt(request.query.count ?? "100", 10), 500);
    const filter = request.query.filter;

    // Simple filter support: userName eq "email" | email eq "email" | externalId eq "email"
    if (filter) {
      const m = /(?:userName|email|externalId)\s+eq\s+"([^"]+)"/i.exec(filter);
      if (m?.[1]) {
        const rows = await db
          .select()
          .from(users)
          .where(eq(users.email, m[1].toLowerCase()))
          .limit(1);
        return reply.send(scimList(rows.map(toScimUser), rows.length, 1));
      }
      // displayName co "partial"
      const coM = /displayName\s+co\s+"([^"]+)"/i.exec(filter);
      if (coM?.[1]) {
        const rows = await db
          .select()
          .from(users)
          .where(or(ilike(users.email, `%${coM[1]}%`), ilike(users.name, `%${coM[1]}%`)))
          .limit(count);
        return reply.send(scimList(rows.map(toScimUser), rows.length, start));
      }
    }

    const allRows = await db
      .select()
      .from(users)
      .limit(count)
      .offset(start - 1);
    const total = allRows.length; // Simplified — production: COUNT(*)
    return reply.send(scimList(allRows.map(toScimUser), total, start));
  });

  /** POST /scim/v2/Users — provision user */
  app.post<{
    Body: {
      schemas: string[];
      userName: string;
      name?: { givenName?: string; familyName?: string; formatted?: string };
      emails?: { value: string; primary?: boolean }[];
      active?: boolean;
      externalId?: string;
    };
  }>("/scim/v2/Users", { preHandler: requireScimAuth }, async (request, reply) => {
    const email = (request.body.emails?.find((e) => e.primary)?.value ?? request.body.userName)
      .toLowerCase()
      .trim();
    const name =
      request.body.name?.formatted ||
      [request.body.name?.givenName, request.body.name?.familyName].filter(Boolean).join("") ||
      null;

    // Check for duplicate
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing) {
      return reply.code(409).send({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "409",
        detail: "User already exists",
        scimType: "uniqueness",
      });
    }

    const [user] = await db
      .insert(users)
      .values({
        email,
        passwordHash: `scim:provisioned:${randomBytes(16).toString("hex")}`,
        name,
        role: "member",
        tier: "free",
        emailVerified: true,
      })
      .returning();

    if (!user) return reply.code(500).send({ error: "insert_failed" });
    return reply
      .code(201)
      .header("Location", `/api/v1/scim/v2/Users/${user.id}`)
      .send(toScimUser(user));
  });

  /** GET /scim/v2/Users/:id */
  app.get<{ Params: { id: string } }>(
    "/scim/v2/Users/:id",
    { preHandler: requireScimAuth },
    async (request, reply) => {
      const [user] = await db.select().from(users).where(eq(users.id, request.params.id)).limit(1);
      if (!user) {
        return reply.code(404).send({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
          status: "404",
          detail: "User not found",
        });
      }
      return reply.send(toScimUser(user));
    },
  );

  /** PUT /scim/v2/Users/:id — full replace */
  app.put<{
    Params: { id: string };
    Body: {
      userName?: string;
      name?: { givenName?: string; familyName?: string; formatted?: string };
      active?: boolean;
    };
  }>("/scim/v2/Users/:id", { preHandler: requireScimAuth }, async (request, reply) => {
    const updates: Record<string, unknown> = {};
    if (request.body.name) {
      updates.name =
        request.body.name.formatted ||
        [request.body.name.givenName, request.body.name.familyName].filter(Boolean).join("") ||
        null;
    }
    if (request.body.active === false) {
      updates.deletedAt = new Date();
    } else if (request.body.active === true) {
      updates.deletedAt = null;
    }
    const [updated] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, request.params.id))
      .returning();
    if (!updated)
      return reply.code(404).send({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "404",
        detail: "User not found",
      });
    return reply.send(toScimUser(updated));
  });

  /** PATCH /scim/v2/Users/:id — partial update via Operations */
  app.patch<{
    Params: { id: string };
    Body: { Operations: { op: string; path?: string; value: unknown }[] };
  }>("/scim/v2/Users/:id", { preHandler: requireScimAuth }, async (request, reply) => {
    const updates: Record<string, unknown> = {};
    for (const op of request.body.Operations ?? []) {
      const operation = op.op.toLowerCase();
      if (
        op.path === "active" ||
        (op.path === undefined &&
          typeof (op.value as Record<string, unknown>)?.["active"] === "boolean")
      ) {
        const active =
          op.path === "active" ? op.value : (op.value as Record<string, unknown>)["active"];
        updates.deletedAt = active ? null : new Date();
      }
      if (op.path === "displayName" || op.path === "name.formatted") {
        updates.name = op.value;
      }
      if (
        (operation === "replace" || operation === "add") &&
        typeof op.value === "object" &&
        op.value !== null
      ) {
        const v = op.value as Record<string, unknown>;
        if (v["active"] !== undefined) updates.deletedAt = v["active"] ? null : new Date();
        if (v["displayName"]) updates.name = v["displayName"];
      }
    }
    const [updated] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, request.params.id))
      .returning();
    if (!updated)
      return reply.code(404).send({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "404",
        detail: "User not found",
      });
    return reply.send(toScimUser(updated));
  });

  /** DELETE /scim/v2/Users/:id — deprovision (soft-delete) */
  app.delete<{ Params: { id: string } }>(
    "/scim/v2/Users/:id",
    { preHandler: requireScimAuth },
    async (request, reply) => {
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, request.params.id))
        .limit(1);
      if (!existing)
        return reply.code(404).send({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
          status: "404",
          detail: "User not found",
        });
      await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, request.params.id));
      return reply.code(204).send();
    },
  );

  // ── Groups (workspaces) ────────────────────────────────────────────────────

  /** GET /scim/v2/Groups */
  app.get<{ Querystring: { startIndex?: string; count?: string } }>(
    "/scim/v2/Groups",
    { preHandler: requireScimAuth },
    async (request, reply) => {
      const count = Math.min(parseInt(request.query.count ?? "100", 10), 500);
      const start = Math.max(1, parseInt(request.query.startIndex ?? "1", 10));

      const wsList = await db
        .select()
        .from(workspaces)
        .where(isNull(workspaces.deletedAt))
        .limit(count)
        .offset(start - 1);

      const groups = await Promise.all(
        wsList.map(async (ws) => {
          const members = await db
            .select({ userId: workspaceMembers.userId, email: users.email })
            .from(workspaceMembers)
            .innerJoin(users, eq(workspaceMembers.userId, users.id))
            .where(eq(workspaceMembers.workspaceId, ws.id));
          return toScimGroup(ws, members);
        }),
      );

      return reply.send(scimList(groups, groups.length, start));
    },
  );

  /** POST /scim/v2/Groups — create workspace */
  app.post<{ Body: { displayName: string; externalId?: string; members?: { value: string }[] } }>(
    "/scim/v2/Groups",
    { preHandler: requireScimAuth },
    async (request, reply) => {
      const slug = (request.body.externalId ?? request.body.displayName)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);

      // Use first member as owner, or a system user
      const ownerId = request.body.members?.[0]?.value ?? "system";

      const [ws] = await db
        .insert(workspaces)
        .values({ name: request.body.displayName, slug, ownerId, tier: "free" })
        .returning();
      if (!ws) return reply.code(500).send({ error: "insert_failed" });

      // Add members
      if (request.body.members) {
        for (const m of request.body.members) {
          await db
            .insert(workspaceMembers)
            .values({
              workspaceId: ws.id,
              userId: m.value,
              role: "member",
              acceptedAt: new Date(),
            })
            .onConflictDoNothing();
        }
      }

      return reply
        .code(201)
        .header("Location", `/api/v1/scim/v2/Groups/${ws.id}`)
        .send(toScimGroup(ws, []));
    },
  );

  /** GET /scim/v2/Groups/:id */
  app.get<{ Params: { id: string } }>(
    "/scim/v2/Groups/:id",
    { preHandler: requireScimAuth },
    async (request, reply) => {
      const [ws] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, request.params.id))
        .limit(1);
      if (!ws)
        return reply.code(404).send({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
          status: "404",
          detail: "Group not found",
        });

      const members = await db
        .select({ userId: workspaceMembers.userId, email: users.email })
        .from(workspaceMembers)
        .innerJoin(users, eq(workspaceMembers.userId, users.id))
        .where(eq(workspaceMembers.workspaceId, ws.id));

      return reply.send(toScimGroup(ws, members));
    },
  );

  /** PATCH /scim/v2/Groups/:id — add/remove members */
  app.patch<{
    Params: { id: string };
    Body: {
      Operations: { op: string; path?: string; value?: { value: string }[] | { value: string } }[];
    };
  }>("/scim/v2/Groups/:id", { preHandler: requireScimAuth }, async (request, reply) => {
    for (const op of request.body.Operations ?? []) {
      const operation = op.op.toLowerCase();
      if (op.path === "members") {
        const vals = Array.isArray(op.value) ? op.value : op.value ? [op.value] : [];
        if (operation === "add") {
          for (const v of vals) {
            await db
              .insert(workspaceMembers)
              .values({
                workspaceId: request.params.id,
                userId: v.value,
                role: "member",
                acceptedAt: new Date(),
              })
              .onConflictDoNothing();
          }
        } else if (operation === "remove") {
          for (const v of vals) {
            await db
              .delete(workspaceMembers)
              .where(
                and(
                  eq(workspaceMembers.workspaceId, request.params.id),
                  eq(workspaceMembers.userId, v.value),
                ),
              );
          }
        }
      }
    }
    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, request.params.id))
      .limit(1);
    if (!ws)
      return reply.code(404).send({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "404",
        detail: "Group not found",
      });
    const members = await db
      .select({ userId: workspaceMembers.userId, email: users.email })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(eq(workspaceMembers.workspaceId, ws.id));
    return reply.send(toScimGroup(ws, members));
  });

  /** DELETE /scim/v2/Groups/:id */
  app.delete<{ Params: { id: string } }>(
    "/scim/v2/Groups/:id",
    { preHandler: requireScimAuth },
    async (request, reply) => {
      await db
        .update(workspaces)
        .set({ deletedAt: new Date() })
        .where(eq(workspaces.id, request.params.id));
      return reply.code(204).send();
    },
  );
}
