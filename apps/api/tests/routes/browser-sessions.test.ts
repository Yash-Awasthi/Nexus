// SPDX-License-Identifier: Apache-2.0
/** Browser-agent sessions belong to whoever started them; one with no owner is nobody else's to read. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SECRET = "browser-sessions-test-secret";
const MASTER = "browser-sessions-master-key-0123456789";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_API_KEY = MASTER;

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
const req = (auth: string, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${auth}` }, payload });

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("browser-agent sessions", () => {
  it("are readable only by the account that started them", async () => {
    const alice = tokenFor(crypto.randomUUID());
    const bob = tokenFor(crypto.randomUUID());
    const mine = await req(alice, "POST", "/api/browser-agent/tasks", { task: "look around" });
    const anon = await req(MASTER, "POST", "/api/browser-agent/tasks", { task: "no owner" });
    const mineId = mine.json<{ session: { id: string } }>().session.id;
    const anonId = anon.json<{ session: { id: string } }>().session.id;

    const bobList = (await req(bob, "GET", "/api/browser-agent/sessions")).body;
    expect(bobList).not.toContain(mineId);
    expect(bobList).not.toContain(anonId);
    expect((await req(bob, "GET", `/api/browser-agent/sessions/${mineId}`)).statusCode).toBe(404);
    expect((await req(bob, "GET", `/api/browser-agent/sessions/${anonId}`)).statusCode).toBe(404);
    expect((await req(alice, "GET", `/api/browser-agent/sessions/${mineId}`)).statusCode).toBe(200);
  });
});
