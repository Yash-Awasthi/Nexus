// SPDX-License-Identifier: Apache-2.0
/** NX-SEC-011: password guesses spread across many addresses still hit one ceiling per account. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:auth-account-ceiling";
process.env.NEXUS_JWT_SECRET = "auth-account-ceiling-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-acct-ceiling-"));

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

it("stops accepting passwords for an account after a distributed guessing run", async () => {
  const creds = { email: "target@example.com", password: "Target-pass-1!" };
  await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: creds });

  for (let i = 0; i < 30; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: `198.51.100.${i + 1}`,
      payload: { email: creds.email, password: `wrong-guess-${i}` },
    });
    expect(res.statusCode).toBe(401);
  }

  const right = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    remoteAddress: "203.0.113.200",
    payload: creds,
  });
  expect(right.statusCode).toBe(429);
});
