// SPDX-License-Identifier: Apache-2.0
/** NX-SEC-020: SCIM takes only its own token, and deprovisioning ends the user's access at once. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:scim-auth";
process.env.NEXUS_JWT_SECRET = "scim-auth-secret";
process.env.NEXUS_SCIM_TOKEN = "scim-token-for-tests";
process.env.DATABASE_URL = DB;
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-scim-"));

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { authUsersRoutes } = await import("../../src/routes/auth-users.ts");
const { scimRoutes } = await import("../../src/routes/scim.ts");

let app: FastifyInstance;

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = Fastify();
  await app.register(authUsersRoutes, { prefix: "/api/v1" });
  await app.register(scimRoutes, { prefix: "/api/v1" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePgPools();
});

it("refuses any other bearer token", async () => {
  for (const token of ["", "scim-token-for-test", "scim-token-for-testss", "nope"]) {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/scim/v2/Users",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  }
});

it("ends a deprovisioned user's access tokens", async () => {
  const reg = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "leaver@example.com", password: "Leaver-pass-1!" },
  });
  const { accessToken, user } = reg.json<{ accessToken: string; user: { id: string } }>();
  const del = await app.inject({
    method: "DELETE",
    url: `/api/v1/scim/v2/Users/${user.id}`,
    headers: { authorization: "Bearer scim-token-for-tests" },
  });
  expect(del.statusCode).toBe(204);
  const me = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(me.statusCode).toBe(401);
});
