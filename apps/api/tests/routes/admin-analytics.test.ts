// SPDX-License-Identifier: Apache-2.0
/** The admin overview reports the instance's accounts and model spend, not numbers it lacks. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

const SECRET = "admin-analytics-secret";
const DB = "pglite://:memory:admin-analytics";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.DATABASE_URL = DB;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { buildServer } = await import("../../src/server.ts");
const { costLogStore } = await import("../../src/lib/cost-log.ts");
const { db } = await import("@nexus/db");
const { users } = await import("@nexus/db/schema");

const ADMIN = crypto.randomUUID();
const MEMBER = crypto.randomUUID();

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
    { id: ADMIN, email: "admin-an@example.com", passwordHash: "x", role: "admin" },
    { id: MEMBER, email: "member-an@example.com", passwordHash: "x", role: "member" },
  ]);
  app = await buildServer();
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await closePgPools();
});

it("counts accounts and sums model spend", async () => {
  const before = await app.inject({
    url: "/api/analytics/overview",
    headers: { authorization: `Bearer ${tokenFor(ADMIN)}` },
  });
  costLogStore.record({
    ts: new Date().toISOString(),
    model: "groq/x",
    inputTokens: 10,
    outputTokens: 10,
    costUsd: 1.25,
  });
  const after = await app.inject({
    url: "/api/analytics/overview",
    headers: { authorization: `Bearer ${tokenFor(ADMIN)}` },
  });
  expect(after.json<{ totalUsers: number }>().totalUsers).toBe(2);
  expect(
    after.json<{ costUsd: number }>().costUsd - before.json<{ costUsd: number }>().costUsd,
  ).toBeCloseTo(1.25);
});

it("reports the organization's spend and seats to an admin only", async () => {
  const headers = { authorization: `Bearer ${tokenFor(ADMIN)}` };
  const read = async () =>
    (await app.inject({ url: "/api/costs/organization", headers })).json<{
      totalUsd: number;
      seats: number;
    }>();
  const before = await read();
  for (const userId of [crypto.randomUUID(), crypto.randomUUID()])
    costLogStore.record({
      ts: new Date().toISOString(),
      model: "groq/x",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.5,
      userId,
    });
  const after = await read();
  expect(after.seats - before.seats).toBe(2);
  expect(after.totalUsd - before.totalUsd).toBeCloseTo(1);

  const member = await app.inject({
    url: "/api/costs/organization",
    headers: { authorization: `Bearer ${tokenFor(MEMBER)}` },
  });
  expect(member.statusCode).toBe(403);
});

it("reports unknown latency as null when the traffic log cannot answer", async () => {
  // A `0` p50 would claim every request finished in zero milliseconds; the log
  // being unreachable means the number is unknown, and the page renders a dash.
  const Fastify = (await import("fastify")).default;
  const { analyticsRoutes } = await import("../../src/routes/analytics.ts");
  const bare = Fastify();
  await bare.register(
    async (scoped) =>
      analyticsRoutes(scoped, {
        costLog: [],
        gatewayLog: {
          stats: async () => {
            throw new Error("no KV mounted");
          },
        },
      }),
    { prefix: "/api" },
  );
  await bare.ready();

  const res = await bare.inject({
    url: "/api/analytics/overview",
    headers: { authorization: `Bearer ${tokenFor(ADMIN)}` },
  });
  await bare.close();

  expect(res.statusCode).toBe(200);
  const body = res.json<{
    latencyP50ms: number | null;
    latencyP99ms: number | null;
    errorRate: number | null;
    source: string;
    requests: number;
  }>();
  expect(body.source).toBe("cost-log");
  expect(body.latencyP50ms).toBeNull();
  expect(body.latencyP99ms).toBeNull();
  expect(body.errorRate).toBeNull();
  expect(body.requests).toBe(0);
});
