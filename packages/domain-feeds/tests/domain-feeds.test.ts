// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  FeedAdapter,
  FeedCache,
  FeedRegistry,
  AviationFeed,
  ClimateFeed,
  ConflictFeed,
  EconomicFeed,
  DisplacementFeed,
  CyberFeed,
  HealthFeed,
  ImageryFeed,
  SeismologyFeed,
  WildfireFeed,
  MaritimeFeed,
  type FeedEvent,
  type AviationEvent,
  type SeismologyEvent,
  type HttpGetFn,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockHttp(response: unknown): HttpGetFn {
  return async () => response;
}

function makeAviationEvents(count = 2): AviationEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `av-${i}`,
    timestamp: new Date().toISOString(),
    source: "test",
    summary: `Aviation event ${i}`,
    alertType: "delay" as const,
  }));
}

// ── FeedCache ─────────────────────────────────────────────────────────────────

describe("FeedCache", () => {
  it("stores and retrieves events", () => {
    const cache = new FeedCache();
    const events: FeedEvent[] = [{ id: "1", timestamp: "t", source: "s", summary: "e" }];
    cache.set("aviation", events);
    const got = cache.get("aviation");
    expect(got).toHaveLength(1);
    expect(got![0]!.id).toBe("1");
  });

  it("returns null for missing domain", () => {
    const cache = new FeedCache();
    expect(cache.get("unknown")).toBeNull();
  });

  it("returns null after TTL expires", async () => {
    const cache = new FeedCache(10); // 10ms TTL
    cache.set("aviation", [{ id: "1", timestamp: "t", source: "s", summary: "e" }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get("aviation")).toBeNull();
  });

  it("invalidate removes a specific domain", () => {
    const cache = new FeedCache();
    cache.set("aviation", [{ id: "1", timestamp: "t", source: "s", summary: "e" }]);
    cache.set("climate", [{ id: "2", timestamp: "t", source: "s", summary: "e" }]);
    cache.invalidate("aviation");
    expect(cache.get("aviation")).toBeNull();
    expect(cache.get("climate")).not.toBeNull();
  });

  it("clear removes all entries", () => {
    const cache = new FeedCache();
    cache.set("aviation", [{ id: "1", timestamp: "t", source: "s", summary: "e" }]);
    cache.set("climate", [{ id: "2", timestamp: "t", source: "s", summary: "e" }]);
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it("size and domains reflect stored entries", () => {
    const cache = new FeedCache();
    cache.set("aviation", []);
    cache.set("cyber", []);
    expect(cache.size()).toBe(2);
    expect(cache.domains()).toContain("aviation");
    expect(cache.domains()).toContain("cyber");
  });

  it("returns a defensive copy so mutations do not affect cache", () => {
    const cache = new FeedCache();
    const events: FeedEvent[] = [{ id: "1", timestamp: "t", source: "s", summary: "e" }];
    cache.set("aviation", events);
    const got = cache.get("aviation")!;
    got.push({ id: "2", timestamp: "t", source: "s", summary: "e2" });
    expect(cache.get("aviation")).toHaveLength(1);
  });
});

// ── AviationFeed ──────────────────────────────────────────────────────────────

describe("AviationFeed", () => {
  it("fetch returns typed events from HTTP", async () => {
    const events = makeAviationEvents(3);
    const feed = new AviationFeed({
      baseUrl: "https://api.example.com",
      http: makeMockHttp(events),
    });
    const result = await feed.fetch();
    expect(result).toHaveLength(3);
    expect(result[0]!.alertType).toBe("delay");
  });

  it("falls back to mock when HTTP returns non-array", async () => {
    const feed = new AviationFeed({
      baseUrl: "https://api.example.com",
      http: makeMockHttp({ error: "not found" }),
    });
    const result = await feed.fetch();
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.id).toMatch(/aviation/);
  });

  it("includes Authorization header when apiKey is set", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const feed = new AviationFeed({
      baseUrl: "https://api.example.com",
      apiKey: "test-key",
      http: async (_url, headers) => {
        capturedHeaders = headers;
        return [];
      },
    });
    await feed.fetch();
    expect(capturedHeaders?.["Authorization"]).toBe("Bearer test-key");
  });

  it("includes Origin header when corsOrigin is set", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const feed = new AviationFeed({
      baseUrl: "https://api.example.com",
      corsOrigin: "https://my-app.com",
      http: async (_url, headers) => {
        capturedHeaders = headers;
        return [];
      },
    });
    await feed.fetch();
    expect(capturedHeaders?.["Origin"]).toBe("https://my-app.com");
  });

  it("domain is 'aviation'", () => {
    const feed = new AviationFeed({ baseUrl: "https://x.com" });
    expect(feed.domain).toBe("aviation");
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

describe("FeedAdapter rate limiting", () => {
  it("checkRateLimit returns true within limit", () => {
    const feed = new AviationFeed({ baseUrl: "https://x.com", rateLimitRpm: 5 });
    for (let i = 0; i < 5; i++) {
      expect(feed.checkRateLimit()).toBe(true);
    }
  });

  it("checkRateLimit returns false when limit exceeded", () => {
    const feed = new AviationFeed({ baseUrl: "https://x.com", rateLimitRpm: 3 });
    feed.checkRateLimit();
    feed.checkRateLimit();
    feed.checkRateLimit();
    expect(feed.checkRateLimit()).toBe(false);
  });

  it("fetch throws when rate limit is hit", async () => {
    const feed = new AviationFeed({
      baseUrl: "https://x.com",
      rateLimitRpm: 1,
      http: makeMockHttp([]),
    });
    await feed.fetch(); // consumes the single slot
    await expect(feed.fetch()).rejects.toThrow("Rate limit exceeded");
  });
});

// ── All 11 domain adapters ────────────────────────────────────────────────────

describe("All domain adapters – mock fallback", () => {
  const adapters = [
    { Cls: ClimateFeed, domain: "climate" },
    { Cls: ConflictFeed, domain: "conflict" },
    { Cls: EconomicFeed, domain: "economic" },
    { Cls: DisplacementFeed, domain: "displacement" },
    { Cls: CyberFeed, domain: "cyber" },
    { Cls: HealthFeed, domain: "health" },
    { Cls: ImageryFeed, domain: "imagery" },
    { Cls: WildfireFeed, domain: "wildfire" },
    { Cls: MaritimeFeed, domain: "maritime" },
  ] as const;

  for (const { Cls, domain } of adapters) {
    it(`${domain} adapter domain property and mock fallback`, async () => {
      const feed = new (Cls as any)({
        baseUrl: "https://api.example.com",
        http: makeMockHttp("not-an-array"),
      });
      expect(feed.domain).toBe(domain);
      const result = await feed.fetch();
      expect(result.length).toBeGreaterThan(0);
      result.forEach((e: FeedEvent) => {
        expect(e.id).toContain(domain);
        expect(typeof e.timestamp).toBe("string");
        expect(typeof e.summary).toBe("string");
      });
    });
  }
});

// ── SeismologyFeed – query string ─────────────────────────────────────────────

describe("SeismologyFeed", () => {
  it("appends minMagnitude query string when provided", async () => {
    let capturedUrl = "";
    const feed = new SeismologyFeed({
      baseUrl: "https://api.example.com",
      http: async (url) => {
        capturedUrl = url;
        return [];
      },
    });
    await feed.fetch({ minMagnitude: 5 });
    expect(capturedUrl).toContain("minMagnitude=5");
  });

  it("omits query string when minMagnitude not provided", async () => {
    let capturedUrl = "";
    const feed = new SeismologyFeed({
      baseUrl: "https://api.example.com",
      http: async (url) => {
        capturedUrl = url;
        return [];
      },
    });
    await feed.fetch();
    expect(capturedUrl).not.toContain("minMagnitude");
  });

  it("domain is 'seismology'", () => {
    const feed = new SeismologyFeed({ baseUrl: "https://x.com" });
    expect(feed.domain).toBe("seismology");
  });
});

// ── FeedRegistry ──────────────────────────────────────────────────────────────

describe("FeedRegistry", () => {
  let registry: FeedRegistry;

  beforeEach(() => {
    registry = new FeedRegistry();
  });

  it("registers and retrieves adapter", () => {
    const feed = new AviationFeed({ baseUrl: "https://x.com", http: makeMockHttp([]) });
    registry.register(feed);
    expect(registry.get("aviation")).toBe(feed);
  });

  it("domains() returns registered domain names", () => {
    registry.register(new AviationFeed({ baseUrl: "https://x.com", http: makeMockHttp([]) }));
    registry.register(new ClimateFeed({ baseUrl: "https://x.com", http: makeMockHttp([]) }));
    expect(registry.domains()).toContain("aviation");
    expect(registry.domains()).toContain("climate");
  });

  it("fetch returns FeedPage with cached: false on first call", async () => {
    const events = makeAviationEvents(2);
    registry.register(new AviationFeed({ baseUrl: "https://x.com", http: makeMockHttp(events) }));
    const page = await registry.fetch("aviation");
    expect(page.domain).toBe("aviation");
    expect(page.cached).toBe(false);
    expect(page.totalCount).toBe(2);
    expect(page.events).toHaveLength(2);
    expect(typeof page.fetchedAt).toBe("string");
  });

  it("fetch returns cached: true on second call", async () => {
    const events = makeAviationEvents(2);
    const httpFn = vi.fn(async () => events);
    registry.register(new AviationFeed({ baseUrl: "https://x.com", http: httpFn }));
    await registry.fetch("aviation");
    const page = await registry.fetch("aviation");
    expect(page.cached).toBe(true);
    expect(httpFn).toHaveBeenCalledTimes(1); // second call used cache
  });

  it("fetch throws for unregistered domain", async () => {
    await expect(registry.fetch("unknown-domain")).rejects.toThrow("No feed adapter registered");
  });

  it("fetchAll returns pages for all registered adapters", async () => {
    registry.register(
      new AviationFeed({ baseUrl: "https://x.com", http: makeMockHttp(makeAviationEvents(1)) }),
    );
    registry.register(new ClimateFeed({ baseUrl: "https://x.com", http: makeMockHttp([]) }));
    const pages = await registry.fetchAll();
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.domain)).toContain("aviation");
    expect(pages.map((p) => p.domain)).toContain("climate");
  });

  it("fetchAll filters out failed domains", async () => {
    registry.register(
      new AviationFeed({
        baseUrl: "https://x.com",
        http: makeMockHttp(makeAviationEvents(1)),
      }),
    );
    registry.register(
      new ClimateFeed({
        baseUrl: "https://x.com",
        http: async () => {
          throw new Error("network error");
        },
      }),
    );
    const pages = await registry.fetchAll();
    expect(pages).toHaveLength(1);
    expect(pages[0]!.domain).toBe("aviation");
  });

  it("getCache returns the FeedCache instance", () => {
    expect(registry.getCache()).toBeDefined();
  });

  it("baseUrl trailing slash is stripped", async () => {
    let capturedUrl = "";
    const feed = new AviationFeed({
      baseUrl: "https://api.example.com/",
      http: async (url) => {
        capturedUrl = url;
        return [];
      },
    });
    await feed.fetch();
    expect(capturedUrl).not.toContain("//aviation");
    expect(capturedUrl).toContain("/aviation/events");
  });

  it("register supports chaining", () => {
    const result = registry
      .register(new AviationFeed({ baseUrl: "https://x.com", http: makeMockHttp([]) }))
      .register(new ClimateFeed({ baseUrl: "https://x.com", http: makeMockHttp([]) }));
    expect(result).toBe(registry);
    expect(registry.domains()).toHaveLength(2);
  });
});
