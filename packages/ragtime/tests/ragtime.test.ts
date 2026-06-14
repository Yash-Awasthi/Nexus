// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  RagtimeRetriever,
  compositeScore,
  InMemoryRagtimeStore,
  FixedRagtimeEmbedder,
  cosineSimilarity,
  type MemoryEntry,
} from "../src/index.js";

// ── cosineSimilarity ──────────────────────────────────────────────────────────
// Clamps result to [0, 1]: Math.max(0, Math.min(1, dot / (|a|*|b|)))

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical unit vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1.0, 5);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 5);
  });

  it("clamps negative cosine to 0 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(0);
  });

  it("returns value in [0, 1] for similar vectors", () => {
    const sim = cosineSimilarity([0.6, 0.8], [0.8, 0.6]);
    expect(sim).toBeGreaterThanOrEqual(0);
    expect(sim).toBeLessThanOrEqual(1);
    expect(sim).toBeGreaterThan(0.9);
  });

  it("returns 0 for zero vector", () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });
});

// ── compositeScore ────────────────────────────────────────────────────────────
// Signature: compositeScore(relevance, importance, ageSeconds, config)
// config: { relevanceWeight, importanceWeight, recencyWeight, recencyDecayRate }

describe("compositeScore", () => {
  const cfg = {
    relevanceWeight: 0.5,
    importanceWeight: 0.3,
    recencyWeight: 0.2,
    recencyDecayRate: 0.01,
  };

  it("returns a positive number", () => {
    expect(compositeScore(0.8, 0.7, 3600, cfg)).toBeGreaterThan(0);
  });

  it("higher relevance → higher score (all else equal)", () => {
    expect(compositeScore(0.9, 0.5, 0, cfg)).toBeGreaterThan(compositeScore(0.1, 0.5, 0, cfg));
  });

  it("older entry (larger ageSeconds) → lower score", () => {
    const fresh = compositeScore(0.7, 0.5, 0, cfg);
    const stale = compositeScore(0.7, 0.5, 1_000_000, cfg);
    expect(fresh).toBeGreaterThan(stale);
  });

  it("higher importance → higher score", () => {
    expect(compositeScore(0.5, 0.9, 0, cfg)).toBeGreaterThan(compositeScore(0.5, 0.1, 0, cfg));
  });

  it("respects custom weights", () => {
    const importanceHeavy = { ...cfg, relevanceWeight: 0.1, importanceWeight: 0.8, recencyWeight: 0.1 };
    const score = compositeScore(0.5, 1.0, 0, importanceHeavy);
    expect(score).toBeGreaterThan(0.7);
  });
});

// ── FixedRagtimeEmbedder ──────────────────────────────────────────────────────
// Character-frequency based, 32 dimensions, L2-normalised output

describe("FixedRagtimeEmbedder", () => {
  it("returns a 32-dimensional vector", async () => {
    const v = await new FixedRagtimeEmbedder().embed("hello world");
    expect(v).toHaveLength(32);
  });

  it("same input → same embedding (deterministic)", async () => {
    const emb = new FixedRagtimeEmbedder();
    expect(await emb.embed("test")).toEqual(await emb.embed("test"));
  });

  it("output is L2-normalised (magnitude ≈ 1.0)", async () => {
    const v = await new FixedRagtimeEmbedder().embed("normalisation test");
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(mag).toBeCloseTo(1.0, 3);
  });

  it("dimensions property equals 32", () => {
    expect(new FixedRagtimeEmbedder().dimensions).toBe(32);
  });
});

// ── InMemoryRagtimeStore ──────────────────────────────────────────────────────
// Methods: save(entry), delete(id), list(filter?), search(queryEmbedding, limit, filter?)

function entry(id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    text: `text for ${id}`,
    embedding: new Array(32).fill(0).map((_, i) => (i === 0 ? 1 : 0)), // unit vec on dim-0
    metadata: {},
    createdAt: Math.floor(Date.now() / 1000),
    importance: 0.5,
    ...overrides,
  };
}

