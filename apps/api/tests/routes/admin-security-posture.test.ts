// SPDX-License-Identifier: Apache-2.0
/** NX-FEAT-001: admins can read the deployment's security check; nobody else can. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const SECRET = "admin-security-posture-secret";
const DB = "pglite://:memory:admin-security-posture";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_API_KEY = "admin-security-posture-master-key-0123";
process.env.DATABASE_URL = DB;
delete process.env.NEXUS_DESKTOP;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { buildServer } = await import("../../src/server.ts");
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

const posture = (userId: string) =>
  app.inject({
    method: "GET",
    url: "/api/v1/admin/security/posture",
    headers: { authorization: `Bearer ${tokenFor(userId)}` },
  });

it("answers an admin with every check and a summary", async () => {
  const res = await posture(ADMIN);
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json<{
    summary: Record<string, number>;
    checks: { id: string; status: string }[];
  }>();
  expect(body.checks.map((c) => c.id)).toContain("audit-key");
  expect(body.summary.pass + body.summary.warn + body.summary.fail).toBe(body.checks.length);
});

it("refuses a member", async () => {
  expect((await posture(MEMBER)).statusCode).toBe(403);
});
