// SPDX-License-Identifier: Apache-2.0
/** Erasing an account also removes what it kept in the key-value stores, and only that. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:erase-kv-data";
process.env.NEXUS_JWT_SECRET = "erase-kv-data-secret";
process.env.DATABASE_URL = DB;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { buildServer } = await import("../../src/server.ts");

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

async function account(email: string) {
  const password = crypto.randomUUID();
  const reg = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password },
  });
  expect(reg.statusCode, reg.body).toBe(201);
  const { accessToken, user } = reg.json<{ accessToken: string; user: { id: string } }>();
  const headers = { authorization: `Bearer ${accessToken}` };
  const kb = await app.inject({
    method: "POST",
    url: "/api/kb",
    headers,
    payload: { name: `KB of ${email}` },
  });
  expect(kb.statusCode, kb.body).toBe(201);
  const prefs = await app.inject({
    method: "POST",
    url: "/api/settings/preferences",
    headers,
    payload: { theme: "dark" },
  });
  expect(prefs.statusCode, prefs.body).toBe(200);
  return { id: user.id, headers };
}

const owned = async (uid: string) =>
  (
    await getPgPool(DB)!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM nexus_kv
       WHERE id = $1 OR id LIKE $1 || '::%' OR data->>'ownerId' = $1 OR data->>'userId' = $1`,
      [uid],
    )
  ).rows[0]!.n;

it("removes the erased account's stored records and keeps everyone else's", async () => {
  const gone = await account("gone@example.com");
  const kept = await account("kept@example.com");
  await new Promise((r) => setTimeout(r, 200));
  expect(await owned(gone.id)).toBeGreaterThan(0);

  const erase = await app.inject({
    method: "DELETE",
    url: `/api/v1/users/${gone.id}/data`,
    headers: gone.headers,
  });
  expect(erase.statusCode, erase.body).toBe(204);

  expect(await owned(gone.id)).toBe(0);
  expect(await owned(kept.id)).toBeGreaterThan(0);
  const list = await app.inject({ method: "GET", url: "/api/kb?limit=50", headers: kept.headers });
  expect(list.body).toContain("KB of kept@example.com");
  expect(list.body).not.toContain("KB of gone@example.com");
}, 60_000);
