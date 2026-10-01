// SPDX-License-Identifier: Apache-2.0
/**
 * With no job queue, a browser-agent task left running by a previous process is finished
 * by this one, as its owner and on the owner's own provider key.
 */
import crypto from "node:crypto";
import http from "node:http";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const DB = "pglite://:memory:browser-task-resume";
const SECRET = "browser-task-resume-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_DESKTOP = "1";
delete process.env.REDIS_URL;

vi.mock("@nexus/stealth-browser", async (importOriginal) => {
  const real = await importOriginal<typeof import("@nexus/stealth-browser")>();
  const page = {
    url: "https://example.test/",
    title: async () => "Example",
    evaluate: async () => "page text",
    goto: async () => {},
    click: async () => {},
    type: async () => {},
    screenshot: async () => Buffer.from(""),
  };
  return {
    ...real,
    isPatchrightAvailable: async () => true,
    StealthBrowser: class {
      withPage<T>(fn: (p: typeof page) => Promise<T>): Promise<T> {
        return fn(page);
      }
    },
  };
});

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { getPgPool } = await import("../../src/lib/pg-pool.js");
const { db } = await import("@nexus/db");
const { userProviderCredentials } = await import("@nexus/db/schema");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const OWNER = crypto.randomUUID();
const SESSION = crypto.randomUUID();
let app: FastifyInstance;
let model: http.Server;

beforeAll(async () => {
  const pool = getPgPool(DB)!;
  await migrateEmbedded(pool);
  model = http.createServer((_req, res) => {
    const decision = { action: "done", done: true, result: "finished after restart" };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }));
  });
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
  const port = (model.address() as { port: number }).port;
  await db.insert(userProviderCredentials).values({
    userId: OWNER,
    provider: "localllm",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    models: ["tiny"],
  });
  await pool.query(
    `CREATE TABLE IF NOT EXISTS nexus_kv (collection TEXT NOT NULL, id TEXT NOT NULL,
      data JSONB NOT NULL, PRIMARY KEY (collection, id))`,
  );
  const stale = {
    id: SESSION,
    sessionId: SESSION,
    ownerId: OWNER,
    task: "read the page",
    status: "running",
    steps: [],
    createdAt: new Date().toISOString(),
  };
  await pool.query("INSERT INTO nexus_kv (collection, id, data) VALUES ($1, $2, $3)", [
    "browser_agent_sessions",
    SESSION,
    stale,
  ]);
  const { buildServer } = await import("../../src/server.js");
  app = await buildServer();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  model.close();
});

it("finishes an interrupted task as its owner", async () => {
  const read = async () =>
    (
      await app.inject({
        method: "GET",
        url: `/api/browser-agent/sessions/${SESSION}`,
        headers: { authorization: `Bearer ${tokenFor(OWNER)}` },
      })
    ).json<{ status?: string; result?: string; error?: string }>();
  await expect.poll(async () => (await read())?.status, { timeout: 15_000 }).toBe("completed");
  expect((await read())?.result).toBe("finished after restart");
});
