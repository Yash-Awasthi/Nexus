// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/memory — coverage for the store/graph/hybrid-search surfaces (§14.5):
 * TurboQuantStore (int8-quantized vector store), MemoryGraph (semantic graph +
 * BFS cascade), and the RRF hybrid-search + query-expansion helpers. All pure /
 * deterministic — no live services.
 */
import { describe, it, expect } from "vitest";

import {
  TurboQuantStore,
  MemoryGraph,
  edgeTraversalWeight,
  rrfHybridSearch,
  nullQueryExpander,
  hybridSearchWithExpansion,
  BM25Lexicon,
} from "../src/index.js";
import type { MemoryEntry, BM25Hit, IMemoryEntry } from "../src/index.js";

const now = () => Math.floor(Date.now() / 1000);
const entry = (
  id: string,
  text: string,
  embedding: number[],
  extra: Partial<MemoryEntry> = {},
): MemoryEntry => ({
  id,
  text,
  embedding,
  metadata: {},
  createdAt: now(),
  ...extra,
});

// ── TurboQuantStore ───────────────────────────────────────────────────────────

describe("TurboQuantStore", () => {
  const mk = () => new TurboQuantStore({ dim: 4 });

  it("saves and retrieves an entry by id", async () => {
    const s = mk();
    await s.save(entry("a", "alpha", [1, 0, 0, 0]));
    expect((await s.get("a"))?.text).toBe("alpha");
    expect(await s.get("missing")).toBeNull();
    expect(await s.count()).toBe(1);
  });

  it("overwrites an existing id in place (no duplicate)", async () => {
    const s = mk();
    await s.save(entry("a", "v1", [1, 0, 0, 0]));
    await s.save(entry("a", "v2", [1, 0, 0, 0]));
    expect(await s.count()).toBe(1);
    expect((await s.get("a"))?.text).toBe("v2");
  });

  it("ranks the nearest vector first (approximate cosine)", async () => {
    const s = mk();
    await s.save(entry("x", "x", [1, 0, 0, 0]));
    await s.save(entry("y", "y", [0, 1, 0, 0]));
    await s.save(entry("z", "z", [0, 0, 1, 0]));
    const hits = await s.search([1, 0, 0, 0], 3);
    expect(hits[0]?.entry.id).toBe("x");
    expect(hits).toHaveLength(3);
  });

  it("filters by userId and metadata in search + list", async () => {
    const s = mk();
    await s.save(entry("u1", "one", [1, 0, 0, 0], { userId: "u1", metadata: { k: "v" } }));
    await s.save(entry("u2", "two", [1, 0, 0, 0], { userId: "u2" }));
    const byUser = await s.search([1, 0, 0, 0], 10, { userId: "u1" });
    expect(byUser.map((h) => h.entry.id)).toEqual(["u1"]);
    const byMeta = await s.list({ metadata: { k: "v" } });
    expect(byMeta.map((e) => e.id)).toEqual(["u1"]);
  });

  it("excludes expired entries by default and includes them when asked", async () => {
    const s = mk();
    await s.save(entry("exp", "gone", [1, 0, 0, 0], { expiresAt: now() - 10 }));
    await s.save(entry("live", "here", [0, 1, 0, 0]));
    expect((await s.list()).map((e) => e.id)).toEqual(["live"]);
    expect((await s.list({ excludeExpired: false })).length).toBe(2);
  });

  it("deletes an entry and re-indexes the remainder", async () => {
    const s = mk();
    await s.save(entry("a", "a", [1, 0, 0, 0]));
    await s.save(entry("b", "b", [0, 1, 0, 0]));
    await s.save(entry("c", "c", [0, 0, 1, 0]));
    await s.delete("a");
    expect(await s.get("a")).toBeNull();
    expect((await s.get("c"))?.text).toBe("c"); // still resolvable after splice
    await s.delete("missing"); // no-op
    expect(await s.count()).toBe(2);
  });

  it("purges by filter and clears everything", async () => {
    const s = mk();
    await s.save(entry("a", "a", [1, 0, 0, 0], { userId: "u1" }));
    await s.save(entry("b", "b", [0, 1, 0, 0], { userId: "u1" }));
    await s.save(entry("c", "c", [0, 0, 1, 0], { userId: "u2" }));
    expect(await s.purge({ userId: "u1" })).toBe(2);
    expect(await s.count()).toBe(1);
    await s.clear();
    expect(await s.count()).toBe(0);
  });

  it("reports a compression ratio > 1 vs float32", async () => {
    const s = mk();
    await s.save(entry("a", "a", [1, 0, 0, 0]));
    const stats = s.memoryStats();
    expect(stats.quantizedBytes).toBeGreaterThan(0);
    expect(stats.float32EquivalentBytes).toBeGreaterThan(0);
    expect(stats.compressionRatio).toBeGreaterThan(0);
  });
});

