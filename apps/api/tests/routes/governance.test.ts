// SPDX-License-Identifier: Apache-2.0
/**
 * Governance approvals belong to the account that created them. Runs against
 * a real embedded database: the property is a WHERE clause, which a mocked
 * query builder cannot show is present.
 */
import crypto from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const SECRET = "governance-test-secret";
const DB = "pglite://:memory:governance-test";

process.env.NEXUS_JWT_SECRET = SECRET;
process.env.DATABASE_URL = DB;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.js");
const { governanceRoutes } = await import("../../src/routes/governance.js");

let app: FastifyInstance;

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

function call(method: "GET" | "POST", url: string, userId: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tokenFor(userId)}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const ALICE = `alice-${crypto.randomUUID()}`;
const BOB = `bob-${crypto.randomUUID()}`;

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = Fastify();
  await app.register(governanceRoutes);
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await closePgPools();
});

describe("governance approvals", () => {
  it("are visible to and decidable by their owner only", async () => {
    const created = await call("POST", "/governance/approvals", ALICE, {
      entity_type: "task",
      entity_id: crypto.randomUUID(),
      action: "email.send-to-external",
      requestor: "agent:mailer",
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ id: string }>().id;

    const bobList = await call("GET", "/governance/approvals", BOB);
    expect(bobList.json<{ approvals: unknown[] }>().approvals).toEqual([]);
    expect((await call("GET", `/governance/approvals/${id}`, BOB)).statusCode).toBe(404);
    expect((await call("POST", `/governance/approvals/${id}/approve`, BOB, {})).statusCode).toBe(
      409,
    );

    const aliceList = await call("GET", "/governance/approvals?status=pending", ALICE);
    expect(aliceList.json<{ approvals: { id: string }[] }>().approvals.map((a) => a.id)).toEqual([
      id,
    ]);
    const approved = await call("POST", `/governance/approvals/${id}/approve`, ALICE, {});
    expect(approved.statusCode).toBe(200);
    expect(approved.json<{ status: string; resolvedBy: string }>()).toMatchObject({
      status: "approved",
      resolvedBy: ALICE,
    });
  });
});
