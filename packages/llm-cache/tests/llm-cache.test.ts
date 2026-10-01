// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MemoryPromptCache,
  KVPromptCache,
  CachingLLMProvider,
  TieredPromptCache,
  SemanticCachingLLMProvider,
  cosineSimilarity,
  CacheError,
  buildCacheKey,
  type PromptCache,
  type LLMRequest,
  type LLMResponse,
  type LLMProvider,
  type KVStoreLike,
  type EmbedFn,
} from "../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let _time = 1_000_000;
function makeNow() {
  _time = 1_000_000;
  return () => _time;
}
function advanceTime(ms: number) {
  _time += ms;
}

function makeResponse(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    id: "resp-1",
    model: "gpt-4o",
    content: "Hello!",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    provider: "openai",
    latencyMs: 200,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Say hello." }],
    ...overrides,
  };
}

// Minimal in-memory KVStore mock
function makeKVStore(): KVStoreLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = new Map<string, { value: any; expiresAt?: number }>();
  const now = () => Date.now();

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt !== undefined && now() >= entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.value as T;
    },
    async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
      const expiresAt = ttlMs && ttlMs > 0 ? now() + ttlMs : undefined;
      store.set(key, { value, expiresAt });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async keys(pattern?: string): Promise<string[]> {
      const prefix = pattern?.endsWith("*") ? pattern.slice(0, -1) : undefined;
      return [...store.keys()].filter((k) =>
        prefix !== undefined ? k.startsWith(prefix) : !pattern || pattern === "*" || k === pattern,
      );
    },
    async clear(): Promise<void> {
      store.clear();
    },
  };
}

