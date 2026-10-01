// SPDX-License-Identifier: Apache-2.0
/**
 * Rows written before owner scoping belong to no account on a server. An admin can see how
 * many there are and hand them all to one account, once; nobody else can.
 */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const SECRET = "admin-ownerless-secret";
const MASTER = "admin-ownerless-master-key-0123456789";
const DB = "pglite://:memory:admin-ownerless";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_API_KEY = MASTER;
process.env.DATABASE_URL = DB;
delete process.env.NEXUS_DESKTOP;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.js");
const { buildServer } = await import("../../src/server.js");
const { db } = await import("@nexus/db");
const { users } = await import("@nexus/db/schema");

const MEMBER = crypto.randomUUID();
const ADMIN = crypto.randomUUID();

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

let app: FastifyInstance;
beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  await db.insert(users).values([
    { id: MEMBER, email: "member@example.com", passwordHash: "x", role: "member" },
    { id: ADMIN, email: "admin@example.com", passwordHash: "x", role: "admin" },
  ]);
  app = await buildServer();
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app.close();
  await closePgPools();
});

const call = (method: "GET" | "POST", url: string, auth: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${auth}` }, payload });

it("lets only an admin hand ownerless rows to one account", async () => {
  const legacy = await call("POST", "/api/kb", MASTER, { name: "legacy notes" });
  expect(legacy.statusCode, legacy.body).toBeLessThan(300);
  const listFor = async (u: string) => (await call("GET", "/api/kb", tokenFor(u))).body;
  expect(await listFor(MEMBER)).not.toContain("legacy notes");

  expect((await call("GET", "/api/v1/admin/ownerless", tokenFor(MEMBER))).statusCode).toBe(403);
  const assignByMember = { userId: MEMBER };
  expect(
    (await call("POST", "/api/v1/admin/ownerless/assign", tokenFor(MEMBER), assignByMember))
      .statusCode,
  ).toBe(403);

  const counts = await call("GET", "/api/v1/admin/ownerless", tokenFor(ADMIN));
  expect(counts.statusCode).toBe(200);
  expect(counts.json<{ ownerless: Record<string, number> }>().ownerless.kb).toBeGreaterThan(0);

  const bad = await call("POST", "/api/v1/admin/ownerless/assign", tokenFor(ADMIN), {
    userId: crypto.randomUUID(),
  });
  expect(bad.statusCode).toBe(404);

  const done = await call("POST", "/api/v1/admin/ownerless/assign", tokenFor(ADMIN), {
    userId: MEMBER,
  });
  expect(done.statusCode, done.body).toBe(200);
  expect(done.json<{ assigned: Record<string, number> }>().assigned.kb).toBeGreaterThan(0);
  expect(await listFor(MEMBER)).toContain("legacy notes");
  expect(await listFor(ADMIN)).not.toContain("legacy notes");
  const after = await call("GET", "/api/v1/admin/ownerless", tokenFor(ADMIN));
  expect(after.json<{ ownerless: Record<string, number> }>().ownerless.kb).toBe(0);
});

it("keeps legacy prompts from every account until an admin hands them over", async () => {
  const made = await call("POST", "/api/prompts", MASTER, { name: "legacy prompt" });
  expect(made.statusCode, made.body).toBeLessThan(300);
  const listFor = async (u: string) => (await call("GET", "/api/prompts", tokenFor(u))).body;
  expect(await listFor(MEMBER)).not.toContain("legacy prompt");
  const counts = await call("GET", "/api/v1/admin/ownerless", tokenFor(ADMIN));
  expect(counts.json<{ ownerless: Record<string, number> }>().ownerless.prompts).toBeGreaterThan(0);
  await call("POST", "/api/v1/admin/ownerless/assign", tokenFor(ADMIN), { userId: MEMBER });
  expect(await listFor(MEMBER)).toContain("legacy prompt");
  expect(await listFor(ADMIN)).not.toContain("legacy prompt");
});
