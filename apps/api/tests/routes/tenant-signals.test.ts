// SPDX-License-Identifier: Apache-2.0
/**
 * On a shared server one account never sees another's runtime tasks, ingested events, signals or
 * council verdicts: not in lists, not by id, and it cannot cancel them.
 */
import crypto from "node:crypto";
import http from "node:http";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:tenant-signals";
const SECRET = "tenant-signals-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "5c".repeat(32);
delete process.env.NEXUS_DESKTOP;
delete process.env.REDIS_URL;
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
const alice = { authorization: `Bearer ${tokenFor(crypto.randomUUID())}` };
const bob = { authorization: `Bearer ${tokenFor(crypto.randomUUID())}` };

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = await buildServer();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  ollama.close();
});

const call = (method: "GET" | "POST" | "PATCH", url: string, headers: object, payload?: object) =>
  app.inject({ method, url: `/api/v1${url}`, headers: headers as Record<string, string>, payload });

it("keeps each account's pipeline rows to itself", async () => {
  const task = (
    await call("POST", "/runtime/tasks", alice, { type: "ingest:event", payload: {} })
  ).json<{ id: string }>();
  const event = (
    await call("POST", "/ingest/events", alice, {
      source: "github",
      event_type: "pr.opened",
      payload: { n: 1 },
    })
  ).json<{ event_id: string }>();
  const signal = (
    await call("POST", "/ingest/signals", alice, {
      signal_type: "manual",
      summary: "Alice's signal",
      priority: "high",
    })
  ).json<{ id: string }>();
  const council = (
    await call("POST", "/council/deliberate", alice, {
      proposal: { title: "Alice's proposal" },
      councilSize: 1,
    })
  ).json<{ verdictId: string }>();
  expect(council.verdictId).toBeTruthy();

  // Alice sees her own rows.
  expect(JSON.stringify((await call("GET", "/runtime/tasks", alice)).json())).toContain(task.id);
  expect(JSON.stringify((await call("GET", "/ingest/signals", alice)).json())).toContain(signal.id);
  expect(JSON.stringify((await call("GET", "/council/verdicts", alice)).json())).toContain(
    council.verdictId,
  );

  // Bob sees none of them.
  for (const url of ["/runtime/tasks", "/ingest/signals", "/council/verdicts"]) {
    const listed = JSON.stringify((await call("GET", url, bob)).json());
    for (const id of [task.id, event.event_id, signal.id, council.verdictId])
      expect(listed).not.toContain(id);
  }
  for (const url of [
    `/runtime/tasks/${task.id}`,
    `/ingest/events/${event.event_id}`,
    `/ingest/signals/${signal.id}`,
    `/council/verdicts/${council.verdictId}`,
    `/council/transcripts/${council.verdictId}`,
  ])
    expect((await call("GET", url, bob)).statusCode, url).toBe(404);
  expect(
    (await call("PATCH", `/runtime/tasks/${task.id}`, bob, { action: "cancel" })).statusCode,
  ).not.toBe(200);
  expect((await call("POST", "/council/trigger", bob, { signalId: signal.id })).statusCode).toBe(
    404,
  );
});

it("refuses a queued job that names another account's signal", async () => {
  const signal = (
    await call("POST", "/ingest/signals", alice, { signal_type: "manual", summary: "Alice only" })
  ).json<{ id: string }>();
  const r = await call("POST", "/runtime/tasks", bob, {
    type: "council.deliberate",
    payload: { signalId: signal.id },
  });
  expect(r.statusCode).toBe(404);
});

it("builds a context pack from the caller's own tasks, signals and memories", async () => {
  const saved = await call("POST", "/memory", alice, {
    text: "Alice's private launch codename is BLUEBIRD",
  });
  expect(saved.statusCode, saved.body).toBeLessThan(300);
  await call("POST", "/ingest/signals", alice, {
    signal_type: "manual",
    summary: "Alice critical",
    priority: "critical",
  });
  const own = JSON.stringify(
    (await call("POST", "/context-pack", alice, { memory_query: "launch codename" })).json(),
  );
  expect(own).toContain("Alice critical");
  const pack = JSON.stringify(
    (await call("POST", "/context-pack", bob, { memory_query: "launch codename" })).json(),
  );
  expect(pack).not.toContain("BLUEBIRD");
  expect(pack).not.toContain("Alice critical");
  expect(pack).not.toContain("ingest:event");
});
