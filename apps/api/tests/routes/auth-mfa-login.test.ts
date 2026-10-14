// SPDX-License-Identifier: Apache-2.0
/** Once a user turns on MFA, a password alone no longer signs them in. */
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:auth-mfa-login";
process.env.NEXUS_JWT_SECRET = "auth-mfa-login-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-auth-mfa-"));

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { authUsersRoutes } = await import("../../src/routes/auth-users.ts");
const { mfaRoutes } = await import("../../src/routes/mfa.ts");

let app: FastifyInstance;

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = Fastify();
  await app.register(authUsersRoutes, { prefix: "/api/v1" });
  await app.register(mfaRoutes, { prefix: "/api/v1" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePgPools();
});

function totp(secret: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac("sha1", key).update(msg).digest();
  const o = h[19]! & 0x0f;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

it("asks for the authenticator code at sign-in once MFA is on", async () => {
  const creds = { email: "mfa@example.com", password: "Mfa-pass-12!" };
  const reg = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: creds });
  expect(reg.statusCode, reg.body).toBe(201);
  const auth = { authorization: `Bearer ${reg.json<{ accessToken: string }>().accessToken}` };

  const setup = await app.inject({ method: "POST", url: "/api/v1/mfa/setup", headers: auth });
  expect(setup.statusCode, setup.body).toBe(200);
  const { secret } = setup.json<{ secret: string }>();
  const on = await app.inject({
    method: "POST",
    url: "/api/v1/mfa/verify",
    headers: auth,
    payload: { code: totp(secret) },
  });
  expect(on.statusCode, on.body).toBe(200);

  const bare = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: creds });
  expect(bare.statusCode, bare.body).toBe(401);
  expect(bare.json<{ error: string }>().error).toBe("mfa_required");
  expect(bare.headers["set-cookie"]).toBeUndefined();

  const wrong = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { ...creds, code: totp(secret) === "000000" ? "111111" : "000000" },
  });
  expect(wrong.statusCode, wrong.body).toBe(401);

  const ok = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { ...creds, code: totp(secret) },
  });
  expect(ok.statusCode, ok.body).toBe(200);
  expect(ok.json<{ accessToken: string }>().accessToken).toBeTruthy();
});

it("accepts a sign-in code once (NX-SEC-012)", async () => {
  const creds = { email: "mfa-replay@example.com", password: "Mfa-replay-12!" };
  const reg = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: creds });
  const auth = { authorization: `Bearer ${reg.json<{ accessToken: string }>().accessToken}` };
  const setup = await app.inject({ method: "POST", url: "/api/v1/mfa/setup", headers: auth });
  const { secret } = setup.json<{ secret: string }>();
  await app.inject({
    method: "POST",
    url: "/api/v1/mfa/verify",
    headers: auth,
    payload: { code: totp(secret) },
  });

  const code = totp(secret);
  const first = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { ...creds, code },
  });
  expect(first.statusCode, first.body).toBe(200);
  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { ...creds, code },
  });
  expect(replay.statusCode).toBe(401);
});

it("has no unauthenticated code-check endpoint (NX-SEC-012)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/mfa/validate",
    payload: { userId: "00000000-0000-0000-0000-000000000000", code: "123456" },
  });
  expect(res.statusCode).toBe(404);
});

it("signs in once with each recovery code and can replace them (NX-FEAT-004)", async () => {
  const creds = { email: "mfa-recovery@example.com", password: "Mfa-recovery-12!" };
  const reg = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: creds });
  const auth = { authorization: `Bearer ${reg.json<{ accessToken: string }>().accessToken}` };
  const setup = await app.inject({ method: "POST", url: "/api/v1/mfa/setup", headers: auth });
  const { secret } = setup.json<{ secret: string }>();
  const on = await app.inject({
    method: "POST",
    url: "/api/v1/mfa/verify",
    headers: auth,
    payload: { code: totp(secret) },
  });
  const { recoveryCodes } = on.json<{ recoveryCodes: string[] }>();
  expect(recoveryCodes).toHaveLength(10);
  expect(new Set(recoveryCodes).size).toBe(10);

  const login = (code: string) =>
    app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { ...creds, code } });
  expect((await login(recoveryCodes[0]!)).statusCode).toBe(200);
  expect((await login(recoveryCodes[0]!)).statusCode).toBe(401);
  // Case and the dash are forgiven; the code is what matters.
  expect((await login(recoveryCodes[1]!.toLowerCase().replace("-", ""))).statusCode).toBe(200);

  const renewed = await app.inject({
    method: "POST",
    url: "/api/v1/mfa/recovery-codes",
    headers: auth,
    payload: { code: totp(secret) },
  });
  expect(renewed.statusCode, renewed.body).toBe(200);
  const fresh = renewed.json<{ recoveryCodes: string[] }>().recoveryCodes;
  expect(fresh).toHaveLength(10);
  expect((await login(recoveryCodes[2]!)).statusCode).toBe(401);
  expect((await login(fresh[0]!)).statusCode).toBe(200);
});
