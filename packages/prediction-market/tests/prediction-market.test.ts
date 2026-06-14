// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  MarketCache,
  PmRateLimiter,
  ApiKeyAuthenticator,
  MockMarketBackend,
  PolymarketClient,
  PredictionMarketService,
  CACHE_TIERS,
  type Market,
  type CacheTierLevel,
} from "../src/index.js";

// ── CACHE_TIERS ───────────────────────────────────────────────────────────────

describe("CACHE_TIERS", () => {
  it("hot tier has shorter TTL than warm", () => {
    expect(CACHE_TIERS.hot.maxAgeMs).toBeLessThan(CACHE_TIERS.warm.maxAgeMs);
  });

  it("warm tier has shorter TTL than cold", () => {
    expect(CACHE_TIERS.warm.maxAgeMs).toBeLessThan(CACHE_TIERS.cold.maxAgeMs);
  });

  it("each tier has swr < maxAgeMs", () => {
    for (const tier of Object.values(CACHE_TIERS)) {
      expect(tier.swr).toBeLessThan(tier.maxAgeMs);
    }
  });
});

// ── MarketCache ───────────────────────────────────────────────────────────────

function makeFakeMarket(id = "m-1"): Market {
  return {
    id,
    question: "Test?",
    category: "politics",
    outcomes: [
      { id: `${id}-yes`, label: "Yes", price: 0.6, probability: 0.6 },
      { id: `${id}-no`,  label: "No",  price: 0.4, probability: 0.4 },
    ],
    volume: 1000,
    liquidity: 500,
    fetchedAt: new Date().toISOString(),
  };
}

