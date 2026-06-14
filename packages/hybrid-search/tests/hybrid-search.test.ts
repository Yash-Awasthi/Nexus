// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { rrfFusion, HybridSearchEngine, InMemoryBM25, type SearchHit } from "../src/index.js";

function hit(id: string, score: number, text = ""): SearchHit {
  return { id, score, text };
}

// ── rrfFusion ─────────────────────────────────────────────────────────────────

describe("rrfFusion", () => {
  it("merges two disjoint lists", () => {
    const a = [hit("a", 1), hit("b", 0.8)];
    const b = [hit("c", 1), hit("d", 0.8)];
    const r = rrfFusion(a, b);
    expect(r.map((h) => h.id)).toEqual(expect.arrayContaining(["a", "b", "c", "d"]));
    expect(r).toHaveLength(4);
  });

  it("boosts documents appearing in both lists", () => {
    const a = [hit("shared", 0.5), hit("only-a", 0.9)];
    const b = [hit("shared", 0.5), hit("only-b", 0.9)];
    const r = rrfFusion(a, b);
    // shared appears in both so gets contributions from both lists
    const sharedScore = r.find((h) => h.id === "shared")!.score;
    const onlyAScore = r.find((h) => h.id === "only-a")!.score;
    expect(sharedScore).toBeGreaterThan(onlyAScore);
  });

  it("result is sorted descending", () => {
    const a = [hit("x", 1), hit("y", 0.5)];
    const b = [hit("y", 1), hit("z", 0.3)];
    const r = rrfFusion(a, b);
    for (let i = 1; i < r.length; i++) {
      expect(r[i - 1]!.score).toBeGreaterThanOrEqual(r[i]!.score);
    }
  });

  it("empty lists return empty", () => {
    expect(rrfFusion([], [])).toEqual([]);
  });

  it("one empty list returns other list scores", () => {
    const a = [hit("a", 1), hit("b", 0.5)];
    const r = rrfFusion(a, []);
    expect(r).toHaveLength(2);
  });

  it("custom k changes score magnitude", () => {
    const a = [hit("a", 1)];
    const b = [hit("a", 1)];
    const r60 = rrfFusion(a, b, { k: 60 });
    const r1 = rrfFusion(a, b, { k: 1 });
    // lower k → higher score contribution
    expect(r1[0]!.score).toBeGreaterThan(r60[0]!.score);
  });

  it("custom weights bias results", () => {
    const a = [hit("vector-doc", 1)];
    const b = [hit("bm25-doc", 1)];
    const r = rrfFusion(a, b, { weightA: 0.9, weightB: 0.1 });
    const vScore = r.find((h) => h.id === "vector-doc")!.score;
    const bScore = r.find((h) => h.id === "bm25-doc")!.score;
    expect(vScore).toBeGreaterThan(bScore);
  });
});

// ── InMemoryBM25 ──────────────────────────────────────────────────────────────

describe("InMemoryBM25", () => {
  const DOCS = [
    { id: "d1", text: "authentication token session bug fix" },
    { id: "d2", text: "button colour CSS homepage style" },
    { id: "d3", text: "OAuth2 token refresh authentication middleware" },
    { id: "d4", text: "database migration schema user table" },
  ];

  it("returns empty for empty index", async () => {
    const bm25 = new InMemoryBM25();
    expect(await bm25.search("auth", 5)).toEqual([]);
  });

  it("ranks relevant docs first", async () => {
    const bm25 = new InMemoryBM25();
    bm25.index(DOCS);
    const r = await bm25.search("authentication token", 4);
    expect(["d1", "d3"]).toContain(r[0]!.id);
  });

  it("scores normalized to [0,1]", async () => {
    const bm25 = new InMemoryBM25();
    bm25.index(DOCS);
    const r = await bm25.search("auth", 4);
    expect(r.every((h) => h.score >= 0 && h.score <= 1)).toBe(true);
  });

  it("respects limit", async () => {
    const bm25 = new InMemoryBM25();
    bm25.index(DOCS);
    expect(await bm25.search("a", 2)).toHaveLength(2);
  });

  it("add() adds a document after index", async () => {
    const bm25 = new InMemoryBM25();
    bm25.index(DOCS);
    bm25.add({ id: "d5", text: "authentication super important new doc" });
    const r = await bm25.search("authentication", 5);
    expect(r.some((h) => h.id === "d5")).toBe(true);
  });
});

// ── HybridSearchEngine ────────────────────────────────────────────────────────

describe("HybridSearchEngine", () => {
  const DOCS = [
    { id: "a", text: "auth login session token refresh" },
    { id: "b", text: "database schema migration user" },
    { id: "c", text: "authentication OAuth2 middleware bug" },
  ];

  function makeEngine() {
    const bm25 = new InMemoryBM25();
    bm25.index(DOCS);
    // Simple mock vector adapter that returns reversed BM25 for testing
    const vectorAdapter = { search: async (q: string, n: number) => bm25.search(q, n) };
    return new HybridSearchEngine(vectorAdapter, bm25);
  }

  it("returns results", async () => {
    const engine = makeEngine();
    const r = await engine.search({ query: "authentication token" });
    expect(r.hits.length).toBeGreaterThan(0);
  });

  it("respects limit", async () => {
    const engine = makeEngine();
    const r = await engine.search({ query: "auth", limit: 2 });
    expect(r.hits.length).toBeLessThanOrEqual(2);
  });

  it("returns vectorHits and bm25Hits", async () => {
    const engine = makeEngine();
    const r = await engine.search({ query: "auth" });
    expect(r.vectorHits.length).toBeGreaterThan(0);
    expect(r.bm25Hits.length).toBeGreaterThan(0);
  });

  it("includes durationMs", async () => {
    const engine = makeEngine();
    const r = await engine.search({ query: "auth" });
    expect(typeof r.durationMs).toBe("number");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("hits sorted descending by score", async () => {
    const engine = makeEngine();
    const r = await engine.search({ query: "authentication" });
    for (let i = 1; i < r.hits.length; i++) {
      expect(r.hits[i - 1]!.score).toBeGreaterThanOrEqual(r.hits[i]!.score);
    }
  });
});
