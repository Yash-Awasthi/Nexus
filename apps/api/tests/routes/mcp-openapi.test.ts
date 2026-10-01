// SPDX-License-Identifier: Apache-2.0
/**
 * A saved OpenAPI spec is served as an MCP endpoint: its operations are the tools, and calls go
 * to the API with the saved authorization. Only the owner can reach it.
 */
import crypto from "node:crypto";
import http from "node:http";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:mcp-openapi";
const SECRET = "mcp-openapi-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "1d".repeat(32);
process.env.NEXUS_DESKTOP = "1";

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
let upstream: http.Server;
const alice = { authorization: `Bearer ${tokenFor(crypto.randomUUID())}` };
const bob = { authorization: `Bearer ${tokenFor(crypto.randomUUID())}` };
const hits: { url?: string; auth?: string }[] = [];
let port = 0;

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  upstream = http.createServer((req, res) => {
    hits.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "p1", name: "Rex" }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  port = (upstream.address() as { port: number }).port;
  app = await buildServer();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  upstream.close();
});

const rpc = (id: string, headers: object, body: object) =>
  app.inject({
    method: "POST",
    url: `/api/v1/mcp/openapi/${id}/mcp`,
    headers: headers as Record<string, string>,
    payload: { jsonrpc: "2.0", id: 1, ...body },
  });

it("serves a saved spec's operations as MCP tools, for its owner only", async () => {
  const saved = await app.inject({
    method: "POST",
    url: "/api/v1/mcp/openapi",
    headers: alice,
    payload: {
      name: "pets",
      authorization: "Bearer pets-secret",
      spec: {
        openapi: "3.0.0",
        servers: [{ url: `http://127.0.0.1:${port}` }],
        paths: {
          "/pets/{petId}": {
            get: {
              operationId: "getPet",
              parameters: [{ name: "petId", in: "path", required: true }],
            },
          },
        },
      },
    },
  });
  expect(saved.statusCode, saved.body).toBe(201);
  const { id, tools } = saved.json<{ id: string; tools: string[] }>();
  expect(tools).toEqual(["getPet"]);
  expect(saved.body).not.toContain("pets-secret");

  const listed = await rpc(id, alice, { method: "tools/list" });
  expect(listed.json<{ result: { tools: { name: string }[] } }>().result.tools[0]!.name).toBe(
    "getPet",
  );
  const called = await rpc(id, alice, {
    method: "tools/call",
    params: { name: "getPet", arguments: { petId: "p1" } },
  });
  expect(
    called.json<{ result: { content: { text: string }[] } }>().result.content[0]!.text,
  ).toContain("Rex");
  expect(hits.at(-1)).toEqual({ url: "/pets/p1", auth: "Bearer pets-secret" });

  expect((await rpc(id, bob, { method: "tools/list" })).statusCode).toBe(404);
  const mine = await app.inject({ method: "GET", url: "/api/v1/mcp/openapi", headers: bob });
  expect(mine.json<{ specs: unknown[] }>().specs).toHaveLength(0);
});
