// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  FixedEmbedder,
  InMemoryStore,
  MemoryManager,
  MemoryError,
  cosineSimilarity,
  normalize,
} from "../src/index.js";

// ── Math helpers ──────────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 0, 0, 1];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 for zero vector", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("returns 0 for mismatched dimensions", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });
});

describe("normalize", () => {
  it("produces unit vector", () => {
    const v = normalize([3, 4]);
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(mag).toBeCloseTo(1);
  });

  it("returns zero vector unchanged", () => {
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

// ── FixedEmbedder ─────────────────────────────────────────────────────────────

describe("FixedEmbedder", () => {
  it("produces vector of correct dimensions", async () => {
    const embedder = new FixedEmbedder(64);
    const v = await embedder.embed("hello world");
    expect(v).toHaveLength(64);
  });

  it("is deterministic — same text → same vector", async () => {
    const embedder = new FixedEmbedder();
    const a = await embedder.embed("test string");
    const b = await embedder.embed("test string");
    expect(a).toEqual(b);
  });

  it("different text → different vector", async () => {
    const embedder = new FixedEmbedder();
    const a = await embedder.embed("apple");
    const b = await embedder.embed("zebra");
    expect(a).not.toEqual(b);
  });

  it("produces normalised (unit) vectors", async () => {
    const embedder = new FixedEmbedder();
    const v = await embedder.embed("normalised check");
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(mag).toBeCloseTo(1, 5);
  });
});

// ── InMemoryStore ─────────────────────────────────────────────────────────────

describe("InMemoryStore", () => {
  const makeEntry = (id: string, text: string, embedding: number[], metadata = {}) => ({
    id,
    text,
    embedding,
    metadata,
    createdAt: Math.floor(Date.now() / 1000),
  });

  it("saves and lists entries", async () => {
    const store = new InMemoryStore();
    await store.save(makeEntry("a", "hello", [1, 0]));
    await store.save(makeEntry("b", "world", [0, 1]));
    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  it("search returns closest vector first", async () => {
    const store = new InMemoryStore();
    await store.save(makeEntry("x", "cat", [1, 0, 0]));
    await store.save(makeEntry("y", "dog", [0, 1, 0]));
    await store.save(makeEntry("z", "fish", [0, 0, 1]));
    const results = await store.search([1, 0, 0], 3);
    expect(results[0]!.entry.id).toBe("x");
    expect(results[0]!.score).toBeCloseTo(1);
  });

  it("delete removes an entry", async () => {
    const store = new InMemoryStore();
    await store.save(makeEntry("del-me", "gone", [1, 0]));
    await store.delete("del-me");
    const all = await store.list();
    expect(all.find((e) => e.id === "del-me")).toBeUndefined();
  });

  it("delete is a no-op for unknown id", async () => {
    const store = new InMemoryStore();
    await expect(store.delete("nonexistent")).resolves.not.toThrow();
  });

  it("filters by metadata", async () => {
    const store = new InMemoryStore();
    await store.save(makeEntry("a1", "one", [1, 0], { agent: "alpha" }));
    await store.save(makeEntry("a2", "two", [0, 1], { agent: "beta" }));
    const results = await store.list({ metadata: { agent: "alpha" } });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("a1");
  });

  it("excludes expired entries by default", async () => {
    const store = new InMemoryStore();
    const now = Math.floor(Date.now() / 1000);
    await store.save({ ...makeEntry("exp", "expired", [1, 0]), expiresAt: now - 10 });
    await store.save(makeEntry("live", "live", [0, 1]));
    const results = await store.list();
    expect(results.find((e) => e.id === "exp")).toBeUndefined();
    expect(results.find((e) => e.id === "live")).toBeDefined();
  });

  it("includes expired entries when excludeExpired=false", async () => {
    const store = new InMemoryStore();
    const now = Math.floor(Date.now() / 1000);
    await store.save({ ...makeEntry("exp2", "expired", [1, 0]), expiresAt: now - 1 });
    const results = await store.list({ excludeExpired: false });
    expect(results.find((e) => e.id === "exp2")).toBeDefined();
  });

  it("purge removes matching entries and returns count", async () => {
    const store = new InMemoryStore();
    await store.save(makeEntry("p1", "a", [1, 0], { tag: "old" }));
    await store.save(makeEntry("p2", "b", [0, 1], { tag: "old" }));
    await store.save(makeEntry("p3", "c", [1, 1], { tag: "new" }));
    const count = await store.purge({ metadata: { tag: "old" } });
    expect(count).toBe(2);
    expect(store.size).toBe(1);
  });
});

// ── MemoryManager ─────────────────────────────────────────────────────────────

describe("MemoryManager", () => {
  let manager: MemoryManager;

  beforeEach(() => {
    manager = new MemoryManager({
      store: new InMemoryStore(),
      embedder: new FixedEmbedder(),
    });
  });

  it("remember stores text and returns entry with id", async () => {
    const entry = await manager.remember("The sky is blue");
    expect(entry.id).toBeTypeOf("string");
    expect(entry.text).toBe("The sky is blue");
    expect(entry.embedding).toHaveLength(128);
  });

  it("remember sets metadata", async () => {
    const entry = await manager.remember("memo", { metadata: { agentId: "agent-1" } });
    expect(entry.metadata.agentId).toBe("agent-1");
  });

  it("remember sets expiresAt when ttl provided", async () => {
    const entry = await manager.remember("temp", { ttl: 60 });
    expect(entry.expiresAt).toBeTypeOf("number");
    expect(entry.expiresAt! - entry.createdAt).toBe(60);
  });

  it("recall returns relevant entries", async () => {
    await manager.remember("user prefers dark mode");
    await manager.remember("the sky is clear today");
    await manager.remember("agent completed task successfully");

    const results = await manager.recall("dark mode preference");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty("score");
    expect(results[0]).toHaveProperty("entry");
  });

  it("recall respects limit", async () => {
    for (let i = 0; i < 10; i++) await manager.remember(`memory item ${i}`);
    const results = await manager.recall("item", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("forget removes entry", async () => {
    const entry = await manager.remember("forget me");
    await manager.forget(entry.id);
    const all = await manager.list();
    expect(all.find((e) => e.id === entry.id)).toBeUndefined();
  });

  it("list returns all active entries", async () => {
    await manager.remember("alpha");
    await manager.remember("beta");
    const all = await manager.list();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("purge removes filtered entries", async () => {
    await manager.remember("item a", { metadata: { category: "work" } });
    await manager.remember("item b", { metadata: { category: "work" } });
    await manager.remember("item c", { metadata: { category: "personal" } });
    const count = await manager.purge({ metadata: { category: "work" } });
    expect(count).toBe(2);
  });

  it("stats returns correct total", async () => {
    await manager.remember("one");
    await manager.remember("two");
    const s = await manager.stats();
    expect(s.total).toBe(2);
    expect(s.oldest).toBeTypeOf("number");
    expect(s.newest).toBeTypeOf("number");
  });

  it("stats returns total=0 for empty store", async () => {
    const s = await manager.stats();
    expect(s.total).toBe(0);
    expect(s.oldest).toBeUndefined();
  });

  it("MemoryError thrown when embedder fails", async () => {
    const badEmbedder = { dimensions: 4, embed: async () => { throw new Error("boom"); } };
    const m = new MemoryManager({ store: new InMemoryStore(), embedder: badEmbedder });
    await expect(m.remember("test")).rejects.toThrow(MemoryError);
    try { await m.remember("test"); } catch (e) {
      expect((e as MemoryError).code).toBe("EMBED_FAILED");
    }
  });
});
