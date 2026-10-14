// SPDX-License-Identifier: Apache-2.0
/** NX-SEC-017: a one-time token works once even under concurrency; a replayed refresh token ends the account's sessions. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:auth-token-reuse";
process.env.NEXUS_JWT_SECRET = "auth-token-reuse-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-reuse-"));
process.env.NEXUS_REFRESH_REUSE_GRACE_MS = "-1";

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { authUsersRoutes } = await import("../../src/routes/auth-users.ts");

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

it("redeems a reset token once when two requests race", async () => {
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "race@example.com", password: "Race-pass-1!" },
  });
  const forgot = await app.inject({
    method: "POST",
    url: "/api/v1/auth/forgot-password",
    payload: { email: "race@example.com" },
  });
  const token = forgot.json<{ resetToken: string }>().resetToken;
  const [a, b] = await Promise.all(
    ["First-new-pass-1!", "Second-new-pass-2!"].map((password) =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/reset-password",
        payload: { token, password },
      }),
    ),
  );
  expect([a!.statusCode, b!.statusCode].sort()).toEqual([200, 400]);
});

it("treats a replayed refresh token as theft and ends every session", async () => {
  const reg = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "replay@example.com", password: "Replay-pass-1!" },
  });
  const first = reg.json<{ refreshToken: string }>().refreshToken;

  const rotated = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { refreshToken: first },
  });
  expect(rotated.statusCode).toBe(200);
  const { refreshToken: second, accessToken } = rotated.json<{
    refreshToken: string;
    accessToken: string;
  }>();

  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { refreshToken: first },
  });
  expect(replay.statusCode).toBe(401);

  const victimRefresh = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { refreshToken: second },
  });
  expect(victimRefresh.statusCode).toBe(401);
  const me = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(me.statusCode).toBe(401);
});

it("does not end sessions when two tabs refresh at the same moment", async () => {
  process.env.NEXUS_REFRESH_REUSE_GRACE_MS = "60000";
  const reg = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "tabs@example.com", password: "Tabs-pass-1!" },
  });
  const first = reg.json<{ refreshToken: string }>().refreshToken;
  const winner = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { refreshToken: first },
  });
  const loser = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { refreshToken: first },
  });
  expect(loser.statusCode).toBe(401);
  const next = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { refreshToken: winner.json<{ refreshToken: string }>().refreshToken },
  });
  expect(next.statusCode).toBe(200);
  process.env.NEXUS_REFRESH_REUSE_GRACE_MS = "-1";
});
