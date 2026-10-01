// SPDX-License-Identifier: Apache-2.0
/**
 * Every deliberation leaves a verdict the caller can fetch by id, with or without a signal, and
 * the full council of archetypes can sit. A fake Ollama answers every member.
 */
import crypto from "node:crypto";
import http from "node:http";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:council-verdict";
const SECRET = "council-verdict-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "7b".repeat(32);
process.env.NEXUS_DESKTOP = "1";
process.env.NEXUS_LLM_PROVIDER = "ollama";

const ollama = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        message: { role: "assistant", content: "YES, approve. Confidence: 0.9" },
        done: true,
        prompt_eval_count: 5,
        eval_count: 5,
      }),
    );
  });
});
await new Promise<void>((r) => ollama.listen(0, "127.0.0.1", r));
process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`;

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
  ollama.close();
});

it("returns a verdict id for a deliberation without a signal, and serves that verdict", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/council/deliberate",
    headers: auth,
    payload: { proposal: { title: "Adopt the new pricing algorithm" }, councilSize: 14 },
  });
  expect(r.statusCode, r.body).toBe(200);
  const body = r.json<{ verdictId: string; result: { outcome: string; votes: unknown[] } }>();
  expect(body.result.outcome).toBe("approved");
  expect(body.result.votes).toHaveLength(14);
  expect(body.verdictId).toMatch(/^[0-9a-f-]{36}$/);

  const verdict = await app.inject({
    method: "GET",
    url: `/api/v1/council/verdicts/${body.verdictId}`,
    headers: auth,
  });
  expect(verdict.statusCode, verdict.body).toBe(200);
  expect(verdict.json()).toMatchObject({ decision: "approve" });
});

it("refuses another user's signal on the streamed council with a plain 404", async () => {
  const mine = await app.inject({
    method: "POST",
    url: "/api/v1/council/deliberate",
    headers: auth,
    payload: { proposal: { title: "Keep the old onboarding" } },
  });
  const signal = await app.inject({
    method: "GET",
    url: `/api/v1/council/verdicts/${mine.json<{ verdictId: string }>().verdictId}`,
    headers: auth,
  });
  const signalId = signal.json<{ signalId: string }>().signalId;
  const other = { authorization: `Bearer ${tokenFor(crypto.randomUUID())}` };
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/council/deliberate/stream",
    headers: other,
    payload: { proposal: { title: "Peek" }, signal_id: signalId },
  });
  expect(r.statusCode, r.body).toBe(404);
  expect(r.headers["content-type"]).toMatch(/json/);
});

it("validates the streamed council's body like the plain one", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/council/deliberate/stream",
    headers: auth,
    payload: {},
  });
  expect(r.statusCode, r.body).toBe(400);
});
