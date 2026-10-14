// SPDX-License-Identifier: Apache-2.0
/** NX-SEC-004: a GitHub sign-in is matched on a verified address or the immutable account id, never the login. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const DB = "pglite://:memory:oauth-github-identity";
process.env.NEXUS_JWT_SECRET = "oauth-github-identity-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gh-id-"));
process.env.GITHUB_CLIENT_ID = "gh-client";
process.env.GITHUB_CLIENT_SECRET = "gh-secret";

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

async function githubSignIn(
  profile: { id: number; login: string; email?: string | null },
  emails: { email: string; primary: boolean; verified: boolean }[],
): Promise<{ email: string; userId: string }> {
  const start = await app.inject({ method: "GET", url: "/api/v1/oauth/github" });
  const state = new URL(start.headers.location as string).searchParams.get("state")!;
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://github.com/login/oauth/access_token"))
      return Response.json({ access_token: "gh-access" });
    if (url === "https://api.github.com/user") return Response.json(profile);
    if (url === "https://api.github.com/user/emails") return Response.json(emails);
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/oauth/github/callback?code=c&state=${state}`,
    headers: { accept: "application/json" },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ email: string; userId: string }>();
}

it("uses the primary verified address", async () => {
  const r = await githubSignIn({ id: 7, login: "seven", email: "public@example.com" }, [
    { email: "unverified@example.com", primary: false, verified: false },
    { email: "primary@example.com", primary: true, verified: true },
  ]);
  expect(r.email).toBe("primary@example.com");
});

it("never matches on a login someone else can claim later", async () => {
  const first = await githubSignIn({ id: 1001, login: "handle" }, [
    { email: "x@example.com", primary: true, verified: false },
  ]);
  expect(first.email).toBe("1001+handle@users.noreply.github.com");

  // The same login, now held by a different GitHub account.
  const second = await githubSignIn({ id: 2002, login: "handle" }, []);
  expect(second.email).toBe("2002+handle@users.noreply.github.com");
  expect(second.userId).not.toBe(first.userId);
});