describe("InMemoryRagtimeStore", () => {
  it("list() starts empty", async () => {
    expect(await new InMemoryRagtimeStore().list()).toHaveLength(0);
  });

  it("save() then list() retrieves the entry", async () => {
    const store = new InMemoryRagtimeStore();
    await store.save(entry("e1"));
    expect((await store.list()).some((e) => e.id === "e1")).toBe(true);
  });

  it("save() on same id replaces existing (upsert)", async () => {
    const store = new InMemoryRagtimeStore();
    await store.save(entry("e1", { text: "v1" }));
    await store.save(entry("e1", { text: "v2" }));
    const all = await store.list();
    expect(all.find((e) => e.id === "e1")?.text).toBe("v2");
    expect(all.filter((e) => e.id === "e1")).toHaveLength(1);
  });

  it("delete() removes the entry", async () => {
    const store = new InMemoryRagtimeStore();
    await store.save(entry("e-del"));
    await store.delete("e-del");
    expect((await store.list()).find((e) => e.id === "e-del")).toBeUndefined();
  });

  it("search() ranks by cosine similarity", async () => {
    const store = new InMemoryRagtimeStore();
    // hi: aligned with query (dim 0)
    await store.save(entry("hi", { embedding: new Array(32).fill(0).map((_, i) => (i === 0 ? 1 : 0)) }));
    // lo: orthogonal (dim 1)
    await store.save(entry("lo", { embedding: new Array(32).fill(0).map((_, i) => (i === 1 ? 1 : 0)) }));
    const qv = new Array(32).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    const results = await store.search(qv, 10);
    expect(results[0]?.entry.id).toBe("hi");
  });

  it("search() respects limit", async () => {
    const store = new InMemoryRagtimeStore();
    for (let i = 0; i < 10; i++) await store.save(entry(`d${i}`));
    expect((await store.search(new Array(32).fill(0), 3)).length).toBeLessThanOrEqual(3);
  });
});

// ── RagtimeRetriever ──────────────────────────────────────────────────────────
// Constructor: { store, embedder, config? }
// retrieve(query, k?, filter?) → RagtimeResult[]

function makeRetriever(cfg: Record<string, unknown> = {}) {
  const store = new InMemoryRagtimeStore();
  const embedder = new FixedRagtimeEmbedder();
  const retriever = new RagtimeRetriever({ store, embedder, config: { poolSize: 20, finalK: 5, ...cfg } });
  return { retriever, store };
}

describe("RagtimeRetriever", () => {
  it("returns [] when store is empty", async () => {
    expect(await makeRetriever().retriever.retrieve("query")).toHaveLength(0);
  });

  it("result has entry, relevance, importance, recencyDecay, composite", async () => {
    const { retriever, store } = makeRetriever();
    await store.save(entry("x"));
    const r = (await retriever.retrieve("test"))[0]!;
    expect(r.entry).toBeDefined();
    expect(typeof r.relevance).toBe("number");
    expect(typeof r.importance).toBe("number");
    expect(typeof r.recencyDecay).toBe("number");
    expect(typeof r.composite).toBe("number");
  });

  it("returns at most finalK results", async () => {
    const { retriever, store } = makeRetriever({ finalK: 3 });
    for (let i = 0; i < 10; i++) await store.save(entry(`d${i}`));
    expect((await retriever.retrieve("q")).length).toBeLessThanOrEqual(3);
  });

  it("results sorted by composite descending", async () => {
    const { retriever, store } = makeRetriever({ finalK: 10 });
    await store.save(entry("hi", { importance: 0.95 }));
    await store.save(entry("lo", { importance: 0.05 }));
    const results = await retriever.retrieve("query");
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.composite).toBeGreaterThanOrEqual(results[i]!.composite);
    }
  });

  it("composite scores are non-negative", async () => {
    const { retriever, store } = makeRetriever();
    await store.save(entry("x"));
    for (const r of await retriever.retrieve("test")) {
      expect(r.composite).toBeGreaterThanOrEqual(0);
    }
  });

  it("k parameter overrides finalK", async () => {
    const { retriever, store } = makeRetriever({ finalK: 10 });
    for (let i = 0; i < 10; i++) await store.save(entry(`d${i}`));
    expect((await retriever.retrieve("q", 2)).length).toBeLessThanOrEqual(2);
  });

  it("retrieveByEmbedding returns same shape", async () => {
    const { retriever, store } = makeRetriever();
    await store.save(entry("x"));
    const vec = new Array(32).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    const r = (await retriever.retrieveByEmbedding(vec))[0]!;
    expect(r.entry).toBeDefined();
    expect(typeof r.composite).toBe("number");
  });
});
