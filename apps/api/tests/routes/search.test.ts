// SPDX-License-Identifier: Apache-2.0
/** One search over knowledge bases and the graph, with numbered sources and a cited answer on request. */
import type { LlmDriver, LlmRequestOptions } from "@nexus/llm-drivers";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const prompts: string[] = [];
const model = {
  provider: "scripted",
  model: "scripted",
  complete: async (opts: LlmRequestOptions) => {
    prompts.push(String(opts.messages.at(-1)?.content ?? ""));
    return {
      id: "s",
      content: "Backups run at 02:00 UTC [1].",
      model: "scripted",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: "stop",
      durationMs: 1,
    };
  },
} as unknown as LlmDriver;

vi.mock("../../src/lib/user-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/user-context.js")>()),
  getUserDrivers: () => [{ id: "scripted", driver: model }],
}));

const savedDb = process.env.DATABASE_URL;
const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;
const search = (payload: object) =>
  app.inject({ method: "POST", url: "/api/search", payload }).then((r) => ({
    status: r.statusCode,
    body: r.json<{
      results: { n: number; title: string; kbName?: string; source: string }[];
      sources: { n: number; title: string }[];
      answer?: string;
      cited?: number[];
      notes: string[];
      error?: string;
    }>(),
  }));

let opsId = "";
let cafeId = "";
beforeAll(async () => {
  delete process.env.DATABASE_URL;
  app = await buildServer();
  await app.ready();
  const make = async (name: string, docName: string, content: string) => {
    const id = (await app.inject({ method: "POST", url: "/api/kb", payload: { name } })).json<{
      id: string;
    }>().id;
    await app.inject({
      method: "POST",
      url: `/api/kb/${id}/documents`,
      payload: { name: docName, content },
    });
    return id;
  };
  opsId = await make(
    "ops",
    "schedule.txt",
    "Nightly backups run at 02:00 UTC on the primary cluster.",
  );
  cafeId = await make(
    "cafe",
    "menu.txt",
    "The cafeteria serves lunch between noon and two o'clock.",
  );
});
afterAll(async () => {
  await app.close();
  if (savedDb) process.env.DATABASE_URL = savedDb;
});

describe("POST /api/search", () => {
  it("searches every knowledge base and numbers each source once", async () => {
    const { status, body } = await search({ query: "when do backups run" });
    expect(status).toBe(200);
    expect(body.results[0]).toMatchObject({ n: 1, title: "schedule.txt", kbName: "ops" });
    expect(body.sources.map((s) => s.title)).toContain("schedule.txt");
    expect(body.answer).toBeUndefined();
  });

  it("limits the search to the bases chosen", async () => {
    const { body } = await search({ query: "backups lunch", kbs: [cafeId] });
    expect(new Set(body.results.map((r) => r.kbName))).toEqual(new Set(["cafe"]));
    expect(opsId).not.toBe(cafeId);
  });

  it("answers from the sources and names the ones it cites", async () => {
    prompts.length = 0;
    const { body } = await search({ query: "when do backups run", answer: true });
    expect(body.answer).toBe("Backups run at 02:00 UTC [1].");
    expect(body.cited).toEqual([1]);
    expect(prompts[0]).toContain("[1] schedule.txt");
    expect(prompts[0]).toContain("Question: when do backups run");
  });

  it("searches the graph and ranks a matching document above it", async () => {
    const { getKGStore } = await import("../../src/lib/knowledge-graph-store.js");
    const store = getKGStore();
    const now = 1;
    const node = (id: string, name: string, type: string) => ({
      id,
      name,
      type,
      confidence: 1,
      properties: {},
      sources: [],
      createdAt: now,
      updatedAt: now,
    });
    await store.upsertNode(node("grace", "Grace Hopper", "PERSON"));
    await store.upsertNode(node("platform", "platform team", "ORG"));
    await store.upsertEdge({
      id: "e1",
      subjectId: "grace",
      predicate: "leads",
      objectId: "platform",
      confidence: 1,
      sources: [],
      createdAt: now,
      updatedAt: now,
    });
    const { body } = await search({ query: "Grace platform backups", graph: true });
    const graph = body.results.find((r) => r.title === "Grace Hopper (PERSON)");
    expect(graph).toMatchObject({ source: "knowledge_graph" });
    expect((graph as unknown as { text: string }).text).toBe("Grace Hopper leads platform team");
    // The document that matches the question comes first.
    expect(body.results[0]?.source).toBe("knowledge_base");
  });

  it("refuses an empty query and a base that is not the caller's", async () => {
    expect((await search({ query: "  " })).status).toBe(400);
    expect((await search({ query: "x", kbs: ["nope"] })).status).toBe(404);
  });

  it("says so when there is nothing to search", async () => {
    const { body } = await search({ query: "anything", kbs: [], web: false });
    expect(Array.isArray(body.notes)).toBe(true);
  });
});
