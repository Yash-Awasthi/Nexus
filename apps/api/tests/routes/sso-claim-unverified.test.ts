// SPDX-License-Identifier: Apache-2.0
/**
 * NX-SEC-003: whoever registered an address without proving it must not keep
 * a way in once the address's real owner signs in through an identity provider.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const DB = "pglite://:memory:sso-claim-unverified";
process.env.NEXUS_JWT_SECRET = "sso-claim-unverified-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sso-claim-"));
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { authUsersRoutes } = await import("../../src/routes/auth-users.ts");
const { oauthRoutes } = await import("../../src/routes/oauth.ts");

let app: FastifyInstance;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = Fastify();
  await app.register(authUsersRoutes, { prefix: "/api/v1" });
  await app.register(oauthRoutes, { prefix: "/api/v1" });
  await app.ready();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  await app.close();
  await closePgPools();
});

async function googleSignIn(email: string): Promise<{ userId: string }> {
  const start = await app.inject({ method: "GET", url: "/api/v1/oauth/google" });
  const state = new URL(start.headers.location as string).searchParams.get("state")!;
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://oauth2.googleapis.com/token"))
      return Response.json({ access_token: "google-access" });
    if (url.startsWith("https://www.googleapis.com/oauth2/v3/userinfo"))
      return Response.json({ sub: "g-123", email, email_verified: true, name: "Owner" });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/oauth/google/callback?code=c&state=${state}`,
    headers: { accept: "application/json" },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ userId: string }>();
}

it("takes every other way in away from an unverified account the real owner signs in to", async () => {
  const squat = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "owner@example.com", password: "Squatter-pass-1!" },
  });
  expect(squat.statusCode, squat.body).toBe(201);
  const squatter = squat.json<{ refreshToken: string; user: { id: string } }>();

  const signedIn = await googleSignIn("owner@example.com");
  expect(signedIn.userId).toBe(squatter.user.id);

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "owner@example.com", password: "Squatter-pass-1!" },
  });
  expect(login.statusCode).toBe(401);

  const refresh = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { refreshToken: squatter.refreshToken },
  });
  expect(refresh.statusCode).toBe(401);
});

it("leaves a verified account's password alone", async () => {
  const reg = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "verified@example.com", password: "Verified-pass-1!" },
  });
  const auth = { authorization: `Bearer ${reg.json<{ accessToken: string }>().accessToken}` };
  const sent = await app.inject({
    method: "POST",
    url: "/api/v1/auth/send-verification",
    headers: auth,
  });
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify-email",
    payload: { token: sent.json<{ verifyToken: string }>().verifyToken },
  });

  await googleSignIn("verified@example.com");

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "verified@example.com", password: "Verified-pass-1!" },
  });
  expect(login.statusCode).toBe(200);
});