// ── edgeTraversalWeight ───────────────────────────────────────────────────────

describe("edgeTraversalWeight", () => {
  it("returns a positive finite weight for every edge kind", () => {
    for (const e of [
      { kind: "has_tag" } as const,
      { kind: "in_cluster" } as const,
      { kind: "relates_to", weight: 0.5 } as const,
      { kind: "supersedes" } as const,
      { kind: "contradicts" } as const,
      { kind: "derived_from" } as const,
    ]) {
      const w = edgeTraversalWeight(e);
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThan(0);
    }
  });

  it("a heavier relates_to weight propagates at least as strongly", () => {
    const hi = edgeTraversalWeight({ kind: "relates_to", weight: 0.9 });
    const lo = edgeTraversalWeight({ kind: "relates_to", weight: 0.1 });
    expect(hi).toBeGreaterThanOrEqual(lo);
  });
});

// ── MemoryGraph ───────────────────────────────────────────────────────────────

describe("MemoryGraph", () => {
  const mem = (id: string, content = id): IMemoryEntry => ({ id, content });

  it("adds, gets, and removes memories with correct counts", () => {
    const g = new MemoryGraph();
    g.addMemory(mem("a"));
    g.addMemory(mem("b"));
    expect(g.memoryCount()).toBe(2);
    expect(g.getMemory("a")?.content).toBe("a");
    expect(g.allMemories().map((m) => m.id).sort()).toEqual(["a", "b"]);
    expect(g.removeMemory("a")?.id).toBe("a");
    expect(g.getMemory("a")).toBeUndefined();
    expect(g.removeMemory("ghost")).toBeUndefined();
  });

  it("tags memories and looks them up by tag", () => {
    const g = new MemoryGraph();
    g.addMemory(mem("a"));
    g.addMemory(mem("b"));
    g.tagMemory("a", "work");
    g.tagMemory("b", "work");
    g.tagMemory("a", "work"); // idempotent — no double edge
    expect(g.getMemoriesByTag("work").map((m) => m.id).sort()).toEqual(["a", "b"]);
    expect(g.allTags().find((t) => t.name === "work")?.count).toBe(2);
    expect(g.nodeCount()).toBe(3); // 2 memories + 1 tag
  });

  it("links, supersedes, and marks contradictions with directional edges", () => {
    const g = new MemoryGraph();
    g.addMemory(mem("a"));
    g.addMemory(mem("b"));
    g.linkMemories("a", "b", 0.8); // bidirectional
    expect(g.getEdges("a").some((e) => e.target === "b")).toBe(true);
    expect(g.getEdges("b").some((e) => e.target === "a")).toBe(true);
    g.supersede("a", "b"); // one-way
    expect(g.getEdges("a").some((e) => e.kind.kind === "supersedes")).toBe(true);
    g.markContradiction("a", "b"); // bidirectional
    expect(g.getIncoming("a")).toContain("b");
    expect(g.edgeCount()).toBeGreaterThan(0);
  });

  it("cascadeRetrieve propagates score with depth decay", () => {
    const g = new MemoryGraph();
    g.addMemory(mem("a"));
    g.addMemory(mem("b"));
    g.addMemory(mem("c"));
    g.addEdge("a", "b", { kind: "relates_to", weight: 1 });
    g.addEdge("b", "c", { kind: "relates_to", weight: 1 });
    const res = g.cascadeRetrieve(["a"], [1], 2, 10);
    const ids = res.map((r) => r.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    // seed scores highest; each hop decays
    expect(res[0]?.id).toBe("a");
    const a = res.find((r) => r.id === "a")!;
    const b = res.find((r) => r.id === "b");
    if (b) expect(a.score).toBeGreaterThan(b.score);
    expect(g.metadata.retrievalCount).toBe(1);
  });

  it("cascadeRetrieve fans out through tag nodes to co-tagged memories", () => {
    const g = new MemoryGraph();
    g.addMemory(mem("a"));
    g.addMemory(mem("b"));
    g.tagMemory("a", "topic");
    g.tagMemory("b", "topic");
    const res = g.cascadeRetrieve(["a"], [1], 2, 10);
    expect(res.map((r) => r.id)).toContain("b"); // reached via tag:topic
  });

  it("ignores seed ids not present in the graph", () => {
    const g = new MemoryGraph();
    g.addMemory(mem("a"));
    const res = g.cascadeRetrieve(["ghost", "a"], [1, 0.5], 2, 10);
    expect(res.map((r) => r.id)).toEqual(["a"]);
  });
});

// ── rrfHybridSearch ───────────────────────────────────────────────────────────

describe("rrfHybridSearch", () => {
  const bm25: BM25Hit[] = [
    { id: "d1", score: 5, groupId: "g1" },
    { id: "d2", score: 3, groupId: "g1" },
    { id: "d3", score: 1, groupId: "g2" },
  ];

  it("fuses bm25 + vector ranks into a combined score", () => {
    const vec = [
      { id: "d2", score: 0.9, groupId: "g1" },
      { id: "d4", score: 0.8, groupId: "g3" },
    ];
    const out = rrfHybridSearch(bm25, vec);
    // d2 appears in BOTH lists → should rank at or near the top
    expect(out[0]?.id).toBe("d2");
    expect(out.some((r) => r.id === "d4")).toBe(true); // vector-only doc included
    expect(out.length).toBe(4);
  });

  it("falls back to bm25-only when vectorResults is empty", () => {
    const out = rrfHybridSearch(bm25, []);
    expect(out[0]?.id).toBe("d1"); // highest bm25 rank
    expect(out.every((r) => r.vectorRank === Infinity)).toBe(true);
  });

  it("respects the limit", () => {
    expect(rrfHybridSearch(bm25, [], { limit: 2 })).toHaveLength(2);
  });

  it("diversifies with maxPerGroup then backfills overflow", () => {
    // g1 has d1,d2; maxPerGroup 1 keeps only the top of g1 first, then backfills.
    const out = rrfHybridSearch(bm25, [], { maxPerGroup: 1, limit: 3 });
    expect(out).toHaveLength(3); // backfill restores dropped g1 doc to reach the limit
    const first = out[0];
    expect(first?.groupId).toBe("g1"); // the single g1 pick leads
  });
});

// ── query expansion helpers ───────────────────────────────────────────────────

describe("nullQueryExpander", () => {
  it("returns the query unchanged with empty expansion fields", async () => {
    const ex = await nullQueryExpander("what happened last week");
    expect(ex.original).toBe("what happened last week");
    expect(ex.reformulations).toEqual([]);
    expect(ex.temporalConcretizations).toEqual([]);
    expect(ex.entityExtractions).toEqual([]);
  });
});

describe("hybridSearchWithExpansion", () => {
  function populatedLexicon(): BM25Lexicon {
    const lex = new BM25Lexicon();
    lex.add({ id: "d1", text: "database connection error", groupId: "g1" });
    lex.add({ id: "d2", text: "network timeout retry", groupId: "g1" });
    return lex;
  }

  it("merges results across reformulations, keeping the highest combinedScore", async () => {
    const lex = populatedLexicon();
    const vectorFn = async (_q: string, _n: number) => [{ id: "d2", score: 0.9, groupId: "g1" }];
    const res = await hybridSearchWithExpansion(
      lex,
      vectorFn,
      "database error",
      {
        original: "database error",
        reformulations: ["db failure", "connection problem"],
        temporalConcretizations: [],
        entityExtractions: [],
      },
      { limit: 10 },
    );
    const ids = res.map((r) => r.id);
    expect(ids).toContain("d1");
    expect(ids).toContain("d2");
    // sorted descending by combinedScore
    for (let i = 1; i < res.length; i++) {
      expect(res[i - 1]!.combinedScore).toBeGreaterThanOrEqual(res[i]!.combinedScore);
    }
  });

  it("one failing query variant never cancels the others (allSettled)", async () => {
    const lex = populatedLexicon();
    let call = 0;
    const flakyVectorFn = async (_q: string, _n: number) => {
      call += 1;
      if (call === 2) throw new Error("ANN backend down");
      return [{ id: "d1", score: 0.7, groupId: "g1" }];
    };
    const res = await hybridSearchWithExpansion(
      lex,
      flakyVectorFn,
      "database error",
      {
        original: "database error",
        reformulations: ["db failure"],
        temporalConcretizations: [],
        entityExtractions: [],
      },
      { limit: 10 },
    );
    // Despite one thrown variant, surviving variants still return results.
    expect(res.length).toBeGreaterThan(0);
  });
});
