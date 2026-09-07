// SPDX-License-Identifier: Apache-2.0
// Served hybrid search (pass 69) — the hybrid single-query surface as MCP
// tools. These tests drive the real McpHttpServer JSON-RPC handle() seam (the
// same seam the worker/CLI localMcpToolsFromServer bridge and any HTTP host
// use): initialize, tools/list advertises the tool schema, and tools/call runs
// the full pipeline — parallel dense+BM25 legs, metadata filter pre-fusion,
// RRF/alpha fusion, rerank opt-out — against deterministic in-memory adapters.
import { describe, expect, it } from "vitest";
import { BM25Reranker } from "@nexus/reranker";

import { createHybridSearchMcpServer } from "../src/mcp-server.js";
import { InMemoryBM25, type SearchHit, type VectorSearchAdapter } from "../src/index.js";

/** Deterministic lexical dense leg: overlap of query tokens with doc tokens. */
function makeDense(docs: Array<{ id: string; text: string; metadata?: Record<string, unknown> }>): VectorSearchAdapter {
  const tokenize = (t: string): string[] =>
    t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const corpus = docs.map((d) => ({ ...d, toks: tokenize(d.text) }));
  return {
    async search(query: string, limit: number): Promise<SearchHit[]> {
      const qt = new Set(tokenize(query));
      const scored = corpus.map((d) => ({
        id: d.id,
        score: d.toks.filter((t) => qt.has(t)).length,
        text: d.text,
        metadata: d.metadata,
      }));
      return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },
  };
}

const CORPUS = [
  {
    id: "d1",
    text: "The hybrid search engine fuses dense vector and bm25 results.",
    metadata: { tier: "gold", price: 10 },
  },
  {
    id: "d2",
    text: "RRF fusion ranks documents by reciprocal rank.",
    metadata: { tier: "free", price: 1 },
  },
  {
    id: "d3",
    text: "Chroma stores embeddings with metadata filters.",
    metadata: { tier: "gold", price: 99 },
  },
];

function makeServer(overrides: Partial<Parameters<typeof createHybridSearchMcpServer>[0]> = {}) {
  const bm25 = new InMemoryBM25();
  bm25.index(CORPUS);
  return createHybridSearchMcpServer({ vector: makeDense(CORPUS), bm25, ...overrides });
}

type RpcResult = { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { code?: number; message?: string } };

async function call(server: ReturnType<typeof makeServer>, method: string, params: Record<string, unknown> = {}) {
  const res = await server.handle({
    method: "POST",
    path: "/mcp",
    body: { jsonrpc: "2.0", id: 1, method, params },
  });
  return res.body as RpcResult;
}

describe("createHybridSearchMcpServer (served hybrid single query)", () => {
  it("advertises the hybrid_search tool over initialize + tools/list", async () => {
    const server = makeServer();
    const init = await call(server, "initialize", {
      protocolVersion: "2026-07-28",
      clientInfo: { name: "test-client" },
    });
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
      "hybrid-search (for test-client)",
    );

    const list = await call(server, "tools/list");
    const tools = (list.result as { tools: Array<{ name: string; inputSchema: { required?: string[]; properties: Record<string, unknown> } }> }).tools;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("hybrid_search");
    expect(tools[0]!.inputSchema.required).toEqual(["query"]);
    for (const key of ["limit", "fusion", "vectorWeight", "where", "whereDocument", "rerank"]) {
      expect(tools[0]!.inputSchema.properties[key]).toBeDefined();
    }
  });

  it("runs one hybrid single query: fused hits plus both legs' candidates", async () => {
    const server = makeServer();
    const res = await call(server, "tools/call", {
      name: "hybrid_search",
      arguments: { query: "bm25 ranks documents", limit: 2 },
    });
    expect(res.error).toBeUndefined();
    const result = res.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text) as {
      hits: Array<{ id: string; score: number; text: string }>;
      vectorHits: unknown[];
      bm25Hits: unknown[];
      durationMs: number;
    };
    expect(parsed.hits.length).toBeGreaterThan(0);
    expect(parsed.hits[0]!.id).toBe("d2"); // best BM25 + dense overlap for this query
    expect(parsed.vectorHits.length).toBeGreaterThan(0);
    expect(parsed.bm25Hits.length).toBeGreaterThan(0);
    expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("applies the metadata where filter pre-fusion (free doc dropped, gold kept)", async () => {
    const server = makeServer();
    // Same query with and without the filter: d2 (free) ranks top unfiltered...
    const unfiltered = await call(server, "tools/call", {
      name: "hybrid_search",
      arguments: { query: "bm25 ranks documents" },
    });
    const plain = JSON.parse((unfiltered.result as { content: { text: string }[] }).content[0]!.text) as {
      hits: Array<{ id: string; metadata?: Record<string, unknown> }>;
    };
    expect(plain.hits.some((h) => h.id === "d2")).toBe(true);

    // ...but is excluded when only gold docs pass the filter.
    const filtered = await call(server, "tools/call", {
      name: "hybrid_search",
      arguments: { query: "bm25 ranks documents", where: { tier: "gold" } },
    });
    const gold = JSON.parse((filtered.result as { content: { text: string }[] }).content[0]!.text) as {
      hits: Array<{ id: string; metadata?: Record<string, unknown> }>;
    };
    expect(gold.hits.length).toBeGreaterThan(0);
    expect(gold.hits.every((h) => h.metadata?.tier === "gold")).toBe(true);
    expect(gold.hits.some((h) => h.id === "d2")).toBe(false);
  });

  it("supports alpha fusion with a tunable dense weight", async () => {
    const server = makeServer();
    const res = await call(server, "tools/call", {
      name: "hybrid_search",
      arguments: { query: "vector embeddings", fusion: "alpha", vectorWeight: 0.9 },
    });
    expect(res.error).toBeUndefined();
    const parsed = JSON.parse((res.result as { content: { text: string }[] }).content[0]!.text) as {
      hits: Array<{ id: string }>;
    };
    expect(parsed.hits.length).toBeGreaterThan(0);
  });

  it("reranks by default when a reranker is configured, and honors rerank: false", async () => {
    const server = makeServer({ reranker: new BM25Reranker() });
    const reranked = await call(server, "tools/call", {
      name: "hybrid_search",
      arguments: { query: "hybrid search engine", limit: 3 },
    });
    expect(reranked.error).toBeUndefined();
    const withRerank = JSON.parse((reranked.result as { content: { text: string }[] }).content[0]!.text) as {
      hits: Array<{ id: string }>;
    };
    expect(withRerank.hits.length).toBeGreaterThan(0);

    const optedOut = await call(server, "tools/call", {
      name: "hybrid_search",
      arguments: { query: "hybrid search engine", limit: 3, rerank: false },
    });
    expect(optedOut.error).toBeUndefined();
  });

  it("errors on an unknown tool and on a missing query without leaking stacks", async () => {
    const server = makeServer();
    const unknown = await call(server, "tools/call", { name: "nope", arguments: {} });
    expect(unknown.error?.code).toBe(-32602);

    const noQuery = await call(server, "tools/call", { name: "hybrid_search", arguments: {} });
    expect(noQuery.error).toBeUndefined(); // empty-query guard is an isError result, not JSON-RPC error
    expect((noQuery.result as { isError: boolean }).isError).toBe(true);
  });
});
