// SPDX-License-Identifier: Apache-2.0
/** The Memory page and /api/v1/memory (the CLI, agents) see the same memories, and only the owner's. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const SECRET = "memory-one-store-secret";
const DB = "pglite://:memory:memory-one-store";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.DATABASE_URL = DB;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { buildServer } = await import("../../src/server.ts");

function auth(userId: string) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return { authorization: `Bearer ${head}.${body}.${sig}` };
}

let app: FastifyInstance;
beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = await buildServer();
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app.close();
  await closePgPools();
});

const texts = (r: { json: () => unknown }) => JSON.stringify(r.json());

it("shows each surface's memories on the other, to the owner only", async () => {
  const alice = auth(crypto.randomUUID());
  const bob = auth(crypto.randomUUID());
  await app.inject({
    method: "POST",
    url: "/api/v1/memory",
    headers: alice,
    payload: { text: "The staging database lives in Frankfurt." },
  });
  await app.inject({
    method: "POST",
    url: "/api/memory/entries",
    headers: alice,
    payload: { content: "Deploys freeze on Fridays after noon." },
  });

  const page = await app.inject({
    method: "GET",
    url: "/api/memory/entries?limit=20",
    headers: alice,
  });
  expect(texts(page)).toContain("Frankfurt");
  expect(texts(page)).toContain("Fridays");

  const v1 = await app.inject({ method: "GET", url: "/api/v1/memory?limit=20", headers: alice });
  expect(texts(v1)).toContain("Frankfurt");
  expect(texts(v1)).toContain("Fridays");

  const searched = await app.inject({
    method: "GET",
    url: `/api/memory/entries?limit=5&query=${encodeURIComponent("staging database")}`,
    headers: alice,
  });
  expect(texts(searched)).toContain("Frankfurt");
  expect(texts(searched)).not.toContain("embedding");

  const other = await app.inject({
    method: "GET",
    url: "/api/memory/entries?limit=20",
    headers: bob,
  });
  expect(texts(other)).not.toContain("Frankfurt");
  expect(texts(other)).not.toContain("Fridays");
});
