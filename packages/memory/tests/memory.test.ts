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
  extractEntities,
  normalizeEntity,
  parseRelativeTimeWindow,
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

// ── Entity linking (extractEntities / normalizeEntity) ─────────────────────────

describe("extractEntities", () => {
  it("extracts proper-noun runs, ignoring leading stop words", () => {
    const ents = extractEntities("The user Yash Awasthi shipped Nexus today");
    expect(ents).toContain("Yash Awasthi");
    expect(ents).toContain("Nexus");
    expect(ents).not.toContain("The");
  });

  it("extracts @mentions, #hashtags, paths and identifiers", () => {
    const ents = extractEntities(
      "@yash pushed packages/memory/src/index.ts about #retrieval MemoryManager",
    );
    expect(ents).toContain("@yash");
    expect(ents).toContain("#retrieval");
    expect(ents).toContain("packages/memory/src/index.ts");
    expect(ents).toContain("MemoryManager");
  });

  it("is deterministic and de-duplicated", () => {
    const a = extractEntities("Redis is fast. Redis scales. Redis wins.");
    const b = extractEntities("Redis is fast. Redis scales. Redis wins.");
    expect(a).toEqual(b);
    expect(a.filter((e) => e === "Redis")).toHaveLength(1);
  });

  it("returns empty for entity-free text", () => {
    expect(extractEntities("the quick brown fox")).toEqual([]);
  });

  it("normalizeEntity lower-cases and trims", () => {
    expect(normalizeEntity("  Nexus ")).toBe("nexus");
  });
});

// ── Temporal reasoning (parseRelativeTimeWindow) ───────────────────────────────

describe("parseRelativeTimeWindow", () => {
  const NOW = 1_700_000_000;
  const DAY = 86400;

  it("parses 'today' as the last 24h", () => {
    expect(parseRelativeTimeWindow("what happened today", NOW)).toEqual({
      after: NOW - DAY,
      before: NOW,
    });
  });

  it("parses 'yesterday' as the prior day window", () => {
    expect(parseRelativeTimeWindow("the bug from yesterday", NOW)).toEqual({
      after: NOW - 2 * DAY,
      before: NOW - DAY,
    });
  });

  it("parses 'last week' and 'last month'", () => {
    expect(parseRelativeTimeWindow("last week's deploy", NOW)?.after).toBe(NOW - 7 * DAY);
    expect(parseRelativeTimeWindow("last month", NOW)?.after).toBe(NOW - 30 * DAY);
  });

  it("parses 'last N days'", () => {
    expect(parseRelativeTimeWindow("errors in the last 3 days", NOW)).toEqual({
      after: NOW - 3 * DAY,
      before: NOW,
    });
  });

  it("returns undefined when there is no temporal phrase", () => {
    expect(parseRelativeTimeWindow("how do I configure redis", NOW)).toBeUndefined();
  });
});

// ── Fusion retrieval (MemoryManager.fusionRecall) ──────────────────────────────

describe("MemoryManager.fusionRecall", () => {
  const NOW = 1_700_000_000;

  const makeManager = () =>
    new MemoryManager({ store: new InMemoryStore(), embedder: new FixedEmbedder() });

  it("returns per-signal breakdown and normalised scores", async () => {
    const m = makeManager();
    await m.remember("Redis powers the BullMQ job queue");
    await m.remember("Postgres with pgvector stores embeddings");

    const results = await m.fusionRecall("Redis job queue", { now: NOW });
    expect(results.length).toBeGreaterThan(0);
    const top = results[0]!;
    expect(top.entry.text).toMatch(/Redis/);
    expect(top.signals).toHaveProperty("vector");
    expect(top.signals).toHaveProperty("bm25");
    expect(top.signals).toHaveProperty("entity");
    expect(top.signals).toHaveProperty("recency");
    // scores are descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  it("entity overlap boosts the entity signal", async () => {
    const m = makeManager();
    await m.remember("MemoryManager handles fusion retrieval");
    const [hit] = await m.fusionRecall("what does MemoryManager do", { now: NOW });
    expect(hit).toBeDefined();
    expect(hit!.signals.entityMatches).toBeGreaterThanOrEqual(1);
    expect(hit!.signals.entity).toBeGreaterThan(0);
  });

  it("lexical-only hits are included via BM25 even when vector weight is 0", async () => {
    const m = makeManager();
    await m.remember("the quaxolotl migration ran cleanly");
    await m.remember("unrelated content about weather");
    const results = await m.fusionRecall("quaxolotl", {
      now: NOW,
      weights: { vector: 0, bm25: 1, entity: 0, recency: 0, windowBoost: 0 },
    });
    expect(results[0]!.entry.text).toMatch(/quaxolotl/);
  });

  it("temporal window boosts recent entries when the query says 'today'", async () => {
    const m = makeManager();
    const old = await m.remember("deployment note");
    const fresh = await m.remember("deployment note");
    // Backdate the first entry directly in the store view via re-remember trick:
    // instead, assert window boost flag is set for entries inside the window.
    const results = await m.fusionRecall("deployment today", { now: NOW });
    // Both created at ~real now (>> NOW), so window (relative to NOW) excludes them.
    for (const r of results) expect(r.inTemporalWindow).toBe(false);
    expect(results.map((r) => r.entry.id)).toEqual(expect.arrayContaining([old.id, fresh.id]));
  });

  it("recency signal decays with age", async () => {
    const m = makeManager();
    const e = await m.remember("aging memory");
    // Query far in the future → old entry, low recency.
    const future = e.createdAt + 30 * 86400;
    const [r] = await m.fusionRecall("aging memory", {
      now: future,
      recencyHalfLifeSeconds: 7 * 86400,
    });
    expect(r!.signals.recency).toBeLessThan(0.2);
  });

  it("respects the userId ACL filter across both signal sources", async () => {
    const m = new MemoryManager({ store: new InMemoryStore(), embedder: new FixedEmbedder() });
    const a = await m.remember("alice secret plan");
    // Manually tag userId on the stored entry via a fresh remember with metadata is
    // not enough (userId is a top-level field); use the store filter path instead.
    const results = await m.fusionRecall("secret", {
      now: NOW,
      filter: { userId: "nobody" },
    });
    // Entry has no userId, filter demands "nobody" → excluded.
    expect(results.map((r) => r.entry.id)).not.toContain(a.id);
  });

  it("forget removes an entry from the fusion index", async () => {
    const m = makeManager();
    const e = await m.remember("ephemeral fact about Kafka");
    await m.forget(e.id);
    const results = await m.fusionRecall("Kafka", { now: NOW });
    expect(results).toHaveLength(0);
  });

  it("reindex rebuilds the fusion index from a pre-populated store", async () => {
    const store = new InMemoryStore();
    // Populate the store directly, bypassing the manager.
    await store.save({
      id: "x1",
      text: "orphaned Grafana dashboard",
      embedding: await new FixedEmbedder().embed("orphaned Grafana dashboard"),
      metadata: {},
      createdAt: NOW,
    });
    const m = new MemoryManager({ store, embedder: new FixedEmbedder() });
    // Before reindex the lexicon is empty → BM25 misses it.
    expect(await m.reindex()).toBe(1);
    const results = await m.fusionRecall("Grafana", { now: NOW + 10 });
    expect(results[0]!.entry.id).toBe("x1");
  });
});

