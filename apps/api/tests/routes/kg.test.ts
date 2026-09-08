// SPDX-License-Identifier: Apache-2.0
/**
 * Knowledge-graph surface route tests — the §16.7 extraction of /kg/* from
 * api-bridge.ts into routes/kg.ts (+ lib/knowledge-graph-store.ts).
 *
 * Hermetic by construction: DATABASE_URL is cleared before building so
 * getKGStore() picks the InMemoryKGStore — empty graph, deterministic
 * responses, no Postgres. POST /kg/extract exercises the inert default
 * extractors (zero entities — current behavior, flagged in routes/kg.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../../src/server.js";

let app: FastifyInstance;
let savedDbUrl: string | undefined;

beforeEach(async () => {
  savedDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  app = await buildServer();
  await app.ready();
});

afterEach(async () => {
  await app.close();
  if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
});

describe("GET /api/kg/graph", () => {
  it("returns empty nodes + edges on a fresh in-memory graph", async () => {
    const res = await app.inject({ method: "GET", url: "/api/kg/graph" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ nodes: [], edges: [] });
  });

  it("supports the q filter", async () => {
    const res = await app.inject({ method: "GET", url: "/api/kg/graph?q=alice&limit=5" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ nodes: [], edges: [] });
  });
});

describe("GET/POST /api/kg/search", () => {
  it("GET returns empty nodes on a fresh graph", async () => {
    const res = await app.inject({ method: "GET", url: "/api/kg/search?q=alice&k=10" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ nodes: [] });
  });

  it("POST variant (UI) returns empty nodes too", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/kg/search",
      payload: { query: "alice", k: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ nodes: [] });
  });
});

describe("POST /api/kg/extract", () => {
  it("returns the ingest result shape with inert default extractors", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/kg/extract",
      payload: { text: "Alice works at Acme Corp." },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      nodesAdded: number;
      nodesMerged: number;
      edgesAdded: number;
      edgesMerged: number;
      entities: unknown[];
      relationships: unknown[];
    }>();
    // Current behavior: the default KnowledgeGraph uses null extractors, so
    // ingest round-trips zeroes (flagged in routes/kg.ts).
    expect(body.entities).toEqual([]);
    expect(body.relationships).toEqual([]);
    expect(body.nodesAdded).toBe(0);
  });
});

describe("GET/POST /api/kg/traverse", () => {
  it("returns empty nodes + edges for an unknown subject", async () => {
    for (const req of [
      { method: "GET", url: "/api/kg/traverse?id=alice" },
      { method: "POST", url: "/api/kg/traverse", payload: { id: "alice" } },
    ] as const) {
      const res = await app.inject(req);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ nodes: [], edges: [] });
    }
  });
});

describe("GET /api/kg/communities", () => {
  it("reports zero communities on an empty graph with the honest message", async () => {
    const res = await app.inject({ method: "GET", url: "/api/kg/communities" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      communities: unknown[];
      total: number;
      levels: number;
      message: string;
    }>();
    expect(body.communities).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.message).toContain("No entities in graph yet");
  });
});