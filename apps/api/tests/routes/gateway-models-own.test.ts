// SPDX-License-Identifier: Apache-2.0
/** The gateway's model list offers the models the caller saved keys for. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const SECRET = "gateway-models-own-secret";
const DB = "pglite://:memory:gateway-models-own-test";
process.env.NEXUS_JWT_SECRET = SECRET;
delete process.env.OPENROUTER_API_KEY;
process.env.DATABASE_URL = DB;
process.env.NEXUS_SECRETS_KEY = "ab".repeat(32);
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gateway-models-own-"));

const { buildServer } = await import("../../src/server.js");
const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.js");
const { db } = await import("@nexus/db");
const { users } = await import("@nexus/db/schema");

async function newUser(): Promise<{ authorization: string }> {
  const id = crypto.randomUUID();
  await db.insert(users).values({ id, email: `${id}@example.com`, passwordHash: "x" });
  return { authorization: `Bearer ${tokenFor(id)}` };
}

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

let app: FastifyInstance;
beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await closePgPools();
});

it("lists each saved model as provider/model", async () => {
  const headers = await newUser();
  const saved = await app.inject({
    method: "POST",
    url: "/api/user/provider-keys",
    headers,
    payload: {
      provider: "harbor",
      apiKey: "hb_test_key_0123456789",
      baseUrl: "https://harbor.invalid/v1",
      models: ["qwen-flash:free", "mimo-flash:free"],
    },
  });
  expect(saved.statusCode, saved.body).toBeLessThan(300);

  const res = await app.inject({ method: "GET", url: "/api/v1/gateway/models", headers });

  expect(res.statusCode).toBe(200);
  expect(res.headers["cache-control"]).toContain("private");
  const { models } = res.json<{ models: { id: string; available: boolean }[] }>();
  expect(models.filter((m) => m.id.startsWith("harbor/"))).toEqual([
    expect.objectContaining({ id: "harbor/qwen-flash:free", available: true }),
    expect.objectContaining({ id: "harbor/mimo-flash:free", available: true }),
  ]);
});
