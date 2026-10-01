// SPDX-License-Identifier: Apache-2.0
/** Off the desktop, no provider name lets a saved base URL point at a private address. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const SECRET = "provider-keys-baseurl-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
delete process.env.NEXUS_DESKTOP;

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
});
afterAll(async () => {
  await app.close();
});

it.each(["ollama", "custom", "groq"])(
  "refuses a private base URL saved as %s",
  async (provider) => {
    const r = await app.inject({
      method: "POST",
      url: "/api/user/provider-keys",
      headers: { authorization: `Bearer ${tokenFor(crypto.randomUUID())}` },
      payload: { provider, baseUrl: "http://10.0.0.1/v1", models: ["m"] },
    });
    expect(r.statusCode, r.body).toBe(400);
  },
);
