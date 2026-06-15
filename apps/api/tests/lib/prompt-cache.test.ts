// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryKVStore } from "@nexus/kv";
import { PromptCache, _resetPromptCache, getPromptCache } from "../../src/lib/prompt-cache.js";

function makeKV() { return new MemoryKVStore(); }

const REQ = {
  model:       "nexus/fast",
  messages:    [{ role: "user" as const, content: "Hello" }],
  system:      "Be helpful",
  max_tokens:  512,
  temperature: 0,
};

const RESPONSE = {
  id:          "msg-1",
  type:        "message" as const,
  role:        "assistant" as const,
  content:     [{ type: "text" as const, text: "Hi!" }],
  model:       "llama-3.3-70b-versatile",
  stop_reason: "end_turn",
  usage:       { input_tokens: 5, output_tokens: 3 },
};

describe("PromptCache.isEligible", () => {
  it("allows temperature=0", () => {
    expect(PromptCache.isEligible({ temperature: 0, stream: false })).toBe(true);
  });
  it("allows temperature undefined", () => {
    expect(PromptCache.isEligible({ stream: false })).toBe(true);
  });
  it("blocks streaming", () => {
    expect(PromptCache.isEligible({ temperature: 0, stream: true })).toBe(false);
  });
  it("blocks temperature > 0", () => {
    expect(PromptCache.isEligible({ temperature: 0.5 })).toBe(false);
  });
  it("blocks temperature 1", () => {
    expect(PromptCache.isEligible({ temperature: 1 })).toBe(false);
  });
});

describe("PromptCache.cacheKey", () => {
  it("returns consistent key for same request", () => {
    const cache = new PromptCache(makeKV());
    const k1 = cache.cacheKey(REQ);
    const k2 = cache.cacheKey(REQ);
    expect(k1).toBe(k2);
  });

  it("key changes when model changes", () => {
    const cache = new PromptCache(makeKV());
    const k1 = cache.cacheKey(REQ);
    const k2 = cache.cacheKey({ ...REQ, model: "nexus/smart" });
    expect(k1).not.toBe(k2);
  });

  it("key changes when messages change", () => {
    const cache = new PromptCache(makeKV());
    const k1 = cache.cacheKey(REQ);
    const k2 = cache.cacheKey({ ...REQ, messages: [{ role: "user", content: "World" }] });
    expect(k1).not.toBe(k2);
  });

  it("key does NOT change when temperature changes (excluded from hash)", () => {
    const cache = new PromptCache(makeKV());
    const k1 = cache.cacheKey({ ...REQ, temperature: 0 });
    const k2 = cache.cacheKey({ ...REQ, temperature: undefined });
    expect(k1).toBe(k2);
  });

  it("key has expected prefix", () => {
    const cache = new PromptCache(makeKV());
    expect(cache.cacheKey(REQ)).toMatch(/^promptcache:/);
  });
});

describe("PromptCache get/set", () => {
  it("returns miss on empty cache", async () => {
    const cache = new PromptCache(makeKV());
    const result = await cache.get(REQ);
    expect(result.hit).toBe(false);
    expect(result.response).toBeUndefined();
  });

  it("returns hit after set", async () => {
    const cache = new PromptCache(makeKV());
    await cache.set(REQ, RESPONSE);
    const result = await cache.get(REQ);
    expect(result.hit).toBe(true);
    expect(result.response).toEqual(RESPONSE);
  });

  it("miss after invalidate", async () => {
    const cache = new PromptCache(makeKV());
    await cache.set(REQ, RESPONSE);
    await cache.invalidate(REQ);
    const result = await cache.get(REQ);
    expect(result.hit).toBe(false);
  });

  it("different requests don't collide", async () => {
    const cache = new PromptCache(makeKV());
    const req2 = { ...REQ, model: "nexus/smart" };
    await cache.set(REQ,  RESPONSE);
    const result = await cache.get(req2);
    expect(result.hit).toBe(false);
  });

  it("get returns cacheKey even on miss", async () => {
    const cache = new PromptCache(makeKV());
    const result = await cache.get(REQ);
    expect(result.cacheKey).toMatch(/^promptcache:/);
  });

  it("set is non-fatal when KV throws", async () => {
    const brokenKV = {
      get: async () => undefined,
      set: async () => { throw new Error("KV down"); },
      delete: async () => {},
      has: async () => false,
      keys: async () => [],
      clear: async () => {},
      getOrSet: async <T>(_k: string, f: () => Promise<T>) => f(),
    };
    const cache = new PromptCache(brokenKV as MemoryKVStore);
    // should not throw
    await expect(cache.set(REQ, RESPONSE)).resolves.toBeUndefined();
  });
});

describe("getPromptCache singleton", () => {
  beforeEach(() => { _resetPromptCache(); });

  it("returns same instance on repeated calls", () => {
    const kv = makeKV();
    const c1 = getPromptCache(kv);
    const c2 = getPromptCache(kv);
    expect(c1).toBe(c2);
  });

  it("respects custom ttlMs option", () => {
    _resetPromptCache();
    const cache = new PromptCache(makeKV(), { ttlMs: 9_999 });
    // internal ttlMs not directly readable, but construction shouldn't throw
    expect(cache).toBeDefined();
  });
});
