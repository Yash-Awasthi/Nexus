// SPDX-License-Identifier: Apache-2.0
/** A verification link proves the address it was sent to, not whatever the account holds later. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:auth-verify-email";
process.env.NEXUS_JWT_SECRET = "auth-verify-email-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-auth-verify-"));

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.js");
const { authUsersRoutes } = await import("../../src/routes/auth-users.js");

let app: FastifyInstance;

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = Fastify();
  await app.register(authUsersRoutes, { prefix: "/api/v1" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePgPools();
});

it("does not verify a changed email with the old address's token", async () => {
  const reg = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "old@example.com", password: "Verify-pass-1!" },
  });
  expect(reg.statusCode, reg.body).toBe(201);
  const auth = { authorization: `Bearer ${reg.json<{ accessToken: string }>().accessToken}` };

  const sent = await app.inject({
    method: "POST",
    url: "/api/v1/auth/send-verification",
    headers: auth,
  });
  expect(sent.statusCode, sent.body).toBe(200);
  const { verifyToken } = sent.json<{ verifyToken: string }>();

  const moved = await app.inject({
    method: "PATCH",
    url: "/api/v1/auth/me",
    headers: auth,
    payload: { email: "new@example.com" },
  });
  expect(moved.statusCode, moved.body).toBe(200);

  const redeem = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify-email",
    payload: { token: verifyToken },
  });
  expect(redeem.statusCode, redeem.body).toBe(400);
  const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: auth });
  expect(me.json<{ email: string; emailVerified: boolean }>()).toMatchObject({
    email: "new@example.com",
    emailVerified: false,
  });
});
