// SPDX-License-Identifier: Apache-2.0
/**
 * A submitted runtime task is handed to the worker queue. Only job types that are safe to start
 * from a bare API call are accepted: agent runs go through /agent/run and its approval.
 */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:runtime-tasks-run";
const SECRET = "runtime-tasks-run-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "cd".repeat(32);
process.env.NEXUS_DESKTOP = "1";
delete process.env.REDIS_URL;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { getPgPool } = await import("../../src/lib/pg-pool.js");
const { buildServer } = await import("../../src/server.js");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

let app: FastifyInstance;
const auth = { authorization: `Bearer ${tokenFor(crypto.randomUUID())}` };

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = await buildServer();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
});

it("refuses job types that must go through their own gated route", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/runtime/tasks",
    headers: auth,
    payload: { type: "agent.run", payload: { instruction: "rm -rf /" } },
  });
  expect(r.statusCode, r.body).toBe(400);
  expect(r.json().error).toMatch(/council\.deliberate/);
});

it("fails a task at once, with the reason, when no worker queue is configured", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/runtime/tasks",
    headers: auth,
    payload: { type: "ingest:event", payload: {} },
  });
  expect(r.statusCode, r.body).toBe(201);
  const task = r.json<{ id: string; status: string; error: string }>();
  expect(task.status).toBe("failed");
  expect(task.error).toMatch(/REDIS_URL/);
});
