// SPDX-License-Identifier: Apache-2.0
// Post-fusion rerank seam (pass 52): the engine doc has always advertised
// "orchestrates vector search + BM25 + RRF + reranker" but took no reranker —
// these tests pin the seam that makes the advertised stage real, mirroring
// weaviate's hybrid rerank tool: fused candidates are reranked and cut to limit.
import { describe, it, expect } from "vitest";
import {
  HybridSearchEngine,
  InMemoryBM25,
  type VectorSearchAdapter,
} from "../src/index.js";
import {
  NullReranker,
  FunctionReranker,
  BM25Reranker,
  type Reranker,
} from "@nexus/reranker";

interface Doc {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

// Same shared universe as where-filter.test.ts: dense ranks by fixed priority
// (a first), BM25 scores text; a,b both match "token refresh" so RRF puts a
// (both-legs hit) on top — a reranker must be able to override that order.
const DOCS: Doc[] = [
  { id: "a", text: "token refresh authentication session", metadata: { tenant: "acme" } },
  { id: "b", text: "token refresh authentication session", metadata: { tenant: "globex" } },
  { id: "c", text: "billing invoice totals monthly", metadata: { tenant: "acme" } },
  { id: "d", text: "onboarding guide welcome screens", metadata: { tenant: "acme" } },
];

class PriorityDense implements VectorSearchAdapter {
  constructor(private readonly docs: Doc[]) {}
  async search(query: string, limit: number) {
    return this.docs.slice(0, limit).map((d, i) => ({
      id: d.id,
      score: 1 - i * 0.01,
      text: d.text,
      metadata: d.metadata,
    }));
  }
}

function makeEngine(): HybridSearchEngine {
  const bm25 = new InMemoryBM25();
  bm25.index(DOCS.map((d) => ({ id: d.id, text: d.text, metadata: d.metadata })));
  return new HybridSearchEngine(new PriorityDense(DOCS), bm25);
}

/** Scores docs containing a term 1.0, others −1 (dropped at threshold 0). */
function termPref(term: string): Reranker {
  return new FunctionReranker((_q, doc) => (doc.includes(term) ? 1 : -1));
}

describe("HybridSearchEngine rerank seam", () => {
  it("reranker overrides the fused RRF order", async () => {
    const r = await makeEngine().search({
      query: "token refresh",
      reranker: termPref("billing"),
    });
    // RRF alone puts a (both-leg hit) first; the reranker must lift c — the
    // only billing doc — and drop the −1 scorers at the default threshold
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.id).toBe("c");
  });

  it("rerank cut respects limit", async () => {
    const r = await makeEngine().search({
      query: "token refresh",
      limit: 2,
      reranker: new FunctionReranker((_q, doc) => doc.length), // longer text first
    });
    expect(r.hits).toHaveLength(2);
  });

  it("NullReranker preserves the fused order", async () => {
    const plain = await makeEngine().search({ query: "token refresh" });
    const nulled = await makeEngine().search({ query: "token refresh", reranker: new NullReranker() });
    expect(nulled.hits.map((h) => h.id)).toEqual(plain.hits.map((h) => h.id));
  });

  it("negative-score non-matches are dropped at the default threshold", async () => {
    const r = await makeEngine().search({
      query: "token refresh",
      reranker: termPref("token"),
    });
    // a and b contain "token" (score 1); c and d score −1 and are filtered out
    expect(r.hits.map((h) => h.id).sort()).toEqual(["a", "b"]);
  });

  it("BM25Reranker is usable end-to-end through the engine", async () => {
    const r = await makeEngine().search({
      query: "token refresh authentication",
      reranker: new BM25Reranker(),
    });
    expect(r.hits.length).toBeGreaterThan(0);
    // BM25 favors the token-heavy docs a/b over c/d
    expect(r.hits[0]!.id).toBe("a");
    expect(r.hits[1]!.id).toBe("b");
  });

  it("legacy path without reranker is unchanged", async () => {
    const r = await makeEngine().search({ query: "token refresh" });
    expect(r.hits).toHaveLength(4);
    expect(r.hits[0]!.id).toBe("a");
  });

  it("reranker composes with the where filter", async () => {
    const r = await makeEngine().search({
      query: "token refresh",
      where: { tenant: "acme" },
      reranker: termPref("billing"),
    });
    // where restricts to a,c; rerank keeps only c (billing) above threshold
    expect(r.hits.map((h) => h.id)).toEqual(["c"]);
  });
});
