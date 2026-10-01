// SPDX-License-Identifier: Apache-2.0
/**
 * An ingested event is turned into a signal: by the worker when a queue is configured, in this
 * process otherwise. Re-sending the same idempotency key returns the original event id.
 */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:ingest-events-run";
const SECRET = "ingest-events-run-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "9a".repeat(32);
process.env.NEXUS_DESKTOP = "1";
delete process.env.REDIS_URL;

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

it("processes an event into a signal and returns the same id for a repeated key", async () => {
  const send = () =>
    app.inject({
      method: "POST",
      url: "/api/v1/ingest/events",
      headers: auth,
      payload: {
        source: "github",
        event_type: "pr.opened",
        payload: { number: 7 },
        idempotency_key: "gh-pr-7",
        priority: "high",
      },
    });
  const first = await send();
  expect(first.statusCode, first.body).toBe(202);
  const id = first.json<{ event_id: string }>().event_id;

  const again = await send();
  expect(again.json()).toMatchObject({ event_id: id, status: "duplicate" });

  const event = await app.inject({
    method: "GET",
    url: `/api/v1/ingest/events/${id}`,
    headers: auth,
  });
  expect(event.json<{ processedAt: string | null }>().processedAt).toBeTruthy();
  const signals = await app.inject({ method: "GET", url: "/api/v1/ingest/signals", headers: auth });
  expect(JSON.stringify(signals.json())).toContain(id);
});

it("rejects an unknown priority", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/ingest/events",
    headers: auth,
    payload: { source: "x", event_type: "y", payload: {}, priority: "urgent" },
  });
  expect(r.statusCode).toBe(400);
});
