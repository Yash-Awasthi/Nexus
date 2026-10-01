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

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.js");
const { authUsersRoutes } = await import("../../src/routes/auth-users.js");
const { mfaRoutes } = await import("../../src/routes/mfa.js");

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
