// SPDX-License-Identifier: Apache-2.0
/**
 * A queued agent run uses the key its owner saved: the worker reads the encrypted connection,
 * decrypts it with the shared secrets key, and calls that endpoint with it.
 */
import crypto from "node:crypto";
import http from "node:http";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:worker-saved-key";
const SECRET = "worker-saved-key-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "8c".repeat(32);
process.env.NEXUS_DESKTOP = "1";

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { getPgPool } = await import("../../src/lib/pg-pool.js");
const { buildServer } = await import("../../src/server.js");
const { savedConnectionDriver } = await import("@nexus/worker/agent-handler");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

let app: FastifyInstance;
let upstream: http.Server;
const userId = crypto.randomUUID();
const auth = { authorization: `Bearer ${tokenFor(userId)}` };
const seen: { auth?: string; model?: string }[] = [];

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      seen.push({
        auth: req.headers.authorization,
        model: (JSON.parse(raw) as { model: string }).model,
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "done" } }], usage: {} }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  app = await buildServer();
  await app.ready();
  const port = (upstream.address() as { port: number }).port;
  const saved = await app.inject({
    method: "POST",
    url: "/api/user/provider-keys",
    headers: auth,
    payload: {
      provider: "harbor",
      apiKey: "sk-harbor-secret-1",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      models: ["tiny:free"],
    },
  });
  expect(saved.statusCode, saved.body).toBe(201);
}, 120_000);

afterAll(async () => {
  await app.close();
  upstream.close();
});

it("builds the run's driver from the owner's saved connection", async () => {
  const driver = await savedConnectionDriver(userId, "harbor");
  expect(driver).toBeDefined();
  const res = await driver!.complete({ messages: [{ role: "user", content: "go" }] });
  expect(res.content).toBe("done");
  expect(seen.at(-1)).toEqual({ auth: "Bearer sk-harbor-secret-1", model: "tiny:free" });
});

it("finds nothing for another account or an unsaved provider", async () => {
  expect(await savedConnectionDriver(crypto.randomUUID(), "harbor")).toBeUndefined();
  expect(await savedConnectionDriver(userId, "nope")).toBeUndefined();
});
