// SPDX-License-Identifier: Apache-2.0
/** A rating given on an answer is kept, stays its owner's, and shows in the admin overview. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const SECRET = "rlhf-feedback-secret";
const DB = "pglite://:memory:rlhf-feedback";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.DATABASE_URL = DB;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.js");
const { buildServer } = await import("../../src/server.js");
const { db } = await import("@nexus/db");
const { users } = await import("@nexus/db/schema");

const ADMIN = crypto.randomUUID();
const RATER = crypto.randomUUID();

function as(userId: string, role = "agent") {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role, iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return { authorization: `Bearer ${head}.${body}.${sig}` };
}

let app: FastifyInstance;
beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  await db.insert(users).values([
    { id: ADMIN, email: "admin-rl@example.com", passwordHash: "x", role: "admin" },
    { id: RATER, email: "rater-rl@example.com", passwordHash: "x", role: "member" },
  ]);
  app = await buildServer();
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await closePgPools();
});

it("keeps a rating, for its owner only, and counts it for the admin", async () => {
  const rated = await app.inject({
    method: "POST",
    url: "/api/v1/rlhf/feedback",
    headers: as(RATER),
    payload: {
      sessionId: "s1",
      messageId: "m1",
      promptText: "What is 2+2?",
      responseText: "4",
      model: "council",
      rating: "thumbs_up",
      source: "ui",
    },
  });
  expect(rated.statusCode, rated.body).toBe(201);

  const { rows } = await getPgPool(DB)!.query(
    "SELECT data FROM nexus_kv WHERE collection = 'rlhf_feedback'",
  );
  expect(rows).toHaveLength(1);

  const mine = await app.inject({ url: "/api/v1/rlhf/feedback", headers: as(RATER) });
  expect(mine.json<{ total: number }>().total).toBe(1);
  const theirs = await app.inject({ url: "/api/v1/rlhf/feedback", headers: as(ADMIN, "admin") });
  expect(theirs.json<{ total: number }>().total).toBe(0);

  const stats = await app.inject({ url: "/api/feedback/stats", headers: as(ADMIN, "admin") });
  expect(stats.json()).toMatchObject({
    totalFeedback: 1,
    positiveCount: 1,
    negativeCount: 0,
    positiveRate: 1,
  });
  expect(stats.json<{ recentTrend: { positive: number }[] }>().recentTrend.at(-1)?.positive).toBe(
    1,
  );
});
