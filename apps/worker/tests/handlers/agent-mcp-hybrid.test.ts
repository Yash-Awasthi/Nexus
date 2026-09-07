// SPDX-License-Identifier: Apache-2.0
// End-to-end wiring test (pass 69): the worker's agent-MCP surface can now
// serve the pass-69 hybrid single-query tool — a request through a RuntimeTool
// handler reaches createHybridSearchMcpServer over its real JSON-RPC handle()
// seam (the same localMcpToolsFromServer bridge the council/debate tools use)
// and returns a parsed fused result, with the executor error path. DB-free and
// offline: deterministic in-memory dense + BM25 adapters drive the search.
import { describe, expect, it } from "vitest";
import { hybridSearchRuntimeTools } from "../../src/handlers/agent-mcp.js";
import {
  InMemoryBM25,
  type SearchHit,
  type VectorSearchAdapter,
} from "@nexus/hybrid-search";

const CORPUS = [
  { id: "d1", text: "Hybrid search fuses dense vector and bm25 results.", metadata: { tier: "gold" } },
  { id: "d2", text: "RRF fusion ranks documents by reciprocal rank.", metadata: { tier: "free" } },
];

/** Deterministic dense leg: docs whose text contains the query's first token. */
function lexicalDense(): VectorSearchAdapter {
  const tokenize = (t: string): string[] =>
    t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const corpus = CORPUS.map((d) => ({ ...d, toks: tokenize(d.text) }));
  return {
    async search(query: string, limit: number): Promise<SearchHit[]> {
      const qt = new Set(tokenize(query));
      return corpus
        .map((d) => ({ id: d.id, score: d.toks.filter((t) => qt.has(t)).length, text: d.text, metadata: d.metadata }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },
  };
}

function makeAdapters() {
  const bm25 = new InMemoryBM25();
  bm25.index(CORPUS);
  return { vector: lexicalDense(), bm25 };
}

describe("hybridSearchRuntimeTools (served hybrid single query → RuntimeTool)", () => {
  it("surfaces the search tool namespaced under the prefix with query required", async () => {
    const tools = await hybridSearchRuntimeTools(makeAdapters());
    expect(tools.map((t) => t.name)).toEqual(["hybrid__hybrid_search"]);
    expect(tools[0]!.description).toContain("Hybrid retrieval single query");
    expect((tools[0]!.parameters as { required?: string[] }).required).toEqual(["query"]);
  });

  it("a tool request reaches the engine and returns parsed fused hits", async () => {
    const tools = await hybridSearchRuntimeTools(makeAdapters());
    const raw = await tools[0]!.handler({ query: "fuses bm25", limit: 2 });
    const parsed = JSON.parse(raw) as {
      hits: Array<{ id: string; score: number; text: string }>;
      vectorHits: unknown[];
      bm25Hits: unknown[];
      durationMs: number;
    };
    expect(parsed.hits.length).toBeGreaterThan(0);
    expect(parsed.hits[0]!.id).toBe("d1");
    expect(parsed.vectorHits.length).toBeGreaterThan(0);
    expect(parsed.bm25Hits.length).toBeGreaterThan(0);
    expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("honors a metadata where filter through the served surface", async () => {
    const tools = await hybridSearchRuntimeTools(makeAdapters());
    const raw = await tools[0]!.handler({
      query: "fuses bm25 ranks",
      where: { tier: "gold" },
    });
    const parsed = JSON.parse(raw) as { hits: Array<{ id: string; metadata?: Record<string, unknown> }> };
    expect(parsed.hits.length).toBeGreaterThan(0);
    expect(parsed.hits.every((h) => h.metadata?.tier === "gold")).toBe(true);
    expect(parsed.hits.some((h) => h.id === "d2")).toBe(false);
  });

  it("propagates an engine failure through the tool handler", async () => {
    const failing: VectorSearchAdapter = {
      async search() {
        throw new Error("vector store unreachable");
      },
    };
    const { bm25 } = makeAdapters();
    const tools = await hybridSearchRuntimeTools({ vector: failing, bm25 });
    await expect(
      tools[0]!.handler({ query: "anything" }),
    ).rejects.toThrow(/vector store unreachable|Tool execution failed/);
  });
});
