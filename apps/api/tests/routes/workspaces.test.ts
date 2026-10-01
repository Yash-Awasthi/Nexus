// SPDX-License-Identifier: Apache-2.0
/**
 * A workspace invitation joins only the account whose email it was sent to.
 * Runs against a real embedded database.
 */
import crypto from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const SECRET = "workspaces-test-secret";
const DB = "pglite://:memory:workspaces-test";

process.env.NEXUS_JWT_SECRET = SECRET;
process.env.DATABASE_URL = DB;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.js");
const { workspacesRoutes } = await import("../../src/routes/workspaces.js");
const { db } = await import("@nexus/db");
const { eq } = await import("drizzle-orm");
const { auditLog, users } = await import("@nexus/db/schema");

let app: FastifyInstance;

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  userId: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tokenFor(userId)}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const OWNER = crypto.randomUUID();
const INVITEE = crypto.randomUUID();
const STRANGER = crypto.randomUUID();

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  await db.insert(users).values([
    { id: OWNER, email: "owner@example.com", passwordHash: "x" },
    { id: INVITEE, email: "Invitee@Example.com", passwordHash: "x" },
    { id: STRANGER, email: "stranger@example.com", passwordHash: "x" },
  ]);
  app = Fastify();
  await app.register(workspacesRoutes);
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await closePgPools();
});

describe("workspace invitations", () => {
  it("join only the invited email", async () => {
    const ws = await call("POST", "/workspaces", OWNER, { name: "Crew" });
    expect(ws.statusCode, ws.body).toBe(201);
    const id = ws.json<{ id: string }>().id;
    const invite = await call("POST", `/workspaces/${id}/invitations`, OWNER, {
      email: "invitee@example.com",
    });
    expect(invite.statusCode, invite.body).toBe(201);
    const token = invite.json<{ invitationToken: string }>().invitationToken;

    const stolen = await call("GET", `/workspaces/invitations/${token}`, STRANGER);
    expect(stolen.statusCode).toBe(403);
    expect((await call("GET", `/workspaces/${id}`, STRANGER)).statusCode).toBe(404);

    const accepted = await call("GET", `/workspaces/invitations/${token}`, INVITEE);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await call("GET", `/workspaces/${id}`, INVITEE)).json()).toMatchObject({
      role: "member",
    });
  });

  it("lists and revokes pending invitations, changes roles and removes members", async () => {
    const ws = await call("POST", "/workspaces", OWNER, { name: "Admin Crew" });
    const id = ws.json<{ id: string }>().id;
    const pending = await call("POST", `/workspaces/${id}/invitations`, OWNER, {
      email: "later@example.com",
    });
    const invitationId = pending.json<{ invitation: { id: string } }>().invitation.id;
    const joined = await call("POST", `/workspaces/${id}/invitations`, OWNER, {
      email: "invitee@example.com",
    });
    await call(
      "GET",
      `/workspaces/invitations/${joined.json<{ invitationToken: string }>().invitationToken}`,
      INVITEE,
    );

    const list = await call("GET", `/workspaces/${id}/invitations`, OWNER);
    expect(list.statusCode, list.body).toBe(200);
    const invitations = list.json<{ invitations: { id: string; email: string }[] }>().invitations;
    expect(invitations.map((i) => i.email)).toEqual(["later@example.com"]);
    expect(list.body).not.toContain("tokenHash");
    expect((await call("GET", `/workspaces/${id}/invitations`, INVITEE)).statusCode).toBe(403);
    expect(
      (await call("DELETE", `/workspaces/${id}/invitations/${invitationId}`, INVITEE)).statusCode,
    ).toBe(403);

    const revoked = await call("DELETE", `/workspaces/${id}/invitations/${invitationId}`, OWNER);
    expect(revoked.statusCode).toBe(204);
    expect(
      (await call("GET", `/workspaces/${id}/invitations`, OWNER)).json<{ invitations: unknown[] }>()
        .invitations,
    ).toEqual([]);
    const token = pending.json<{ invitationToken: string }>().invitationToken;
    expect((await call("GET", `/workspaces/invitations/${token}`, INVITEE)).statusCode).toBe(410);

    // Only an admin changes roles or removes others; an outsider cannot even see the members.
    expect(
      (await call("PATCH", `/workspaces/${id}/members/${OWNER}`, INVITEE, { role: "viewer" }))
        .statusCode,
    ).toBe(403);
    expect((await call("DELETE", `/workspaces/${id}/members/${OWNER}`, INVITEE)).statusCode).toBe(
      403,
    );
    expect((await call("GET", `/workspaces/${id}/members`, STRANGER)).statusCode).toBe(404);
    expect(
      (await call("PATCH", `/workspaces/${id}/members/${INVITEE}`, STRANGER, { role: "admin" }))
        .statusCode,
    ).toBe(404);
    const role = await call("PATCH", `/workspaces/${id}/members/${INVITEE}`, OWNER, {
      role: "viewer",
    });
    expect(role.statusCode, role.body).toBe(200);
    expect((await call("GET", `/workspaces/${id}`, INVITEE)).json()).toMatchObject({
      role: "viewer",
    });
    expect((await call("DELETE", `/workspaces/${id}/members/${INVITEE}`, OWNER)).statusCode).toBe(
      204,
    );
    expect((await call("GET", `/workspaces/${id}`, INVITEE)).statusCode).toBe(404);
    // Removing someone who is not a member is not a removal.
    expect((await call("DELETE", `/workspaces/${id}/members/${INVITEE}`, OWNER)).statusCode).toBe(
      404,
    );

    // The removal is written to the audit log, which keys its entries by uuid.
    let entries: unknown[] = [];
    for (let i = 0; i < 50 && entries.length === 0; i++) {
      entries = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "workspace.member.removed"));
      if (entries.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(entries).toHaveLength(1);
  });
});