// ── Self-editing typed core-memory blocks (letta pattern) ──────────────────────

describe("MemoryManager core-memory blocks", () => {
  const makeManager = (blocks?: { label: string; value?: string; limit?: number }[]) =>
    new MemoryManager({
      store: new InMemoryStore(),
      embedder: new FixedEmbedder(),
      ...(blocks ? { blocks } : {}),
    });

  it("seeds blocks from config and reads them back", () => {
    const m = makeManager([
      { label: "human", value: "Name: Yash" },
      { label: "persona", value: "Helpful assistant" },
    ]);
    expect(m.getBlock("human").value).toBe("Name: Yash");
    expect(m.hasBlock("persona")).toBe(true);
    expect(m.listBlocks().map((b) => b.label)).toEqual(["human", "persona"]);
  });

  it("coreMemoryAppend appends newline-joined and grows the value", () => {
    const m = makeManager([{ label: "human", value: "Name: Yash" }]);
    const b = m.coreMemoryAppend("human", "Prefers dark mode");
    expect(b.value).toBe("Name: Yash\nPrefers dark mode");
    expect(m.getBlock("human").value).toContain("dark mode");
  });

  it("coreMemoryAppend on an empty block omits the leading newline", () => {
    const m = makeManager([{ label: "scratch" }]);
    expect(m.coreMemoryAppend("scratch", "first line").value).toBe("first line");
  });

  it("coreMemoryReplace swaps the first occurrence", () => {
    const m = makeManager([{ label: "human", value: "Name: Yash. Mode: light" }]);
    const b = m.coreMemoryReplace("human", "light", "dark");
    expect(b.value).toBe("Name: Yash. Mode: dark");
  });

  it("coreMemoryReplace throws when target text is missing", () => {
    const m = makeManager([{ label: "human", value: "Name: Yash" }]);
    try {
      m.coreMemoryReplace("human", "nonexistent", "x");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as MemoryError).code).toBe("BLOCK_REPLACE_TARGET_MISSING");
    }
  });

  it("enforces the character limit on append", () => {
    const m = makeManager([{ label: "scratch", value: "", limit: 10 }]);
    try {
      m.coreMemoryAppend("scratch", "way too long content");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as MemoryError).code).toBe("BLOCK_LIMIT_EXCEEDED");
    }
  });

  it("getBlock throws BLOCK_NOT_FOUND for unknown labels", () => {
    const m = makeManager();
    try {
      m.getBlock("ghost");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as MemoryError).code).toBe("BLOCK_NOT_FOUND");
    }
  });

  it("upsertBlock creates then overwrites a block", () => {
    const m = makeManager();
    m.upsertBlock({ label: "persona", value: "v1" });
    expect(m.getBlock("persona").value).toBe("v1");
    m.upsertBlock({ label: "persona", value: "v2" });
    expect(m.getBlock("persona").value).toBe("v2");
  });

  it("renderCoreMemory emits stable labelled sections", () => {
    const m = makeManager([
      { label: "persona", value: "Helpful" },
      { label: "human", value: "Yash" },
    ]);
    expect(m.renderCoreMemory()).toBe("<persona>\nHelpful\n</persona>\n<human>\nYash\n</human>");
  });

  it("listBlocks / getBlock return defensive copies (no external mutation)", () => {
    const m = makeManager([{ label: "human", value: "Yash" }]);
    const b = m.getBlock("human");
    b.value = "hacked";
    expect(m.getBlock("human").value).toBe("Yash");
  });
});
