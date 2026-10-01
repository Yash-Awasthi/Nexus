// SPDX-License-Identifier: Apache-2.0
/**
 * The local terminal plane opens only to a caller on this machine, judged by the connection
 * itself: a forwarded address, even from a trusted proxy, never counts as loopback.
 */
import crypto from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

const SECRET = "loopback-spoof-secret";
process.env.NEXUS_TRUST_PROXY = "true";
process.env.NEXUS_JWT_SECRET = SECRET;
delete process.env.NEXUS_LOCAL_PTY_FORCE;
const { buildServer } = await import("../../src/server.js");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const app = await buildServer();
beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

it("refuses a remote caller that forwards a loopback address", async () => {
  const r = await app.inject({
    method: "GET",
    url: "/api/local/status",
    remoteAddress: "198.51.100.7",
    headers: { "x-forwarded-for": "127.0.0.1", authorization: `Bearer ${tokenFor("u1")}` },
  });
  expect(r.statusCode).toBe(403);
});

it("still answers a caller on this machine", async () => {
  const r = await app.inject({
    method: "GET",
    url: "/api/local/status",
    remoteAddress: "127.0.0.1",
    headers: { authorization: `Bearer ${tokenFor("u1")}` },
  });
  expect(r.statusCode).toBe(200);
});
