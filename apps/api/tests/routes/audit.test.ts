// SPDX-License-Identifier: Apache-2.0
/**
 * The audit trail covers every account, so members may not read it; admins,
 * owners and the operator's master key may. Runs on a real embedded database
 * because the gate reads the caller's role from the users table.
 */
import crypto from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const SECRET = "audit-test-secret";
const MASTER = "audit-test-master-key-0123456789";
const DB = "pglite://:memory:audit-test";

process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_API_KEY = MASTER;
process.env.DATABASE_URL = DB;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.js");
const { auditRoutes } = await import("../../src/routes/audit.js");

let app: FastifyInstance;

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const get = (url: string, bearer: string) =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${bearer}` } });

const OWNER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();

beforeAll(async () => {
  const pool = getPgPool(DB)!;
  await migrateEmbedded(pool);
  for (const [id, role] of [
    [OWNER, "owner"],
    [MEMBER, "member"],
  ] as const) {
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3)`,
      [id, `${role}-${id}@example.com`, role],
    );
  }
  app = Fastify();
  await app.register(auditRoutes);
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await closePgPools();
  delete process.env.NEXUS_API_KEY;
});

describe("audit log access", () => {
  it("refuses members and serves admins, owners and the master key", async () => {
    for (const url of ["/audit/log", "/audit/log/verify"]) {
      expect((await get(url, tokenFor(MEMBER))).statusCode, url).toBe(403);
      expect((await get(url, tokenFor(OWNER))).statusCode, url).toBe(200);
      expect((await get(url, MASTER)).statusCode, url).toBe(200);
    }
  });
});
