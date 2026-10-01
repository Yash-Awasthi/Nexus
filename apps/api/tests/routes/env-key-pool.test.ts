// SPDX-License-Identifier: Apache-2.0
/** Extra server keys for a provider join the failover chain as their own entries, one per key. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:env-key-pool";
const SECRET = "env-key-pool-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "2b".repeat(32);
process.env.NEXUS_DESKTOP = "1";
for (const k of Object.keys(process.env)) if (/_API_KEYS?$/.test(k)) delete process.env[k];
process.env.GROQ_API_KEY = "gsk-one";
process.env.GROQ_API_KEYS = "gsk-two, gsk-three,gsk-one";

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

it("registers each distinct key as its own chain entry", async () => {
  const r = await app.inject({ method: "GET", url: "/v1/models", headers: auth });
  const providers = r.json<{ data: { id: string }[] }>().data.map((m) => m.id.split("/")[0]);
  expect(providers.filter((p) => p!.startsWith("groq"))).toEqual(["groq", "groq#2", "groq#3"]);
});
