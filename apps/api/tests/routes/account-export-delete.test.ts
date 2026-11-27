// SPDX-License-Identifier: Apache-2.0
/**
 * Portability and erasure are the same feature from two ends: an account can leave with what it put in, and
 * deletion answers with a receipt that names what it kept and why.
 *
 * The tests below drive both routes over HTTP against embedded Postgres. The interesting assertions are the
 * *absences*: no password hash, no refresh token hash, no provider key material or prefix, and no other
 * account's rows in the archive. A positive-only test would pass on a route that dumped the whole table.
 */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

const DB = "pglite://:memory:account-export";
process.env.NEXUS_JWT_SECRET = "account-export-secret";
process.env.DATABASE_URL = DB;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { buildServer } = await import("../../src/server.ts");
const { scrubSecrets, RETAINED_AFTER_DELETION, exportFilename } =
  await import("../../src/lib/user-export.ts");

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

const PASSWORD = "correct horse battery staple";

async function account(email: string) {
  const reg = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: PASSWORD },
  });
  expect(reg.statusCode, reg.body).toBe(201);
  const { accessToken, user } = reg.json<{ accessToken: string; user: { id: string } }>();
  const headers = { authorization: `Bearer ${accessToken}` };

  const key = await app.inject({
    method: "POST",
    url: "/api/user/provider-keys",
    headers,
    payload: { provider: "groq", apiKey: `gsk_${crypto.randomBytes(20).toString("hex")}` },
  });
  expect(key.statusCode, key.body).toBeLessThan(400);

  await app.inject({
    method: "POST",
    url: "/api/settings/preferences",
    headers,
    payload: { theme: "dark", piiDetection: true },
  });
  return { id: user.id, email, headers };
}

const body = <T>(response: { body: string }): T =>
  response.body && (JSON.parse(response.body) as T);

it("returns one archive of what the account owns, and only that", async () => {
  const mine = await account("mine@example.com");
  const other = await account("other@example.com");

  const response = await app.inject({
    method: "GET",
    url: `/api/v1/users/${mine.id}/export`,
    headers: mine.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers["content-disposition"]).toContain(exportFilename(mine.id).slice(0, 20));

  const archive = body<{
    account: { id: string; email: string };
    sessions: { id: string }[];
    providerKeys: { provider: string }[];
    storedRecords: { collection: string; data: unknown }[];
    retained: { what: string; why: string }[];
  }>(response);

  expect(archive.account.id).toBe(mine.id);
  expect(archive.account.email).toBe("mine@example.com");
  expect(archive.sessions.length).toBeGreaterThan(0);
  expect(archive.providerKeys.map((key) => key.provider)).toContain("groq");
  expect(archive.retained.length).toBe(RETAINED_AFTER_DELETION.length);

  // No secrets, and nothing that belongs to the other account.
  expect(response.body).not.toContain(PASSWORD);
  expect(response.body).not.toContain("$2b$");
  expect(response.body).not.toContain(other.id);
  expect(response.body).not.toContain("other@example.com");
  // A provider key is represented by name and date, never by its prefix.
  expect(
    archive.providerKeys.every((key) => Object.keys(key).sort().join() === "createdAt,provider"),
  ).toBe(true);
});

it("refuses to export or erase an account that is not the caller's", async () => {
  const mine = await account("self@example.com");
  const other = await account("victim@example.com");

  const exported = await app.inject({
    method: "GET",
    url: `/api/v1/users/${other.id}/export`,
    headers: mine.headers,
  });
  expect(exported.statusCode).toBe(403);

  const erased = await app.inject({
    method: "DELETE",
    url: `/api/v1/users/${other.id}/data`,
    headers: mine.headers,
  });
  expect(erased.statusCode).toBe(403);

  const survivors = await getPgPool(DB)!.query(`SELECT 1 FROM users WHERE id = $1`, [other.id]);
  expect(survivors.rowCount).toBe(1);
});

it("deletes every durable row and answers with a receipt naming what was kept", async () => {
  const gone = await account("delete-me@example.com");

  // Take the archive first, so the chain carries both halves of the promise.
  const exported = await app.inject({
    method: "GET",
    url: `/api/v1/users/${gone.id}/export`,
    headers: gone.headers,
  });
  expect(exported.statusCode, exported.body).toBe(200);

  const response = await app.inject({
    method: "DELETE",
    url: `/api/v1/users/${gone.id}/data`,
    headers: gone.headers,
  });
  expect(response.statusCode, response.body).toBe(200);

  const receipt = body<{
    erased: { table: string; deleted: number }[];
    retained: { what: string; why: string }[];
  }>(response);
  expect(receipt.erased.length).toBeGreaterThan(0);
  expect(receipt.erased.some((row) => row.deleted > 0)).toBe(true);
  expect(receipt.retained).toEqual(RETAINED_AFTER_DELETION);
  for (const item of receipt.retained) expect(item.why.length).toBeGreaterThan(40);

  const rows = await getPgPool(DB)!.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM users WHERE id = $1)
          + (SELECT count(*) FROM user_provider_credentials WHERE user_id = $1)
          + (SELECT count(*) FROM refresh_tokens WHERE user_id = $1) AS n`,
    [gone.id],
  );
  expect(Number(rows.rows[0]!.n)).toBe(0);

  // The receipt is evidence: both halves are in the chain.
  const audit = await getPgPool(DB)!.query<{ action: string }>(
    `SELECT action FROM audit_log WHERE actor = $1 AND action LIKE 'account.%' ORDER BY sequence`,
    [gone.id],
  );
  expect(audit.rows.map((row) => row.action)).toEqual(["account.exported", "account.erased"]);
});

it("scrubs credential-shaped fields by name, and keeps the shape", () => {
  const scrubbed = scrubSecrets({
    provider: "groq",
    apiKey: "gsk_live",
    nested: { refreshToken: "abc", model: "llama" },
    list: [{ password: "hunter2", label: "prod" }],
  }) as Record<string, unknown>;
  expect(scrubbed.provider).toBe("groq");
  expect(scrubbed.apiKey).toBe("[REDACTED]");
  expect((scrubbed.nested as Record<string, unknown>).model).toBe("llama");
  expect((scrubbed.nested as Record<string, unknown>).refreshToken).toBe("[REDACTED]");
  expect(((scrubbed.list as Record<string, unknown>[])[0] ?? {}).label).toBe("prod");
});
