// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import {
  FixedEmbedder,
  GroqEmbedder,
  InMemoryStore,
  MemoryManager,
  MemoryError,
  cosineSimilarity,
  normalize,
} from "../src/index.js";
import type { MemoryEntry } from "../src/index.js";

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
    const badEmbedder = {
      dimensions: 4,
      embed: async () => {
        throw new Error("boom");
      },
    };
    const m = new MemoryManager({ store: new InMemoryStore(), embedder: badEmbedder });
    await expect(m.remember("test")).rejects.toThrow(MemoryError);
    try {
      await m.remember("test");
    } catch (e) {
      expect((e as MemoryError).code).toBe("EMBED_FAILED");
    }
  });

  it("remember() throws STORE_WRITE_FAILED when store.save throws", async () => {
    const badStore = {
      save: async () => {
        throw new Error("write error");
      },
      search: async () => [],
      delete: async () => {},
      list: async () => [],
      purge: async () => 0,
    };
    const m = new MemoryManager({ store: badStore, embedder: new FixedEmbedder(4) });
    await expect(m.remember("test")).rejects.toMatchObject({ code: "STORE_WRITE_FAILED" });
  });

  it("recall() throws EMBED_FAILED when embedder.embed throws", async () => {
    const badEmbedder = {
      dimensions: 4,
      embed: async () => {
        throw new Error("embed fail");
      },
    };
    const m = new MemoryManager({ store: new InMemoryStore(), embedder: badEmbedder });
    await expect(m.recall("query")).rejects.toMatchObject({ code: "EMBED_FAILED" });
  });

  it("recall() throws STORE_READ_FAILED when store.search throws", async () => {
    const badStore = {
      save: async (e: MemoryEntry) => e,
      search: async () => {
        throw new Error("search error");
      },
      delete: async () => {},
      list: async () => [],
      purge: async () => 0,
    };
    const m = new MemoryManager({ store: badStore, embedder: new FixedEmbedder(4) });
    await expect(m.recall("query")).rejects.toMatchObject({ code: "STORE_READ_FAILED" });
  });
});

// ── GroqEmbedder ──────────────────────────────────────────────────────────────

const FAKE_KEY = "gsk_test_key_1234";
const FAKE_EMBEDDING = Array.from({ length: 768 }, (_, i) => i / 768);

function makeGroqResponse(embedding: number[]): Response {
  return new Response(
    JSON.stringify({ data: [{ embedding, index: 0 }], model: "nomic-embed-text-v1.5" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("GroqEmbedder", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GROQ_API_KEY;
  });

  it("throws MemoryError when no API key is provided", () => {
    delete process.env.GROQ_API_KEY;
    expect(() => new GroqEmbedder()).toThrow(MemoryError);
    expect(() => new GroqEmbedder()).toThrow(/GROQ_API_KEY/);
  });

  it("reads API key from process.env.GROQ_API_KEY", () => {
    process.env.GROQ_API_KEY = FAKE_KEY;
    expect(() => new GroqEmbedder()).not.toThrow();
  });

  it("returns 768-dim vector on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeGroqResponse(FAKE_EMBEDDING)));
    const embedder = new GroqEmbedder({ apiKey: FAKE_KEY });
    const result = await embedder.embed("hello world");
    expect(result).toHaveLength(768);
    expect(result[0]).toBeCloseTo(0);
    expect(result[767]).toBeCloseTo(767 / 768);
  });

  it("sends correct Authorization header and body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeGroqResponse(FAKE_EMBEDDING));
    vi.stubGlobal("fetch", mockFetch);
    const embedder = new GroqEmbedder({ apiKey: FAKE_KEY });
    await embedder.embed("test text");
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/embeddings");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${FAKE_KEY}`);
    const body = JSON.parse(init.body as string) as { model: string; input: string };
    expect(body.model).toBe("nomic-embed-text-v1.5");
    expect(body.input).toBe("test text");
  });

  it("respects a custom model name", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeGroqResponse(FAKE_EMBEDDING));
    vi.stubGlobal("fetch", mockFetch);
    const embedder = new GroqEmbedder({ apiKey: FAKE_KEY, model: "custom-model" });
    await embedder.embed("x");
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("custom-model");
  });

  it("throws EMBED_FAILED on non-200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    );
    const embedder = new GroqEmbedder({ apiKey: FAKE_KEY });
    await expect(embedder.embed("text")).rejects.toThrow(MemoryError);
    try {
      await embedder.embed("text");
    } catch (e) {
      expect((e as MemoryError).code).toBe("EMBED_FAILED");
      expect((e as MemoryError).message).toMatch(/401/);
    }
  });

  it("throws EMBED_FAILED on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network failure")));
    const embedder = new GroqEmbedder({ apiKey: FAKE_KEY });
    await expect(embedder.embed("text")).rejects.toThrow(MemoryError);
    try {
      await embedder.embed("text");
    } catch (e) {
      expect((e as MemoryError).code).toBe("EMBED_FAILED");
      expect((e as MemoryError).message).toMatch(/network failure/);
    }
  });

  it("throws EMBED_FAILED when response body is not valid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    const embedder = new GroqEmbedder({ apiKey: FAKE_KEY });
    await expect(embedder.embed("text")).rejects.toThrow(MemoryError);
  });

  it("throws EMBED_FAILED when data array is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ data: [], model: "m" }), { status: 200 })),
    );
    const embedder = new GroqEmbedder({ apiKey: FAKE_KEY });
    await expect(embedder.embed("text")).rejects.toMatchObject({ code: "EMBED_FAILED" });
  });

  it("throws DIMENSION_MISMATCH when API returns wrong vector length", async () => {
    const wrongDim = Array.from({ length: 512 }, () => 0.1);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeGroqResponse(wrongDim)));
    const embedder = new GroqEmbedder({ apiKey: FAKE_KEY });
    await expect(embedder.embed("text")).rejects.toMatchObject({ code: "DIMENSION_MISMATCH" });
  });
});