describe("MarketCache", () => {
  it("set and get returns fresh entry", () => {
    const cache = new MarketCache();
    const m = makeFakeMarket();
    cache.set("m-1", m, "hot");
    const lookup = cache.get("m-1");
    expect(lookup.status).toBe("fresh");
    expect(lookup.value).not.toBeNull();
  });

  it("returns miss for unknown key", () => {
    const cache = new MarketCache();
    expect(cache.get("unknown").status).toBe("miss");
  });

  it("invalidate removes entry", () => {
    const cache = new MarketCache();
    cache.set("m-1", makeFakeMarket(), "warm");
    cache.invalidate("m-1");
    expect(cache.get("m-1").status).toBe("miss");
  });

  it("invalidateCategory removes matching entries", () => {
    const cache = new MarketCache();
    cache.set("m-1", makeFakeMarket("m-1"), "warm");
    cache.set("m-2", { ...makeFakeMarket("m-2"), category: "crypto" }, "warm");
    cache.invalidateCategory("politics");
    expect(cache.get("m-1").status).toBe("miss");
    expect(cache.get("m-2").status).toBe("fresh");
  });

  it("clear removes all entries", () => {
    const cache = new MarketCache();
    cache.set("m-1", makeFakeMarket(), "cold");
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

// ── PmRateLimiter ─────────────────────────────────────────────────────────────

describe("PmRateLimiter", () => {
  it("allows requests within limit", () => {
    const rl = new PmRateLimiter({ requestsPerMinute: 5 });
    const result = rl.check("key1");
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBe(0);
  });

  it("blocks when limit exceeded", () => {
    const rl = new PmRateLimiter({ requestsPerMinute: 2 });
    rl.check("key1");
    rl.check("key1");
    const result = rl.check("key1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("reset clears the window", () => {
    const rl = new PmRateLimiter({ requestsPerMinute: 1 });
    rl.check("key1");
    rl.reset("key1");
    expect(rl.check("key1").allowed).toBe(true);
  });

  it("different keys have independent windows", () => {
    const rl = new PmRateLimiter({ requestsPerMinute: 1 });
    rl.check("a");
    expect(rl.check("b").allowed).toBe(true);
  });
});

// ── ApiKeyAuthenticator ───────────────────────────────────────────────────────

describe("ApiKeyAuthenticator", () => {
  it("validates registered key", () => {
    const auth = new ApiKeyAuthenticator(["key-abc"]);
    expect(auth.validate("key-abc")).toBe(true);
  });

  it("rejects unknown key", () => {
    const auth = new ApiKeyAuthenticator(["key-abc"]);
    expect(auth.validate("bad-key")).toBe(false);
  });

  it("add makes key valid", () => {
    const auth = new ApiKeyAuthenticator([]);
    auth.add("new-key");
    expect(auth.validate("new-key")).toBe(true);
  });

  it("revoke makes key invalid", () => {
    const auth = new ApiKeyAuthenticator(["key-x"]);
    auth.revoke("key-x");
    expect(auth.validate("key-x")).toBe(false);
  });

  it("count returns number of keys", () => {
    const auth = new ApiKeyAuthenticator(["a", "b"]);
    expect(auth.count()).toBe(2);
  });
});

// ── MockMarketBackend ─────────────────────────────────────────────────────────

describe("MockMarketBackend", () => {
  it("fetchMarket returns default market", async () => {
    const backend = new MockMarketBackend();
    const market = await backend.fetchMarket("m-1");
    expect(market.id).toBe("m-1");
    expect(market.outcomes.length).toBeGreaterThan(0);
  });

  it("fetchMarkets returns list", async () => {
    const backend = new MockMarketBackend();
    const response = await backend.fetchMarkets({});
    expect(response.markets.length).toBeGreaterThan(0);
    expect(typeof response.total).toBe("number");
  });

  it("throws when configured", async () => {
    const backend = new MockMarketBackend({ throws: "service down" });
    await expect(backend.fetchMarket("m-1")).rejects.toThrow("service down");
  });

  it("fetchLog records fetched ids", async () => {
    const backend = new MockMarketBackend();
    await backend.fetchMarket("m-1");
    await backend.fetchMarket("m-2");
    expect(backend.fetchLog).toEqual(["m-1", "m-2"]);
  });

  it("category filter works", async () => {
    const backend = new MockMarketBackend();
    const response = await backend.fetchMarkets({ category: "crypto" });
    expect(response.markets.every((m) => m.category === "crypto")).toBe(true);
  });

  it("limit filter works", async () => {
    const backend = new MockMarketBackend();
    const response = await backend.fetchMarkets({ limit: 1 });
    expect(response.markets).toHaveLength(1);
  });
});

// ── PolymarketClient ──────────────────────────────────────────────────────────

describe("PolymarketClient", () => {
  it("getMarket fetches and caches", async () => {
    const backend = new MockMarketBackend();
    const client = new PolymarketClient(backend);
    const m1 = await client.getMarket("m-1");
    const m2 = await client.getMarket("m-1");
    expect(m1.id).toBe("m-1");
    expect(m2.id).toBe("m-1");
    // second call served from cache — backend called only once
    expect(backend.fetchLog).toHaveLength(1);
  });

  it("forceRefresh bypasses cache", async () => {
    const backend = new MockMarketBackend();
    const client = new PolymarketClient(backend);
    await client.getMarket("m-1");
    await client.getMarket("m-1", true);
    expect(backend.fetchLog).toHaveLength(2);
  });

  it("getMarkets fetches and caches", async () => {
    const backend = new MockMarketBackend();
    const client = new PolymarketClient(backend);
    await client.getMarkets({ limit: 2 });
    await client.getMarkets({ limit: 2 });
    // Cache hit — fetchMarkets not called again (fetchLog only tracks fetchMarket)
    expect(client.getCache().size()).toBeGreaterThan(0);
  });

  it("getCache returns MarketCache instance", () => {
    const client = new PolymarketClient(new MockMarketBackend());
    expect(client.getCache()).toBeDefined();
  });
});

// ── PredictionMarketService ───────────────────────────────────────────────────

describe("PredictionMarketService", () => {
  it("getMarket returns data without auth when no keys configured", async () => {
    const service = new PredictionMarketService({ backend: new MockMarketBackend() });
    const result = await service.getMarket("m-1");
    expect(result.data).not.toBeNull();
    expect(result.unauthorized).toBeFalsy();
  });

  it("getMarket returns unauthorized when auth required and key missing", async () => {
    const service = new PredictionMarketService({
      backend: new MockMarketBackend(),
      apiKeys: ["valid-key"],
    });
    const result = await service.getMarket("m-1");
    expect(result.unauthorized).toBe(true);
    expect(result.data).toBeNull();
  });

  it("getMarket succeeds with valid api key", async () => {
    const service = new PredictionMarketService({
      backend: new MockMarketBackend(),
      apiKeys: ["my-key"],
    });
    const result = await service.getMarket("m-1", "my-key");
    expect(result.data).not.toBeNull();
  });

  it("rate limits when rpm exceeded", async () => {
    const service = new PredictionMarketService({
      backend: new MockMarketBackend(),
      requestsPerMinute: 1,
    });
    await service.getMarket("m-1");
    const result = await service.getMarket("m-2");
    expect(result.rateLimited).toBe(true);
  });

  it("getMarkets returns list", async () => {
    const service = new PredictionMarketService({ backend: new MockMarketBackend() });
    const result = await service.getMarkets({ limit: 2 });
    expect(result.data?.markets.length).toBeLessThanOrEqual(2);
  });

  it("error from backend is captured", async () => {
    const service = new PredictionMarketService({
      backend: new MockMarketBackend({ throws: "timeout" }),
    });
    const result = await service.getMarket("m-1");
    expect(result.error).toContain("timeout");
    expect(result.data).toBeNull();
  });

  it("getClient and getRateLimiter return instances", () => {
    const service = new PredictionMarketService({ backend: new MockMarketBackend() });
    expect(service.getClient()).toBeDefined();
    expect(service.getRateLimiter()).toBeDefined();
  });
});