// Null LLM provider for testing
function makeProvider(
  responses: LLMResponse[],
  opts: { name?: string; models?: string[] } = {},
): LLMProvider {
  let idx = 0;
  return {
    name: opts.name ?? "test-provider",
    models: opts.models ?? ["gpt-4o"],
    async complete(_req: LLMRequest): Promise<LLMResponse> {
      const resp = responses[idx % responses.length];
      idx++;
      if (!resp) throw new Error("No response configured");
      return { ...resp };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildCacheKey
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCacheKey", () => {
  it("produces a 64-char hex string", () => {
    const key = buildCacheKey(makeRequest());
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for identical requests", () => {
    const req = makeRequest();
    expect(buildCacheKey(req)).toBe(buildCacheKey(req));
  });

  it("differs for different models", () => {
    const k1 = buildCacheKey(makeRequest({ model: "gpt-4o" }));
    const k2 = buildCacheKey(makeRequest({ model: "claude-3-5-sonnet" }));
    expect(k1).not.toBe(k2);
  });

  it("differs for different messages", () => {
    const k1 = buildCacheKey(makeRequest({ messages: [{ role: "user", content: "hello" }] }));
    const k2 = buildCacheKey(makeRequest({ messages: [{ role: "user", content: "bye" }] }));
    expect(k1).not.toBe(k2);
  });

  it("differs for different temperatures", () => {
    const k1 = buildCacheKey(makeRequest({ temperature: 0 }));
    const k2 = buildCacheKey(makeRequest({ temperature: 0.7 }));
    expect(k1).not.toBe(k2);
  });

  it("same without temperature field vs undefined", () => {
    const k1 = buildCacheKey(makeRequest());
    const k2 = buildCacheKey(makeRequest({ temperature: undefined }));
    expect(k1).toBe(k2);
  });

  it("is order-sensitive for messages", () => {
    const k1 = buildCacheKey(
      makeRequest({
        messages: [
          { role: "user", content: "A" },
          { role: "assistant", content: "B" },
        ],
      }),
    );
    const k2 = buildCacheKey(
      makeRequest({
        messages: [
          { role: "assistant", content: "B" },
          { role: "user", content: "A" },
        ],
      }),
    );
    expect(k1).not.toBe(k2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MemoryPromptCache
// ─────────────────────────────────────────────────────────────────────────────

describe("MemoryPromptCache", () => {
  let cache: MemoryPromptCache;
  let now: () => number;

  beforeEach(() => {
    now = makeNow();
    cache = new MemoryPromptCache({ now });
  });

  // get / set basics
  it("returns undefined for missing key", async () => {
    expect(await cache.get("missing")).toBeUndefined();
  });

  it("stores and retrieves a response", async () => {
    const resp = makeResponse();
    await cache.set("k1", resp);
    const retrieved = await cache.get("k1");
    expect(retrieved).toEqual(resp);
  });

  // TTL
  it("returns undefined after TTL expires", async () => {
    await cache.set("k1", makeResponse(), 5000);
    advanceTime(3000);
    expect(await cache.get("k1")).toBeDefined();
    advanceTime(3000); // now 6000ms past — expired
    expect(await cache.get("k1")).toBeUndefined();
  });

  it("persists forever when no TTL", async () => {
    await cache.set("forever", makeResponse());
    advanceTime(9_999_999);
    expect(await cache.get("forever")).toBeDefined();
  });

  // delete
  it("delete removes an entry", async () => {
    await cache.set("k1", makeResponse());
    await cache.delete("k1");
    expect(await cache.get("k1")).toBeUndefined();
  });

  it("delete is no-op for absent key", async () => {
    await expect(cache.delete("ghost")).resolves.toBeUndefined();
  });

  // clear
  it("clear removes all entries", async () => {
    await cache.set("a", makeResponse());
    await cache.set("b", makeResponse());
    await cache.clear();
    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get("b")).toBeUndefined();
  });

  it("clear resets stats", async () => {
    await cache.set("k", makeResponse());
    await cache.get("k"); // hit
    await cache.get("missing"); // miss
    await cache.clear();
    const stats = await cache.stats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });

  // stats
  it("tracks hits and misses", async () => {
    await cache.set("k1", makeResponse());
    await cache.get("k1"); // hit
    await cache.get("k1"); // hit
    await cache.get("k2"); // miss
    const stats = await cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.size).toBe(1);
  });

  it("stats.size excludes expired entries", async () => {
    await cache.set("a", makeResponse(), 1000);
    await cache.set("b", makeResponse(), 5000);
    advanceTime(2000);
    const stats = await cache.stats();
    expect(stats.size).toBe(1); // only "b" alive
  });

  // LRU eviction
  it("evicts LRU entry when maxSize reached", async () => {
    const lru = new MemoryPromptCache({ maxSize: 3, now });
    await lru.set("a", makeResponse({ id: "a" }));
    await lru.set("b", makeResponse({ id: "b" }));
    await lru.set("c", makeResponse({ id: "c" }));
    // Access "a" to make it MRU
    await lru.get("a");
    // Insert "d" — should evict "b" (LRU)
    await lru.set("d", makeResponse({ id: "d" }));
    expect(await lru.get("b")).toBeUndefined(); // evicted
    expect(await lru.get("a")).toBeDefined();
    expect(await lru.get("c")).toBeDefined();
    expect(await lru.get("d")).toBeDefined();
  });

  it("re-inserting existing key moves it to MRU", async () => {
    const lru = new MemoryPromptCache({ maxSize: 2, now });
    await lru.set("a", makeResponse({ id: "a" }));
    await lru.set("b", makeResponse({ id: "b" }));
    // Re-set "a" — promotes it to MRU
    await lru.set("a", makeResponse({ id: "a-v2" }));
    // Insert "c" — should evict "b" (now LRU)
    await lru.set("c", makeResponse({ id: "c" }));
    expect(await lru.get("b")).toBeUndefined();
    expect(await lru.get("a")).toBeDefined();
  });

  // Expired entries count as misses
  it("expired get counts as a miss", async () => {
    await cache.set("ex", makeResponse(), 1000);
    advanceTime(2000);
    await cache.get("ex");
    const stats = await cache.stats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
  });

  // PromptCache interface compliance
  it("implements PromptCache interface", () => {
    const c: PromptCache = cache;
    expect(typeof c.get).toBe("function");
    expect(typeof c.set).toBe("function");
    expect(typeof c.delete).toBe("function");
    expect(typeof c.clear).toBe("function");
    expect(typeof c.stats).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KVPromptCache
// ─────────────────────────────────────────────────────────────────────────────

describe("KVPromptCache", () => {
  let kv: KVStoreLike;
  let cache: KVPromptCache;

  beforeEach(() => {
    kv = makeKVStore();
    cache = new KVPromptCache(kv);
  });

  it("returns undefined for missing key", async () => {
    expect(await cache.get("missing")).toBeUndefined();
  });

  it("stores and retrieves a response", async () => {
    const resp = makeResponse({ id: "kv-resp" });
    await cache.set("k1", resp);
    const retrieved = await cache.get("k1");
    expect(retrieved).toEqual(resp);
  });

  it("delete removes an entry", async () => {
    await cache.set("k1", makeResponse());
    await cache.delete("k1");
    expect(await cache.get("k1")).toBeUndefined();
  });

  it("clear removes all prefixed entries", async () => {
    await cache.set("a", makeResponse());
    await cache.set("b", makeResponse());
    // Add a non-cache entry directly in KV to ensure we don't delete it
    await kv.set("other:key", { value: 42 });
    await cache.clear();
    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get("b")).toBeUndefined();
    expect(await kv.get("other:key")).toBeDefined(); // untouched
  });

  it("tracks hits and misses", async () => {
    await cache.set("k", makeResponse());
    await cache.get("k"); // hit
    await cache.get("k"); // hit
    await cache.get("miss"); // miss
    const stats = await cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
  });

  it("stats.size reflects KV key count", async () => {
    await cache.set("a", makeResponse());
    await cache.set("b", makeResponse());
    const stats = await cache.stats();
    expect(stats.size).toBe(2);
  });

  it("uses custom key prefix", async () => {
    const prefixedCache = new KVPromptCache(kv, { keyPrefix: "llm" });
    await prefixedCache.set("k1", makeResponse());
    // Raw key should be llm:k1
    const raw = await kv.get<LLMResponse>("llm:k1");
    expect(raw).toBeDefined();
  });

  it("clear resets hit/miss stats", async () => {
    await cache.set("k", makeResponse());
    await cache.get("k");
    await cache.get("miss");
    await cache.clear();
    const stats = await cache.stats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });

  it("implements PromptCache interface", () => {
    const c: PromptCache = cache;
    expect(typeof c.get).toBe("function");
    expect(typeof c.set).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CachingLLMProvider
// ─────────────────────────────────────────────────────────────────────────────

describe("CachingLLMProvider", () => {
  let inner: LLMProvider;
  let cache: MemoryPromptCache;
  let provider: CachingLLMProvider;
  let now: () => number;

  beforeEach(() => {
    now = makeNow();
    cache = new MemoryPromptCache({ now });
    inner = makeProvider([makeResponse({ id: "r1" }), makeResponse({ id: "r2" })]);
    provider = new CachingLLMProvider(inner, cache);
  });

  // Name / models
  it("wraps provider name", () => {
    expect(provider.name).toBe("cached(test-provider)");
  });

  it("exposes inner models", () => {
    expect(provider.models).toEqual(["gpt-4o"]);
  });

  // Cache miss → delegates
  it("calls inner provider on cache miss", async () => {
    const req = makeRequest();
    const resp = await provider.complete(req);
    expect(resp.id).toBe("r1");
    expect(resp.cached).toBeUndefined();
  });

  // Cache hit → returns cached
  it("returns cached response on second call", async () => {
    const req = makeRequest();
    await provider.complete(req);
    const resp2 = await provider.complete(req);
    expect(resp2.id).toBe("r1"); // same response
    expect(resp2.cached).toBe(true);
  });

  // Cache hit doesn't call inner again
  it("inner provider called only once for repeated identical requests", async () => {
    const calls: LLMRequest[] = [];
    const trackingInner: LLMProvider = {
      name: "tracking",
      models: ["gpt-4o"],
      async complete(req) {
        calls.push(req);
        return makeResponse({ id: "once" });
      },
    };
    const p = new CachingLLMProvider(trackingInner, cache);
    const req = makeRequest();
    await p.complete(req);
    await p.complete(req);
    await p.complete(req);
    expect(calls).toHaveLength(1);
  });

  // Different requests use different cache slots
  it("caches different requests independently", async () => {
    const inner2 = makeProvider([
      makeResponse({ id: "a", content: "response A" }),
      makeResponse({ id: "b", content: "response B" }),
    ]);
    const p = new CachingLLMProvider(inner2, new MemoryPromptCache({ now }));
    const reqA = makeRequest({ messages: [{ role: "user", content: "A" }] });
    const reqB = makeRequest({ messages: [{ role: "user", content: "B" }] });
    const rA = await p.complete(reqA);
    const rB = await p.complete(reqB);
    expect(rA.content).toBe("response A");
    expect(rB.content).toBe("response B");
  });

  // TTL
  it("respects defaultTtlMs — serves from cache within TTL", async () => {
    const p = new CachingLLMProvider(inner, cache, { defaultTtlMs: 5000 });
    const req = makeRequest();
    await p.complete(req);
    advanceTime(3000);
    const resp = await p.complete(req);
    expect(resp.cached).toBe(true);
  });

  it("re-fetches after TTL expires", async () => {
    const p = new CachingLLMProvider(inner, cache, { defaultTtlMs: 2000 });
    const req = makeRequest();
    await p.complete(req);
    advanceTime(3000); // TTL expired
    const resp = await p.complete(req);
    expect(resp.cached).toBeUndefined(); // fresh fetch
  });

  // noCache
  it("bypasses cache when metadata.noCache is true", async () => {
    const req = makeRequest({ metadata: { noCache: true } });
    const r1 = await provider.complete(req);
    const r2 = await provider.complete(req);
    // Both should be fresh — inner called twice
    expect(r1.id).toBe("r1");
    expect(r2.id).toBe("r2");
    expect(r1.cached).toBeUndefined();
    expect(r2.cached).toBeUndefined();
  });

  it("noCache: false still uses cache", async () => {
    const req = makeRequest({ metadata: { noCache: false } });
    await provider.complete(req);
    const resp2 = await provider.complete(req);
    expect(resp2.cached).toBe(true);
  });

  it("respectNoCache: false option ignores metadata.noCache", async () => {
    const p = new CachingLLMProvider(inner, cache, { respectNoCache: false });
    const req = makeRequest({ metadata: { noCache: true } });
    await p.complete(req);
    const resp2 = await p.complete(req);
    expect(resp2.cached).toBe(true);
  });

  // Custom key function
  it("custom keyFn overrides default key derivation", async () => {
    const keyFn = vi.fn(() => "fixed-key");
    const p = new CachingLLMProvider(inner, cache, { keyFn });

    const req1 = makeRequest({ messages: [{ role: "user", content: "A" }] });
    const req2 = makeRequest({ messages: [{ role: "user", content: "B" }] });
    await p.complete(req1);
    const resp2 = await p.complete(req2); // same fixed key → hit
    expect(resp2.cached).toBe(true);
    expect(keyFn).toHaveBeenCalledTimes(2);
  });

  // promptCache accessor
  it("exposes cache via promptCache accessor", () => {
    expect(provider.promptCache).toBe(cache);
  });

  // Stats via cache
  it("cache stats reflect caching activity", async () => {
    const req = makeRequest();
    await provider.complete(req); // miss
    await provider.complete(req); // hit
    await provider.complete(req); // hit
    const stats = await cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
  });

  // Implements LLMProvider
  it("implements LLMProvider interface", () => {
    const p: LLMProvider = provider;
    expect(typeof p.complete).toBe("function");
    expect(typeof p.name).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CacheError
// ─────────────────────────────────────────────────────────────────────────────

describe("CacheError", () => {
  it("has correct name, code, and context", () => {
    const err = new CacheError("cache miss", "MISS", { key: "x" });
    expect(err.name).toBe("CacheError");
    expect(err.code).toBe("MISS");
    expect(err.context?.key).toBe("x");
    expect(err instanceof Error).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TieredPromptCache (Track C — multi-layer)
// ─────────────────────────────────────────────────────────────────────────────

describe("TieredPromptCache", () => {
  let l1: MemoryPromptCache;
  let l2: KVPromptCache;
  let tier: TieredPromptCache;

  beforeEach(() => {
    l1 = new MemoryPromptCache();
    l2 = new KVPromptCache(makeKVStore());
    tier = new TieredPromptCache(l1, l2);
  });

  it("write-through stores in both layers", async () => {
    await tier.set("k", makeResponse());
    expect(await l1.get("k")).toBeDefined();
    expect(await l2.get("k")).toBeDefined();
  });

  it("serves from L1 without touching L2", async () => {
    await l1.set("k", makeResponse({ content: "from-l1" }));
    const r = await tier.get("k");
    expect(r?.content).toBe("from-l1");
  });

  it("on L1 miss falls back to L2 and promotes into L1", async () => {
    await l2.set("k", makeResponse({ content: "from-l2" }));
    expect(await l1.get("k")).toBeUndefined(); // not in L1 yet

    const r = await tier.get("k");
    expect(r?.content).toBe("from-l2");
    // promoted: now present in L1
    expect((await l1.get("k"))?.content).toBe("from-l2");
  });

  it("counts hits and misses; size reflects L1", async () => {
    await tier.set("k", makeResponse());
    await tier.get("k"); // hit
    await tier.get("missing"); // miss
    const s = await tier.stats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.size).toBe(1);
  });

  it("delete and clear remove from both layers", async () => {
    await tier.set("k", makeResponse());
    await tier.delete("k");
    expect(await l1.get("k")).toBeUndefined();
    expect(await l2.get("k")).toBeUndefined();

    await tier.set("k2", makeResponse());
    await tier.clear();
    expect(await l1.get("k2")).toBeUndefined();
    expect(await l2.get("k2")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SemanticCachingLLMProvider (Track C — semantic/approximate cache)
// ─────────────────────────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors and 0 for orthogonal", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it("guards degenerate input", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
  });
});

describe("SemanticCachingLLMProvider", () => {
  // Deterministic embedder: maps known phrases to vectors so we control similarity.
  const vectors: Record<string, number[]> = {
    "how do I reset my password": [1, 0, 0],
    "how can I reset the password": [0.99, 0.01, 0], // near-duplicate
    "what is the capital of france": [0, 1, 0], // unrelated
  };
  const embed: EmbedFn = async (text) => vectors[text.toLowerCase()] ?? [0, 0, 1];

  function countingProvider(resp: LLMResponse) {
    let calls = 0;
    const p: LLMProvider = {
      name: "inner",
      models: ["gpt-4o"],
      async complete() {
        calls++;
        return { ...resp };
      },
    };
    return { p, calls: () => calls };
  }

  it("returns a cached response for a paraphrase above threshold", async () => {
    const { p, calls } = countingProvider(makeResponse({ content: "Use the reset link." }));
    const sem = new SemanticCachingLLMProvider(p, embed, { threshold: 0.95 });

    const r1 = await sem.complete(
      makeRequest({ messages: [{ role: "user", content: "How do I reset my password" }] }),
    );
    expect(r1.cached).toBeFalsy();

    const r2 = await sem.complete(
      makeRequest({ messages: [{ role: "user", content: "How can I reset the password" }] }),
    );
    expect(r2.cached).toBe(true);
    expect(r2.content).toBe("Use the reset link.");
    expect(calls()).toBe(1); // inner provider only called once
  });

  it("misses for a semantically different request", async () => {
    const { p, calls } = countingProvider(makeResponse());
    const sem = new SemanticCachingLLMProvider(p, embed, { threshold: 0.95 });
    await sem.complete(
      makeRequest({ messages: [{ role: "user", content: "How do I reset my password" }] }),
    );
    await sem.complete(
      makeRequest({ messages: [{ role: "user", content: "What is the capital of France" }] }),
    );
    expect(calls()).toBe(2);
    expect(sem.stats()).toMatchObject({ hits: 0, misses: 2 });
  });

  it("does not match across different models", async () => {
    const { p, calls } = countingProvider(makeResponse());
    const sem = new SemanticCachingLLMProvider(p, embed, { threshold: 0.95 });
    await sem.complete(
      makeRequest({
        model: "gpt-4o",
        messages: [{ role: "user", content: "How do I reset my password" }],
      }),
    );
    await sem.complete(
      makeRequest({
        model: "claude",
        messages: [{ role: "user", content: "How can I reset the password" }],
      }),
    );
    expect(calls()).toBe(2); // different model → no semantic hit
  });

  it("respects noCache metadata", async () => {
    const { p, calls } = countingProvider(makeResponse());
    const sem = new SemanticCachingLLMProvider(p, embed);
    const req = makeRequest({
      messages: [{ role: "user", content: "How do I reset my password" }],
    });
    await sem.complete(req);
    await sem.complete({ ...req, metadata: { noCache: true } });
    expect(calls()).toBe(2);
  });
});
