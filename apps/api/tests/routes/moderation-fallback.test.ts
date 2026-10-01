// SPDX-License-Identifier: Apache-2.0
/** With no working model and no OpenAI key, moderation still answers from its keyword heuristic. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:moderation-fallback";
const SECRET = "moderation-fallback-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "ab".repeat(32);
process.env.NEXUS_DESKTOP = "1";
for (const k of Object.keys(process.env))
  if (/_API_KEY$|^LMSTUDIO_BASE_URL$/.test(k)) delete process.env[k];
// Nothing listens here, so the always-registered local model fails like a dead daemon.
process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { getPgPool } = await import("../../src/lib/pg-pool.js");
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
const auth = { authorization: `Bearer ${tokenFor(crypto.randomUUID())}` };

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = await buildServer();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
});

it("blocks a plain threat and allows ordinary text", async () => {
  const threat = await app.inject({
    method: "POST",
    url: "/api/moderation/check",
    headers: auth,
    payload: { text: "I will kill you tomorrow" },
  });
  expect(threat.statusCode, threat.body).toBe(200);
  expect(threat.json()).toMatchObject({
    flagged: true,
    action: "block",
    reason: "Keyword heuristic.",
  });

  const plain = await app.inject({
    method: "POST",
    url: "/api/moderation/batch",
    headers: auth,
    payload: { items: [{ id: "a", text: "The meeting moved to Tuesday." }] },
  });
  expect(plain.statusCode, plain.body).toBe(200);
  expect(plain.json().results[0].result).toMatchObject({ flagged: false, action: "allow" });
});
