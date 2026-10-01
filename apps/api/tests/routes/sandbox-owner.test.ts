// SPDX-License-Identifier: Apache-2.0
/** A sandbox run's result is read back only by the account that ran it. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SECRET = "sandbox-owner-secret";
process.env.NEXUS_JWT_SECRET = SECRET;

const { buildServer } = await import("../../src/server.js");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app.close();
});

const call = (url: string, user: string, payload: object) =>
  app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${tokenFor(user)}` },
    payload,
  });

describe("sandbox results", () => {
  it("are not readable by another account", async () => {
    const alice = `alice-${crypto.randomUUID()}`;
    const bob = `bob-${crypto.randomUUID()}`;
    const run = await call("/api/sandbox/execute", alice, { code: "'alice secret output'" });
    const id = run.json<{ executionId: string }>().executionId;
    const read = (u: string) =>
      app.inject({
        method: "GET",
        url: `/api/sandbox/status/${id}`,
        headers: { authorization: `Bearer ${tokenFor(u)}` },
      });
    expect((await read(alice)).body).toContain("alice secret output");
    expect((await read(bob)).json()).toEqual({ executionId: id, status: "not_found" });
  });
});
