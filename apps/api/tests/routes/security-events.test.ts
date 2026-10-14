// SPDX-License-Identifier: Apache-2.0
/** NX-FEAT-003 / 005: changes to how someone gets into an account reach its owner and the audit log. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:security-events";
process.env.NEXUS_JWT_SECRET = "security-events-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sec-events-"));

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { authUsersRoutes } = await import("../../src/routes/auth-users.ts");
const { listNotifications } = await import("../../src/lib/notifications-store.ts");

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

const titles = async (userId: string) =>
  (await listNotifications(userId)).notifications.map((n) => n.title);

it("tells the owner about a sign-in from a new device, not a known one", async () => {
  const creds = { email: "owner@example.com", password: "Owner-pass-1!" };
  const reg = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers: { "user-agent": "laptop" },
    payload: creds,
  });
  const userId = reg.json<{ user: { id: string } }>().user.id;

  await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "user-agent": "laptop" },
    payload: creds,
  });
  expect(await titles(userId)).not.toContain("New sign-in to your account");

  await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "user-agent": "unknown-phone" },
    payload: creds,
  });
  expect(await titles(userId)).toContain("New sign-in to your account");
});

it("tells the owner when the password, email or sessions change", async () => {
  const creds = { email: "changes@example.com", password: "Changes-pass-1!" };
  const reg = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: creds });
  const { accessToken, user } = reg.json<{ accessToken: string; user: { id: string } }>();
  const auth = { authorization: `Bearer ${accessToken}` };

  await app.inject({
    method: "PATCH",
    url: "/api/v1/auth/me",
    headers: auth,
    payload: { email: "changed@example.com" },
  });
  await app.inject({ method: "POST", url: "/api/v1/auth/sessions/revoke-all", headers: auth });
  const forgot = await app.inject({
    method: "POST",
    url: "/api/v1/auth/forgot-password",
    payload: { email: "changed@example.com" },
  });
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/reset-password",
    payload: { token: forgot.json<{ resetToken: string }>().resetToken, password: "New-pass-22!" },
  });

  expect(await titles(user.id)).toEqual(
    expect.arrayContaining([
      "Your sign-in email was changed",
      "You were signed out everywhere",
      "Your password was changed",
    ]),
  );
});
