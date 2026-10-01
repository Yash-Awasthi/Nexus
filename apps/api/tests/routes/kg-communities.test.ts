// SPDX-License-Identifier: Apache-2.0
/** Communities, ranks and graph search over the caller's own knowledge graph. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SECRET = "kg-communities-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
const savedDb = process.env.DATABASE_URL;

const { buildServer } = await import("../../src/server.js");

function as(userId: string) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return { authorization: `Bearer ${head}.${body}.${sig}` };
}

const node = (name: string) => ({
  id: `n-${name}`,
  name,
  type: "CONCEPT" as const,
  confidence: 0.9,
  properties: {},
  sources: ["doc"],
  createdAt: 1,
  updatedAt: 1,
});
const edge = (a: string, p: string, b: string) => ({
  id: `e-${a}-${p}-${b}`,
  subjectId: `n-${a}`,
  predicate: p,
  objectId: `n-${b}`,
  confidence: 0.8,
  sources: ["doc"],
  createdAt: 1,
  updatedAt: 1,
});

let app: FastifyInstance;
const alice = as(crypto.randomUUID());
beforeAll(async () => {
  delete process.env.DATABASE_URL;
  app = await buildServer();
  await app.ready();
  await app.inject({
    method: "POST",
    url: "/api/kg/sync",
    headers: alice,
    payload: {
      nodes: ["Postgres", "Redis", "Kafka", "Ada", "Bob", "Cy"].map(node),
      edges: [
        edge("Postgres", "replicates_to", "Redis"),
        edge("Redis", "feeds", "Kafka"),
        edge("Kafka", "archives_to", "Postgres"),
        edge("Ada", "mentors", "Bob"),
        edge("Bob", "pairs_with", "Cy"),
        edge("Cy", "reviews", "Ada"),
      ],
    },
  });
});
afterAll(async () => {
  await app.close();
  if (savedDb) process.env.DATABASE_URL = savedDb;
});

describe("GET /api/kg/communities", () => {
  it("clusters the caller's graph with ranked members", async () => {
    const res = await app.inject({ method: "GET", url: "/api/kg/communities", headers: alice });
    expect(res.statusCode).toBe(200);
    const { communities } = res.json<{
      communities: { title: string; entities: { name: string; rank: number }[] }[];
    }>();
    expect(communities.map((c) => c.entities.map((e) => e.name).sort())).toEqual(
      expect.arrayContaining([
        ["Kafka", "Postgres", "Redis"],
        ["Ada", "Bob", "Cy"],
      ]),
    );
    expect(communities[0]!.entities[0]!.rank).toBe(2);
  });

  it("another account sees none of it", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/kg/communities",
      headers: as(crypto.randomUUID()),
    });
    expect(res.json()).toEqual({ communities: [] });
  });
});

describe("GET /api/kg/search", () => {
  it("expands the neighbourhood around a named entity", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/kg/search?q=Postgres&type=LOCAL_GRAPH",
      headers: alice,
    });
    const body = res.json<{ nodes: { name: string }[]; contextText: string }>();
    expect(body.nodes.map((n) => n.name)).toEqual(expect.arrayContaining(["Postgres", "Redis"]));
    expect(body.contextText).toContain("replicates_to");
  });

  it("matches a community by any member and returns that community's nodes", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/kg/search?q=bob&type=COMMUNITY",
      headers: alice,
    });
    const body = res.json<{ nodes: { name: string }[]; communities: unknown[] }>();
    expect(body.communities).toHaveLength(1);
    expect(body.nodes.map((n) => n.name).sort()).toEqual(["Ada", "Bob", "Cy"]);
  });

  it("rejects an unknown search type and a missing query", async () => {
    const bad = (url: string) => app.inject({ method: "GET", url, headers: alice });
    expect((await bad("/api/kg/search?q=x&type=NOPE")).statusCode).toBe(400);
    expect((await bad("/api/kg/search?type=ENTITIES")).statusCode).toBe(400);
  });
});
