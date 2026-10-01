// SPDX-License-Identifier: Apache-2.0
/** Switching a connector off is the account's choice and survives a restart. */
import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { expect, it, vi } from "vitest";

const SECRET = "connectors-enabled-restart-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_DATA_DIR = mkdtempSync(join(tmpdir(), "connectors-enabled-"));
vi.mock("../../src/lib/pg-pool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/pg-pool.js")>()),
  getPgPool: () => null,
}));

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const ALICE = crypto.randomUUID();
const auth = { authorization: `Bearer ${tokenFor(ALICE)}` };

async function boot(): Promise<FastifyInstance> {
  vi.resetModules();
  const { buildServer } = await import("../../src/server.js");
  const app = await buildServer();
  await app.ready();
  return app;
}

it("keeps a connector switched off across a restart", async () => {
  let app = await boot();
  const list = await app.inject({ method: "GET", url: "/api/v1/connectors", headers: auth });
  const id = list.json<{ connectors: { id: string }[] }>().connectors[0]!.id;
  const off = await app.inject({
    method: "PATCH",
    url: `/api/v1/connectors/${id}`,
    headers: auth,
    payload: { enabled: false },
  });
  expect(off.statusCode, off.body).toBe(200);
  await app.close();

  app = await boot();
  const after = await app.inject({ method: "GET", url: "/api/v1/connectors", headers: auth });
  const mine = after.json<{ connectors: { id: string; enabled: boolean }[] }>().connectors;
  expect(mine.find((c) => c.id === id)?.enabled).toBe(false);
  await app.close();
});
