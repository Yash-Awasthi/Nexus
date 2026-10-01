// SPDX-License-Identifier: Apache-2.0
/** A synced session belongs to the account that pushed it; another account naming the same id sees nothing. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const { buildServer } = await import("../../src/server.js");

const SECRET = "session-sync-owner-secret";
let app: FastifyInstance;

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const call = (method: "GET" | "POST", url: string, userId: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tokenFor(userId)}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

beforeAll(async () => {
  process.env.NEXUS_JWT_SECRET = SECRET;
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

it("keeps one account's session away from another naming the same id", async () => {
  const id = `shared-${crypto.randomUUID()}`;
  const alice = `alice-${crypto.randomUUID()}`;
  const bob = `bob-${crypto.randomUUID()}`;
  const push = await call("POST", `/api/v1/session-sync/${id}/push`, alice, {
    ops: [{ type: "set", key: "secret", value: "alice-only" }],
  });
  expect(push.statusCode, push.body).toBe(201);

  const own = await call("GET", `/api/v1/session-sync/${id}/state`, alice);
  expect(own.body).toContain("alice-only");

  for (const path of ["pull", "state"]) {
    const other = await call("GET", `/api/v1/session-sync/${id}/${path}`, bob);
    expect(other.body).not.toContain("alice-only");
  }
});
