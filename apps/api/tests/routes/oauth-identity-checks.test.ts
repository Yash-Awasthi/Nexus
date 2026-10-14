// SPDX-License-Identifier: Apache-2.0
/** NX-SEC-010: Google must vouch for the address; a Slack identity is a workspace plus a user. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const DB = "pglite://:memory:oauth-identity-checks";
process.env.NEXUS_JWT_SECRET = "oauth-identity-checks-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-oauth-id-"));
process.env.GOOGLE_CLIENT_ID = "g-client";
process.env.GOOGLE_CLIENT_SECRET = "g-secret";
process.env.SLACK_CLIENT_ID = "s-client";
process.env.SLACK_CLIENT_SECRET = "s-secret";

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { oauthRoutes } = await import("../../src/routes/oauth.ts");

let app: FastifyInstance;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = Fastify();
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

async function callback(provider: "google" | "slack", answer: (url: string) => unknown) {
  const start = await app.inject({ method: "GET", url: `/api/v1/oauth/${provider}` });
  const state = new URL(start.headers.location as string).searchParams.get("state")!;
  globalThis.fetch = vi.fn(async (input: string | URL | Request) =>
    Response.json(answer(String(input instanceof Request ? input.url : input))),
  ) as typeof fetch;
  return app.inject({
    method: "GET",
    url: `/api/v1/oauth/${provider}/callback?code=c&state=${state}`,
    headers: { accept: "application/json" },
  });
}

it("refuses a Google address Google has not verified", async () => {
  const res = await callback("google", (url) =>
    url.includes("/token")
      ? { access_token: "t" }
      : { sub: "g-1", email: "unverified@example.com", email_verified: false },
  );
  expect(res.statusCode).toBe(403);
});

it("refuses a Slack answer that names no user", async () => {
  const res = await callback("slack", () => ({ ok: true, access_token: "t", team: { id: "T1" } }));
  expect(res.statusCode).not.toBe(200);
});

it("keeps the same Slack user id in two workspaces apart", async () => {
  const one = await callback("slack", () => ({
    ok: true,
    access_token: "t",
    team: { id: "T1", name: "One" },
    authed_user: { id: "U1" },
  }));
  const two = await callback("slack", () => ({
    ok: true,
    access_token: "t",
    team: { id: "T2", name: "Two" },
    authed_user: { id: "U1" },
  }));
  expect(one.statusCode, one.body).toBe(200);
  expect(two.statusCode, two.body).toBe(200);
  expect(one.json<{ userId: string }>().userId).not.toBe(two.json<{ userId: string }>().userId);
});
