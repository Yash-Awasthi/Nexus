// SPDX-License-Identifier: Apache-2.0
/** The gateway's cost report and spend cap count the caller's own spend, nobody else's. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SECRET = "gateway-cost-owner-secret";
const DB = "pglite://:memory:gateway-cost-owner";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.DATABASE_URL = DB;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.js");
const { buildServer } = await import("../../src/server.js");
const { costLogStore } = await import("../../src/lib/cost-log.js");
const { db } = await import("@nexus/db");
const { users } = await import("@nexus/db/schema");

const ALICE = crypto.randomUUID();
const BOB = crypto.randomUUID();

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
const as = (userId: string) => ({ authorization: `Bearer ${tokenFor(userId)}` });

let app: FastifyInstance;
beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  await db.insert(users).values([
    { id: ALICE, email: "alice-gw@example.com", passwordHash: "x", role: "member" },
    { id: BOB, email: "bob-gw@example.com", passwordHash: "x", role: "member" },
  ]);
  app = await buildServer();
  await app.ready();
  costLogStore.record({
    ts: new Date().toISOString(),
    model: "groq/llama-3.3-70b-versatile",
    inputTokens: 1000,
    outputTokens: 1000,
    costUsd: 0.5,
    userId: ALICE,
  });
}, 120_000);
afterAll(async () => {
  await app?.close();
  await closePgPools();
});

describe("gateway spend is per account", () => {
  it("reports only the caller's spend", async () => {
    const alice = await app.inject({ url: "/api/v1/gateway/cost-report", headers: as(ALICE) });
    const bob = await app.inject({ url: "/api/v1/gateway/cost-report", headers: as(BOB) });
    expect(alice.json<{ totalUsd: number }>().totalUsd).toBe(0.5);
    expect(bob.json<{ totalUsd: number; totalRuns: number }>()).toMatchObject({
      totalUsd: 0,
      totalRuns: 0,
    });
  });

  it("caps on the caller's own spend only", async () => {
    const send = (userId: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/gateway/messages",
        headers: as(userId),
        payload: {
          model: "no-such-provider/model",
          messages: [{ role: "user", content: "hi" }],
          max_spend_usd: 0.25,
        },
      });
    expect((await send(ALICE)).statusCode).toBe(402);
    expect((await send(BOB)).statusCode).not.toBe(402);
  });
});
