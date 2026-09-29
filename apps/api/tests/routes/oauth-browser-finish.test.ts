// SPDX-License-Identifier: Apache-2.0
/**
 * A browser that finishes OAuth sign-in lands in the app with the refresh token
 * in its httpOnly cookie; the desktop app, which fetches the callback itself,
 * still gets the tokens as JSON.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const DB = "pglite://:memory:oauth-browser-finish";
process.env.NEXUS_JWT_SECRET = "oauth-browser-finish-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-oauth-finish-"));
process.env.GITHUB_CLIENT_ID = "gh-client";
process.env.GITHUB_CLIENT_SECRET = "gh-secret";

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.js");
const { authUsersRoutes } = await import("../../src/routes/auth-users.js");
const { oauthRoutes } = await import("../../src/routes/oauth.js");

const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
let app: FastifyInstance;

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = Fastify();
  await app.register(authUsersRoutes, { prefix: "/api/v1" });
  await app.register(oauthRoutes, { prefix: "/api/v1" });
  await app.ready();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await app.close();
  await closePgPools();
});

/** Answer GitHub's token and user endpoints as a successful sign-in would. */
function stubGitHub(login: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).includes("access_token")
        ? Response.json({ access_token: "gh-token" })
        : Response.json({ id: 1, login, email: `${login}@example.com`, name: login }),
    ),
  );
}

async function freshState(): Promise<string> {
  const start = await app.inject({ method: "GET", url: "/api/v1/oauth/github" });
  return new URL(String(start.headers.location)).searchParams.get("state")!;
}

it("sends a browser into the app with the refresh cookie and no token in the URL", async () => {
  stubGitHub("browser-user");
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/oauth/github/callback?code=c&state=${await freshState()}`,
    headers: { accept: BROWSER },
  });

  expect(res.statusCode).toBe(302);
  const location = String(res.headers.location);
  expect(location).toBe("/login?signed_in=1");
  const cookie = String(res.headers["set-cookie"] ?? "");
  expect(cookie).toMatch(/HttpOnly/);
  const refresh = /nexus_refresh=([^;]+)/.exec(cookie)?.[1];
  expect(refresh).toBeTruthy();
  expect(res.body).not.toContain(refresh);

  vi.unstubAllGlobals();
  const exchanged = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    headers: { cookie: `nexus_refresh=${refresh}` },
    payload: {},
  });
  expect(exchanged.statusCode).toBe(200);
  expect(exchanged.json()).toHaveProperty("accessToken");
});

it("still answers the desktop app's own fetch of the callback with JSON", async () => {
  stubGitHub("desktop-user");
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/oauth/github/callback?code=c&state=${await freshState()}`,
    headers: { accept: "*/*" },
  });

  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ provider: "github", email: "desktop-user@example.com" });
  expect(res.json()).toHaveProperty("refreshToken");
  expect(res.headers["set-cookie"]).toBeUndefined();
});

it("sends a browser back to the sign-in page with the reason when sign-in fails", async () => {
  const denied = await app.inject({
    method: "GET",
    url: "/api/v1/oauth/github/callback?error=access_denied",
    headers: { accept: BROWSER },
  });
  expect(denied.statusCode).toBe(302);
  expect(denied.headers.location).toBe("/login?error=access_denied");

  const replayed = await app.inject({
    method: "GET",
    url: "/api/v1/oauth/github/callback?code=c&state=never-issued",
    headers: { accept: BROWSER },
  });
  expect(replayed.headers.location).toBe("/login?error=invalid_state");

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "bad_verification_code" })),
  );
  const refused = await app.inject({
    method: "GET",
    url: `/api/v1/oauth/github/callback?code=c&state=${await freshState()}`,
    headers: { accept: BROWSER },
  });
  expect(refused.headers.location).toBe("/login?error=bad_verification_code");
});
