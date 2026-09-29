// SPDX-License-Identifier: Apache-2.0
/** A knowledge base read into the caller's knowledge graph, optionally limited to some entity types. */
import type { LlmDriver, LlmRequestOptions } from "@nexus/llm-drivers";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let failing = false;
const extractor = {
  provider: "scripted",
  model: "scripted",
  complete: async (opts: LlmRequestOptions) => {
    if (failing) throw new Error("rate limited");
    const system = String(opts.messages[0]?.content ?? "");
    const content = system.includes("relationship extraction")
      ? JSON.stringify([
          { subject: "Ada", predicate: "works at", object: "Acme", confidence: 0.9 },
          { subject: "Ada", predicate: "lives in", object: "Paris", confidence: 0.9 },
        ])
      : JSON.stringify([
          { text: "Ada", type: "PERSON", confidence: 0.9 },
          { text: "Acme", type: "ORG", confidence: 0.9 },
          { text: "Paris", type: "LOCATION", confidence: 0.9 },
        ]);
    return {
      id: "g",
      content,
      model: "scripted",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: "stop",
      durationMs: 1,
    };
  },
} as unknown as LlmDriver;

vi.mock("../../src/lib/user-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/user-context.js")>()),
  getUserDrivers: () => [{ id: "scripted", driver: extractor }],
}));

const savedDb = process.env.DATABASE_URL;
const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;
const makeKb = async (name: string, docs: Record<string, string>) => {
  const id = (await app.inject({ method: "POST", url: "/api/kb", payload: { name } })).json<{
    id: string;
  }>().id;
  for (const [docName, content] of Object.entries(docs)) {
    await app.inject({
      method: "POST",
      url: `/api/kb/${id}/documents`,
      payload: { name: docName, content },
    });
  }
  return id;
};
const graphNodes = async () =>
  (await app.inject({ method: "GET", url: "/api/kg/search?q=Ada&type=ENTITIES" }))
    .json<{ nodes: { name: string }[] }>()
    .nodes.map((n) => n.name);

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  if (savedDb) process.env.DATABASE_URL = savedDb;
});

/** Starts a build and waits for the background job to finish. */
const build = async (id: string, payload: object = {}) => {
  const start = await app.inject({ method: "POST", url: `/api/kb/${id}/graph`, payload });
  expect(start.statusCode).toBe(202);
  for (let i = 0; i < 100; i++) {
    const job = (await app.inject({ method: "GET", url: `/api/kb/${id}/graph` })).json<{
      state: string;
    }>();
    if (job.state !== "running") return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("graph build did not finish");
};

describe("POST /api/kb/:id/graph", () => {
  it("extracts entities and relationships from the stored chunks into the graph", async () => {
    const id = await makeKb("people", { "team.txt": "Ada works at Acme and lives in Paris." });
    expect((await app.inject({ method: "GET", url: `/api/kb/${id}/graph` })).json()).toEqual({
      state: "idle",
    });
    expect(await build(id)).toMatchObject({
      state: "done",
      chunksDone: 1,
      chunksTotal: 1,
      entities: 3,
      relationships: 2,
      failed: 0,
    });
    expect(await graphNodes()).toContain("Ada");

    const drawn = (await app.inject({ method: "GET", url: "/api/kg/graph" })).json<{
      nodes: { name: string; rank: number }[];
      edges: { predicate: string }[];
      total: { nodes: number; edges: number };
    }>();
    expect(drawn.nodes[0]).toMatchObject({ name: "Ada", rank: 2 });
    expect(drawn.edges.map((e) => e.predicate).sort()).toEqual(["lives in", "works at"]);
    expect(drawn.total).toMatchObject({ nodes: 3, edges: 2 });
  });

  it("keeps only the entity types asked for", async () => {
    const id = await makeKb("orgs", { "team.txt": "Ada works at Acme and lives in Paris." });
    expect(await build(id, { entityTypes: ["ORG"] })).toMatchObject({
      entities: 1,
      relationships: 0,
    });
  });

  it("ends as an error, not an empty graph, when the model never answers", async () => {
    // Different text from the other cases, whose answers the model cache would replay.
    const id = await makeKb("silent", { "team.txt": "Grace joined Initech last spring." });
    failing = true;
    try {
      expect(await build(id)).toMatchObject({
        state: "error",
        entities: 0,
        failed: 1,
        error: expect.stringMatching(/rate limited/),
      });
    } finally {
      failing = false;
    }
    expect(await build(id)).toMatchObject({ state: "done", entities: 3, failed: 0 });
  });

  it("refuses an unknown entity type, an empty knowledge base and an unknown id", async () => {
    const id = await makeKb("empty", {});
    const bad = await app.inject({
      method: "POST",
      url: `/api/kb/${id}/graph`,
      payload: { entityTypes: ["WIZARD"] },
    });
    expect(bad.statusCode).toBe(400);
    const empty = await app.inject({ method: "POST", url: `/api/kb/${id}/graph`, payload: {} });
    expect(empty.statusCode).toBe(400);
    const gone = await app.inject({ method: "POST", url: "/api/kb/nope/graph", payload: {} });
    expect(gone.statusCode).toBe(404);
  });
});
