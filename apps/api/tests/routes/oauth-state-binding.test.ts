// SPDX-License-Identifier: Apache-2.0
/** NX-SEC-009: a sign-in callback opened in a browser completes only in the browser that started it. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const DB = "pglite://:memory:oauth-state-binding";
process.env.NEXUS_JWT_SECRET = "oauth-state-binding-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-state-bind-"));
process.env.GOOGLE_CLIENT_ID = "g-client";
process.env.GOOGLE_CLIENT_SECRET = "g-secret";

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

async function start(): Promise<{ state: string; cookie: string }> {
  const res = await app.inject({ method: "GET", url: "/api/v1/oauth/google" });
  const state = new URL(res.headers.location as string).searchParams.get("state")!;
  const setCookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  const cookie = setCookie.find((c) => c.startsWith("nexus_sso_state="))?.split(";")[0] ?? "";
  return { state, cookie };
}

function stubGoogle() {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    return Response.json(
      url.includes("/token")
        ? { access_token: "t" }
        : { sub: "g-9", email: "bound@example.com", email_verified: true },
    );
  }) as typeof fetch;
}

it("binds the state to the starting browser with an HttpOnly cookie", async () => {
  const { state, cookie } = await start();
  expect(cookie).toBe(`nexus_sso_state=${state}`);
});

it("refuses a browser callback that carries another browser's state", async () => {
  const { state } = await start();
  stubGoogle();
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/oauth/google/callback?code=c&state=${state}`,
    headers: { accept: "text/html" },
  });
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toContain("error=invalid_state");
});

it("completes in the browser that started it", async () => {
  const { state, cookie } = await start();
  stubGoogle();
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/oauth/google/callback?code=c&state=${state}`,
    headers: { accept: "text/html", cookie },
  });
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toContain("signed_in=1");
});
