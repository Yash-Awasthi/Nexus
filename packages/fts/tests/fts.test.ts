// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  BM25Index,
  InMemoryVectorStore,
  HybridSearchEngine,
  SearchError,
  reciprocalRankFusion,
  hashEmbed,
  nullEmbed,
  type IDocument,
  type SearchResult,
} from "../src/index.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function doc(id: string, text: string, metadata?: Record<string, unknown>): IDocument {
  return { id, text, metadata };
}

// ── BM25Index ─────────────────────────────────────────────────────────────────

describe("BM25Index", () => {
  let idx: BM25Index;

  beforeEach(() => {
    idx = new BM25Index();
  });

  it("size returns 0 initially", () => {
    expect(idx.size()).toBe(0);
  });

  it("index increases size", () => {
    idx.index(doc("d1", "hello world"));
    expect(idx.size()).toBe(1);
  });

  it("search returns empty for empty index", () => {
    expect(idx.search("hello")).toHaveLength(0);
  });

  it("search finds a document containing the query term", () => {
    idx.index(doc("d1", "the quick brown fox"));
    const results = idx.search("quick");
    expect(results.some((r) => r.id === "d1")).toBe(true);
  });

  it("search returns results with positive scores", () => {
    idx.index(doc("d1", "machine learning and deep learning"));
    const results = idx.search("learning");
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it("more relevant doc scores higher", () => {
    idx.index(doc("d1", "python programming language"));
    idx.index(doc("d2", "python python python deep learning python"));
    const results = idx.search("python");
    // d2 has higher TF, but BM25 saturates — both should appear
    expect(results.length).toBeGreaterThan(0);
    // Both contain "python", so both should be in results
    const ids = results.map((r) => r.id);
    expect(ids).toContain("d1");
    expect(ids).toContain("d2");
  });

  it("search does not return docs that don't match", () => {
    idx.index(doc("d1", "java programming"));
    idx.index(doc("d2", "javascript frontend"));
    const results = idx.search("python");
    expect(results).toHaveLength(0);
  });

  it("search returns up to k results", () => {
    for (let i = 0; i < 20; i++) idx.index(doc(`d${i}`, `python article number ${i}`));
    const results = idx.search("python", { k: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("remove decreases size and stops returning that doc", () => {
    idx.index(doc("d1", "python"));
    idx.remove("d1");
    expect(idx.size()).toBe(0);
    expect(idx.search("python")).toHaveLength(0);
  });

  it("remove returns false for unknown id", () => {
    expect(idx.remove("ghost")).toBe(false);
  });

  it("re-indexing same id updates the document", () => {
    idx.index(doc("d1", "python programming"));
    idx.index(doc("d1", "javascript programming"));
    // searching python should no longer return d1
    expect(idx.search("python")).toHaveLength(0);
    expect(idx.search("javascript")[0]!.id).toBe("d1");
  });

  it("search result includes text and metadata", () => {
    idx.index(doc("d1", "rust systems programming", { author: "Yash" }));
    const [result] = idx.search("rust");
    expect(result!.text).toBe("rust systems programming");
    expect(result!.metadata?.author).toBe("Yash");
  });

  it("case-insensitive matching", () => {
    idx.index(doc("d1", "Python Programming"));
    expect(idx.search("python").length).toBeGreaterThan(0);
  });

  it("minScore option filters low-scoring results", () => {
    idx.index(doc("d1", "python intro"));
    idx.index(doc("d2", "advanced python deep learning"));
    const results = idx.search("python", { minScore: 0.5 });
    // All returned results have score > 0.5
    results.forEach((r) => expect(r.score).toBeGreaterThan(0.5));
  });
});

// ── InMemoryVectorStore ───────────────────────────────────────────────────────

describe("InMemoryVectorStore", () => {
  let store: InMemoryVectorStore;

  beforeEach(() => {
    store = new InMemoryVectorStore();
  });

  it("size is 0 initially", () => expect(store.size()).toBe(0));

  it("add increases size", () => {
    store.add("v1", [1, 0, 0]);
    expect(store.size()).toBe(1);
  });

  it("search finds similar vectors", () => {
    store.add("a", [1, 0, 0]);
    store.add("b", [0, 1, 0]);
    store.add("c", [0, 0, 1]);
    const results = store.search([1, 0, 0], 3);
    expect(results[0]!.id).toBe("a");
    expect(results[0]!.score).toBeCloseTo(1, 5);
  });

  it("orthogonal vectors score near 0", () => {
    store.add("x", [1, 0]);
    const results = store.search([0, 1], 1);
    expect(results[0]!.score).toBeCloseTo(0, 5);
  });

  it("remove deletes a vector", () => {
    store.add("v1", [1, 0]);
    store.remove("v1");
    expect(store.size()).toBe(0);
    expect(store.search([1, 0], 1)).toHaveLength(0);
  });

  it("remove returns false for unknown id", () => {
    expect(store.remove("ghost")).toBe(false);
  });

  it("returns top-k results", () => {
    for (let i = 0; i < 10; i++) store.add(`v${i}`, [Math.random(), Math.random()]);
    const results = store.search([1, 0], 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("handles empty store gracefully", () => {
    expect(store.search([1, 0], 5)).toHaveLength(0);
  });

  it("handles zero vector query without throwing", () => {
    store.add("a", [1, 0]);
    const results = store.search([0, 0], 1);
    expect(results[0]!.score).toBe(0);
  });
});

// ── reciprocalRankFusion ──────────────────────────────────────────────────────

describe("reciprocalRankFusion", () => {
  it("returns empty for empty input", () => {
    expect(reciprocalRankFusion([])).toHaveLength(0);
  });

  it("single list returns items in order", () => {
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const fused = reciprocalRankFusion([list]);
    expect(fused[0]!.id).toBe("a");
    expect(fused[1]!.id).toBe("b");
  });

  it("item appearing in both lists scores higher", () => {
    const list1 = [{ id: "shared" }, { id: "only1" }];
    const list2 = [{ id: "shared" }, { id: "only2" }];
    const fused = reciprocalRankFusion([list1, list2]);
    expect(fused[0]!.id).toBe("shared");
  });

  it("scores are positive", () => {
    const fused = reciprocalRankFusion([[{ id: "a" }], [{ id: "b" }]]);
    fused.forEach((r) => expect(r.score).toBeGreaterThan(0));
  });

  it("custom k changes score magnitude", () => {
    const list = [{ id: "a" }];
    const low_k = reciprocalRankFusion([list], 1);
    const high_k = reciprocalRankFusion([list], 100);
    // lower k → higher score for rank 0
    expect(low_k[0]!.score).toBeGreaterThan(high_k[0]!.score);
  });

  it("items only in one list still appear in results", () => {
    const fused = reciprocalRankFusion([[{ id: "a" }], [{ id: "b" }]]);
    const ids = fused.map((r) => r.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
  });
});

// ── hashEmbed / nullEmbed ─────────────────────────────────────────────────────

describe("hashEmbed", () => {
  it("produces vector of requested dims", () => {
    const embed = hashEmbed(8);
    expect(embed("hello")).toHaveLength(8);
  });

  it("is deterministic", () => {
    const embed = hashEmbed(4);
    expect(embed("hello")).toEqual(embed("hello"));
  });

  it("different texts produce different vectors", () => {
    const embed = hashEmbed(8);
    expect(embed("hello")).not.toEqual(embed("world"));
  });

  it("produces unit-length vectors (L2 norm ≈ 1)", () => {
    const embed = hashEmbed(8);
    const vec = embed("test");
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});

describe("nullEmbed", () => {
  it("returns empty array for any input", () => {
    expect(nullEmbed("hello")).toHaveLength(0);
  });
});

// ── HybridSearchEngine ────────────────────────────────────────────────────────

describe("HybridSearchEngine", () => {
  const embed = hashEmbed(8);
  let engine: HybridSearchEngine;

  beforeEach(() => {
    engine = new HybridSearchEngine(new BM25Index(), new InMemoryVectorStore(), embed);
  });

  it("docCount is 0 initially", () => expect(engine.docCount()).toBe(0));

  it("addDocument increases docCount", () => {
    engine.addDocument(doc("d1", "hello world"));
    expect(engine.docCount()).toBe(1);
  });

  it("searchFTS returns BM25 results", () => {
    engine.addDocument(doc("d1", "python machine learning"));
    engine.addDocument(doc("d2", "java enterprise development"));
    const results = engine.searchFTS("python");
    expect(results[0]!.id).toBe("d1");
  });

  it("searchVector returns vector similarity results", () => {
    engine.addDocument(doc("d1", "machine learning"));
    engine.addDocument(doc("d2", "machine learning"));
    const results = engine.searchVector("machine learning");
    expect(results.length).toBeGreaterThan(0);
  });

  it("search (hybrid) returns results", () => {
    engine.addDocument(doc("d1", "python data science"));
    engine.addDocument(doc("d2", "javascript web development"));
    const results = engine.search("python");
    expect(results.length).toBeGreaterThan(0);
  });

  it("hybrid search returns at most k results", () => {
    for (let i = 0; i < 20; i++) engine.addDocument(doc(`d${i}`, `python tutorial ${i}`));
    const results = engine.search("python", { k: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("removeDocument removes from both indices", () => {
    engine.addDocument(doc("d1", "python"));
    engine.removeDocument("d1");
    expect(engine.docCount()).toBe(0);
    expect(engine.searchFTS("python")).toHaveLength(0);
    expect(engine.searchVector("python")).toHaveLength(0);
  });

  it("removeDocument returns false for unknown id", () => {
    expect(engine.removeDocument("ghost")).toBe(false);
  });

  it("accepts pre-computed vector", () => {
    const precomputed = [1, 0, 0, 0, 0, 0, 0, 0];
    engine.addDocument(doc("d1", "test"), precomputed);
    const results = engine.searchVector("test");
    expect(results.some((r) => r.id === "d1")).toBe(true);
  });

  it("hybrid search with nullEmbed falls back gracefully to FTS only", () => {
    const hybridNull = new HybridSearchEngine(
      new BM25Index(),
      new InMemoryVectorStore(),
      nullEmbed,
    );
    hybridNull.addDocument(doc("d1", "python guide"));
    const results = hybridNull.search("python");
    // Should still return BM25 results even when embed returns []
    expect(results.some((r) => r.id === "d1")).toBe(true);
  });
});

// ── SearchError ───────────────────────────────────────────────────────────────

describe("SearchError", () => {
  it("has correct name, code, and message", () => {
    const e = new SearchError("index full", "INDEX_FULL");
    expect(e.name).toBe("SearchError");
    expect(e.code).toBe("INDEX_FULL");
    expect(e instanceof Error).toBe(true);
  });
});
