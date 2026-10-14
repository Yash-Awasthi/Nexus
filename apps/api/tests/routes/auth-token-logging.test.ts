// SPDX-License-Identifier: Apache-2.0
/** NX-SEC-002: one-time tokens must never reach the log, where anyone with log access could redeem them. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:auth-token-logging";
process.env.NEXUS_JWT_SECRET = "auth-token-logging-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-auth-log-"));

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { authUsersRoutes } = await import("../../src/routes/auth-users.ts");

let app: FastifyInstance;
let logged = "";

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      logged += chunk.toString();
      done();
    },
  });
  app = Fastify({ logger: { level: "trace", stream } });
  await app.register(authUsersRoutes, { prefix: "/api/v1" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePgPools();
});

it("keeps reset and verification tokens out of the log", async () => {
  const reg = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "logs@example.com", password: "Logging-pass-1!" },
  });
  expect(reg.statusCode, reg.body).toBe(201);

  const forgot = await app.inject({
    method: "POST",
    url: "/api/v1/auth/forgot-password",
    payload: { email: "logs@example.com" },
  });
  expect(forgot.statusCode, forgot.body).toBe(200);
  const { resetToken } = forgot.json<{ resetToken: string }>();

  const sent = await app.inject({
    method: "POST",
    url: "/api/v1/auth/send-verification",
    headers: { authorization: `Bearer ${reg.json<{ accessToken: string }>().accessToken}` },
  });
  expect(sent.statusCode, sent.body).toBe(200);
  const { verifyToken } = sent.json<{ verifyToken: string }>();

  expect(resetToken).toMatch(/^[0-9a-f]{64}$/);
  expect(verifyToken).toMatch(/^[0-9a-f]{64}$/);
  expect(logged).toContain("password-reset-token-issued");
  expect(logged).not.toContain(resetToken);
  expect(logged).not.toContain(verifyToken);
});
