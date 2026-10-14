// SPDX-License-Identifier: Apache-2.0
/** NX-SEC-006 / NX-FEAT-002: ending a session ends its access token too, on every verification path. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB = "pglite://:memory:session-revocation";
process.env.NEXUS_JWT_SECRET = "session-revocation-secret";
process.env.NEXUS_API_KEY = "session-revocation-master-key";
process.env.DATABASE_URL = DB;
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-revoke-"));

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { authUsersRoutes } = await import("../../src/routes/auth-users.ts");
const { resolveIdentity } = await import("../../src/middleware/auth.ts");

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

const PASSWORD = "Revocation-pass-1!";

async function signIn(email: string, agent: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "user-agent": agent },
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ accessToken: string }>().accessToken;
}

const me = (token: string) =>
  app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { authorization: `Bearer ${token}` },
  });

async function identityOf(token: string): Promise<string | undefined> {
  const request = { headers: { authorization: `Bearer ${token}` } } as unknown as FastifyRequest;
  await resolveIdentity(request);
  return request.nexusUserId;
}

describe("session revocation", () => {
  it("signing out one device ends that device's access token only", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "two-devices@example.com", password: PASSWORD },
    });
    const laptop = await signIn("two-devices@example.com", "laptop");
    const phone = await signIn("two-devices@example.com", "phone");

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions",
      headers: { authorization: `Bearer ${phone}` },
    });
    const laptopSession = list
      .json<{ sessions: { id: string; userAgent: string | null }[] }>()
      .sessions.find((s) => s.userAgent === "laptop")!;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/sessions/${laptopSession.id}`,
      headers: { authorization: `Bearer ${phone}` },
    });
    expect(del.statusCode).toBe(204);

    expect((await me(laptop)).statusCode).toBe(401);
    expect(await identityOf(laptop)).toBeUndefined();
    expect((await me(phone)).statusCode).toBe(200);
  });

  it("signing out everywhere ends every access token, and a new sign-in works", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "everywhere@example.com", password: PASSWORD },
    });
    const a = await signIn("everywhere@example.com", "a");
    const b = await signIn("everywhere@example.com", "b");

    const all = await app.inject({
      method: "POST",
      url: "/api/v1/auth/sessions/revoke-all",
      headers: { authorization: `Bearer ${b}` },
    });
    expect(all.statusCode).toBe(204);

    expect((await me(a)).statusCode).toBe(401);
    expect((await me(b)).statusCode).toBe(401);
    expect(await identityOf(a)).toBeUndefined();

    const fresh = await signIn("everywhere@example.com", "c");
    expect((await me(fresh)).statusCode).toBe(200);
    expect(await identityOf(fresh)).toBeDefined();
  });

  it("a password reset ends access tokens issued before it", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "reset@example.com", password: PASSWORD },
    });
    const before = await signIn("reset@example.com", "old");
    const forgot = await app.inject({
      method: "POST",
      url: "/api/v1/auth/forgot-password",
      payload: { email: "reset@example.com" },
    });
    const reset = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: {
        token: forgot.json<{ resetToken: string }>().resetToken,
        password: "Brand-new-pass-2!",
      },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect((await me(before)).statusCode).toBe(401);
  });
});
