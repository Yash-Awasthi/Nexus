// SPDX-License-Identifier: Apache-2.0
/** NX-SEC-030: a plugin is unpublished by its publisher or an admin, decided by role, not by a user id. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const SECRET = "plugin-registry-unpublish-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_API_KEY = "plugin-registry-unpublish-master-key";

const { buildServer } = await import("../../src/server.ts");

function tokenFor(sub: string, role: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub, role, iat: now, exp: now + 3600 });
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

const as = (sub: string, role = "agent") => ({ authorization: `Bearer ${tokenFor(sub, role)}` });

async function publish(id: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/registry/plugins",
    headers: as("publisher"),
    payload: {
      manifest: { id, name: id, version: "1.0.0", entry: "./p.js", capabilities: ["storage.read"] },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
}

const unpublish = (id: string, headers: Record<string, string>) =>
  app.inject({ method: "DELETE", url: `/api/v1/registry/plugins/${id}`, headers });

it("refuses another member, even one whose user id is the word admin", async () => {
  await publish("com.example.one");
  expect((await unpublish("com.example.one", as("someone-else"))).statusCode).toBe(403);
  expect((await unpublish("com.example.one", as("admin"))).statusCode).toBe(403);
});

it("lets an admin unpublish anyone's plugin", async () => {
  await publish("com.example.two");
  expect((await unpublish("com.example.two", as(crypto.randomUUID(), "admin"))).statusCode).toBe(
    204,
  );
});
