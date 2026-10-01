// SPDX-License-Identifier: Apache-2.0
/** Instance-wide settings and operator surfaces change only for an admin. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SECRET = "admin-config-guards-secret";
const DB = "pglite://:memory:admin-config-guards";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.DATABASE_URL = DB;

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

const call = (method: "POST" | "DELETE", url: string, user: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${tokenFor(user)}` }, payload });

describe("instance settings", () => {
  it("keep the instance-wide usage analytics to an admin", async () => {
    const get = (url: string, user: string) =>
      app.inject({ method: "GET", url, headers: { authorization: `Bearer ${tokenFor(user)}` } });
    for (const url of [
      "/api/analytics/daily?days=7",
      "/api/analytics/providers",
      "/api/analytics/models",
      "/api/system/metrics",
    ]) {
      expect((await get(url, MEMBER)).statusCode, url).toBe(403);
      expect((await get(url, ADMIN)).statusCode, url).toBe(200);
    }
  });

  it("keep the gateway admin surface to an admin", async () => {
    const get = (url: string, user: string) =>
      app.inject({ method: "GET", url, headers: { authorization: `Bearer ${tokenFor(user)}` } });
    for (const url of [
      "/api/v1/admin/routes",
      "/api/v1/admin/stats",
      "/api/v1/admin/settings",
      "/api/v1/admin/traces",
      "/api/v1/admin/traces/stats",
    ]) {
      expect((await get(url, MEMBER)).statusCode, url).toBe(403);
      expect((await get(url, ADMIN)).statusCode, url).toBe(200);
    }
    const hijack = { alias: "nexus/fast", model: "attacker-model", provider: "groq" };
    expect((await call("POST", "/api/v1/admin/routes", MEMBER, hijack)).statusCode).toBe(403);
    expect((await call("DELETE", "/api/v1/admin/traces", MEMBER)).statusCode).toBe(403);
  });

  it("keep operator surfaces to an admin", async () => {
    const as = (method: string, url: string, user: string, payload?: object) =>
      app.inject({
        method: method as "GET",
        url,
        headers: { authorization: `Bearer ${tokenFor(user)}` },
        ...(payload ? { payload } : {}),
      });
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/system/diagnostics" })).statusCode,
    ).toBe(401);
    for (const [method, url, payload] of [
      ["GET", "/api/v1/system/diagnostics"],
      ["GET", "/api/v1/mail-ingest/status"],
      ["GET", "/api/v1/mail-ingest/messages"],
      ["GET", "/api/v1/alerts/rules"],
      ["GET", "/api/v1/alerts/history"],
      ["POST", "/api/v1/alerts/evaluate", { metric: "task.errors", value: 1 }],
      ["GET", "/api/v1/hooks/log"],
      ["GET", "/api/v1/hooks/handlers"],
      ["POST", "/api/v1/hooks/emit", { event: "agent.observe" }],
      ["PATCH", "/api/v1/feature-flags/any", { value: true }],
      ["DELETE", "/api/v1/feature-flags/any"],
    ] as [string, string, object?][]) {
      expect((await as(method, url, MEMBER, payload)).statusCode, `${method} ${url}`).toBe(403);
    }
    for (const url of ["/api/v1/system/diagnostics", "/api/v1/alerts/rules", "/api/v1/hooks/log"])
      expect((await as("GET", url, ADMIN)).statusCode, url).toBe(200);
  });

  it("count only the caller's own tokens in token usage", async () => {
    const { costLogStore } = await import("../../src/lib/cost-log.js");
    costLogStore.record({
      ts: new Date().toISOString(),
      model: "groq/secret-model",
      inputTokens: 500,
      outputTokens: 500,
      costUsd: 0,
      userId: ADMIN,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/token-usage",
      headers: { authorization: `Bearer ${tokenFor(MEMBER)}` },
    });
    expect(res.json<{ used: number; byModel: object }>()).toMatchObject({ used: 0, byModel: {} });
  });
});
