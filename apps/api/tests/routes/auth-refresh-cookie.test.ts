// SPDX-License-Identifier: Apache-2.0
/** The browser's refresh token lives in an httpOnly cookie, and each one works once. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:auth-refresh-cookie";
process.env.NEXUS_JWT_SECRET = "auth-refresh-cookie-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-auth-cookie-"));

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

const cookieOf = (res: { headers: Record<string, unknown> }) => {
  const set = String(res.headers["set-cookie"] ?? "");
  return { set, value: /nexus_refresh=([^;]*)/.exec(set)?.[1] ?? "" };
};

it("sets the refresh cookie on sign-in and rotates it without putting it in the body", async () => {
  const reg = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "cookie@example.com", password: "Cookie-pass-1!", name: "c" },
  });
  expect(reg.statusCode).toBe(201);
  const first = cookieOf(reg);
  expect(first.set).toMatch(/HttpOnly/);
  expect(first.set).toMatch(/SameSite=Strict/);
  expect(first.set).toMatch(/Path=\/api\/v1\/auth/);
  expect(first.value).not.toBe("");

  const refreshed = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    headers: { cookie: `nexus_refresh=${first.value}` },
    payload: {},
  });
  expect(refreshed.statusCode).toBe(200);
  expect(refreshed.json()).toHaveProperty("accessToken");
  expect(refreshed.json()).not.toHaveProperty("refreshToken");
  const second = cookieOf(refreshed);
  expect(second.value).not.toBe(first.value);

  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    headers: { cookie: `nexus_refresh=${first.value}` },
    payload: {},
  });
  expect(replay.statusCode).toBe(401);

  const out = await app.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: { cookie: `nexus_refresh=${second.value}` },
    payload: {},
  });
  expect(out.statusCode).toBe(204);
  expect(cookieOf(out).set).toMatch(/Max-Age=0/);
  const after = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    headers: { cookie: `nexus_refresh=${second.value}` },
    payload: {},
  });
  expect(after.statusCode).toBe(401);
});
