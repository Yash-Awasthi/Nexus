// SPDX-License-Identifier: Apache-2.0
/**
 * POST /api/kg/sync folds a federated peer's graph into the caller's own, and
 * the librarian reads the result. In-memory graphs: no database, no model.
 */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SECRET = "kg-sync-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
const savedDb = process.env.DATABASE_URL;

const { buildServer } = await import("../../src/server.js");

function as(userId: string) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return { authorization: `Bearer ${head}.${body}.${sig}` };
}

const node = (id: string, name: string) => ({
  id,
  name,
  type: "ORG" as const,
  confidence: 0.8,
  properties: { sector: "mining" },
  sources: ["peer-doc"],
  createdAt: 1_000,
  updatedAt: 2_000,
});

let app: FastifyInstance;
beforeAll(async () => {
  delete process.env.DATABASE_URL;
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  if (savedDb) process.env.DATABASE_URL = savedDb;
});

const sync = (headers: object, payload: object) =>
  app.inject({ method: "POST", url: "/api/kg/sync", headers, payload });

describe("POST /api/kg/sync", () => {
  it("folds a peer's graph in and answers with the converged state", async () => {
    const alice = as(crypto.randomUUID());
    const res = await sync(alice, { nodes: [node("peer-n1", "Acme Corp")], edges: [] });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ nodes: { id: string }[]; applied: { nodes: number } }>();
    expect(body.applied.nodes).toBe(1);
    const pulled = await sync(alice, {});
    expect(pulled.json<{ nodes: { id: string }[] }>().nodes.map((n) => n.id)).toContain("peer-n1");
  });

  it("is idempotent — replaying the same snapshot changes nothing", async () => {
    const alice = as(crypto.randomUUID());
    const snapshot = { nodes: [node("peer-n2", "Beta Ltd")], edges: [] };
    // The first exchange stores the node with its property clocks; after that nothing moves.
    await sync(alice, snapshot);
    const second = await sync(alice, snapshot);
    const third = await sync(alice, snapshot);
    expect(third.json<{ nodes: unknown[] }>().nodes).toEqual(
      second.json<{ nodes: unknown[] }>().nodes,
    );
  });

  it("keeps each account's graph to itself", async () => {
    await sync(as(crypto.randomUUID()), { nodes: [node("secret-n", "Project Falcon")], edges: [] });
    const other = await sync(as(crypto.randomUUID()), {});
    expect(other.json<{ nodes: unknown[] }>().nodes).toEqual([]);
  });
});

it("lets the librarian find entities named inside a question", async () => {
  const alice = as(crypto.randomUUID());
  await sync(alice, { nodes: [node("lib-heron", "Heronsgate Labs")], edges: [] });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/agents/librarian/query",
    headers: alice,
    payload: { query: "Who works at Heronsgate Labs these days?" },
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json<{ entities: { name: string }[] }>().entities.map((e) => e.name)).toContain(
    "Heronsgate Labs",
  );
});
