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
  TechNewsFeed,
  RedditFeed,
  PreprintsFeed,
  ArxivFeed,
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
    // A concrete FeedAdapter subclass that always throws — ensures fetchAll's
    // Promise.allSettled rejection filtering is tested without relying on
    // catch-and-mock behaviour from real adapters.
    class ErrorFeed extends FeedAdapter<never> {
      readonly domain = "error-source";
      async fetch(): Promise<never[]> {
        throw new Error("network error");
      }
    }
    registry.register(new ErrorFeed({ baseUrl: "https://x.com" }));

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

describe("TechNewsFeed (Hacker News via Algolia)", () => {
  const HN = {
    hits: [
      {
        objectID: "111",
        title: "Show HN: a thing",
        url: "https://example.com/thing",
        points: 600,
        num_comments: 120,
        author: "alice",
        created_at: "2026-06-01T00:00:00Z",
      },
      {
        objectID: "222",
        title: "low signal post",
        points: 10,
        num_comments: 1,
        author: "bob",
        created_at: "2026-06-01T01:00:00Z",
      },
    ],
  };

  it("domain is 'technews'", () => {
    expect(new TechNewsFeed({ http: makeMockHttp(HN) }).domain).toBe("technews");
  });

  it("maps Algolia hits to TechNewsEvents", async () => {
    const feed = new TechNewsFeed({ http: makeMockHttp(HN) });
    const events = await feed.fetch();
    expect(events).toHaveLength(2);
    expect(events[0]!.id).toBe("111");
    expect(events[0]!.title).toBe("Show HN: a thing");
    expect(events[0]!.points).toBe(600);
    expect(events[0]!.comments).toBe(120);
    expect(events[0]!.metadata!.hnUrl).toContain("id=111");
  });

  it("scores virality into severity", async () => {
    const feed = new TechNewsFeed({ http: makeMockHttp(HN) });
    const events = await feed.fetch();
    expect(events[0]!.severity).toBe("high"); // 600 pts
    expect(events[1]!.severity).toBe("low"); // 10 pts
  });

  it("queries the requested tag", async () => {
    let url = "";
    const feed = new TechNewsFeed({
      http: async (u) => {
        url = u;
        return HN;
      },
    });
    await feed.fetch({ tags: "ask_hn" });
    expect(url).toContain("tags=ask_hn");
  });

  it("filters by minPoints", async () => {
    const feed = new TechNewsFeed({ http: makeMockHttp(HN) });
    const events = await feed.fetch({ minPoints: 100 });
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("111");
  });

  it("falls back to mock data on empty hits", async () => {
    const feed = new TechNewsFeed({ http: makeMockHttp({ hits: [] }) });
    const events = await feed.fetch();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.source).toContain("mock");
  });
});

describe("RedditFeed", () => {
  const REDDIT = {
    data: {
      children: [
        {
          data: {
            id: "abc",
            title: "Big news",
            url: "https://example.com/big",
            subreddit: "worldnews",
            score: 12000,
            num_comments: 800,
            author: "carol",
            permalink: "/r/worldnews/comments/abc/big_news/",
            created_utc: 1_780_000_000,
          },
        },
        {
          data: {
            id: "def",
            title: "small post",
            subreddit: "worldnews",
            score: 5,
            num_comments: 0,
            author: "dave",
            created_utc: 1_780_000_100,
          },
        },
      ],
    },
  };

  it("domain is 'reddit'", () => {
    expect(new RedditFeed({ http: makeMockHttp(REDDIT) }).domain).toBe("reddit");
  });

  it("maps listing children to RedditEvents with absolute permalink", async () => {
    const feed = new RedditFeed({ http: makeMockHttp(REDDIT) });
    const events = await feed.fetch();
    expect(events).toHaveLength(2);
    expect(events[0]!.id).toBe("abc");
    expect(events[0]!.subreddit).toBe("worldnews");
    expect(events[0]!.score).toBe(12000);
    expect(events[0]!.permalink).toBe("https://www.reddit.com/r/worldnews/comments/abc/big_news/");
    expect(events[0]!.severity).toBe("high");
    expect(events[1]!.severity).toBe("low");
  });

  it("builds the subreddit/sort URL", async () => {
    let url = "";
    const feed = new RedditFeed({
      http: async (u) => {
        url = u;
        return REDDIT;
      },
    });
    await feed.fetch({ subreddit: "programming", sort: "top" });
    expect(url).toContain("/r/programming/top.json");
  });

  it("filters by minScore", async () => {
    const feed = new RedditFeed({ http: makeMockHttp(REDDIT) });
    const events = await feed.fetch({ minScore: 1000 });
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("abc");
  });

  it("falls back to mock on empty listing", async () => {
    const feed = new RedditFeed({ http: makeMockHttp({ data: { children: [] } }) });
    const events = await feed.fetch();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.source).toContain("mock");
  });
});

describe("PreprintsFeed (bioRxiv details API)", () => {
  const BIORXIV = {
    collection: [
      {
        doi: "10.1101/2026.06.01.123456",
        title: "A novel CRISPR approach",
        authors: "Smith J.; Doe A.",
        date: "2026-06-01",
        version: "2",
        category: "genetics",
        abstract: "We describe a method.",
        published: "10.1038/s41586-026-00000-0",
      },
      {
        doi: "10.1101/2026.06.02.654321",
        title: "Unpublished finding",
        authors: "Roe B.",
        date: "2026-06-02",
        version: "1",
        category: "neuroscience",
        abstract: "Preliminary.",
        published: "NA",
      },
    ],
  };

  it("domain is 'preprints'", () => {
    expect(new PreprintsFeed({ http: makeMockHttp(BIORXIV) }).domain).toBe("preprints");
  });

  it("maps collection entries to PreprintEvents", async () => {
    const feed = new PreprintsFeed({ http: makeMockHttp(BIORXIV) });
    const events = await feed.fetch();
    expect(events).toHaveLength(2);
    expect(events[0]!.id).toBe("10.1101/2026.06.01.123456v2");
    expect(events[0]!.title).toBe("A novel CRISPR approach");
    expect(events[0]!.url).toBe("https://doi.org/10.1101/2026.06.01.123456");
    expect(events[0]!.category).toBe("genetics");
    expect(events[0]!.metadata!.abstract).toBe("We describe a method.");
  });

  it("scores publication into severity, treating NA as unpublished", async () => {
    const feed = new PreprintsFeed({ http: makeMockHttp(BIORXIV) });
    const events = await feed.fetch();
    expect(events[0]!.severity).toBe("medium"); // has published DOI
    expect(events[0]!.published).toBe("10.1038/s41586-026-00000-0");
    expect(events[1]!.severity).toBe("low"); // published === "NA"
    expect(events[1]!.published).toBeUndefined();
  });

  it("builds the server/date-range URL", async () => {
    let url = "";
    const feed = new PreprintsFeed({
      http: async (u) => {
        url = u;
        return BIORXIV;
      },
    });
    await feed.fetch({ server: "medrxiv", from: "2026-06-01", to: "2026-06-02" });
    expect(url).toContain("/details/medrxiv/2026-06-01/2026-06-02/0");
  });

  it("filters by category", async () => {
    const feed = new PreprintsFeed({ http: makeMockHttp(BIORXIV) });
    const events = await feed.fetch({ category: "Genetics" });
    expect(events).toHaveLength(1);
    expect(events[0]!.category).toBe("genetics");
  });

  it("falls back to mock on empty collection", async () => {
    const feed = new PreprintsFeed({ http: makeMockHttp({ collection: [] }) });
    const events = await feed.fetch();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.source).toContain("mock");
  });
});

describe("ArxivFeed (Atom XML query API)", () => {
  // Two-entry Atom feed: first has a journal DOI (published), second doesn't.
  const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v2</id>
    <published>2024-01-15T10:00:00Z</published>
    <title>Attention &amp; Everything</title>
    <summary>A study of   whitespace
    and abstracts.</summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
    <arxiv:doi>10.1000/journal.2024.1</arxiv:doi>
    <arxiv:primary_category term="cs.AI"/>
    <category term="cs.AI"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2402.00001v1</id>
    <published>2024-02-01T10:00:00Z</published>
    <title>Unpublished Preprint</title>
    <summary>No journal DOI yet.</summary>
    <author><name>Grace Hopper</name></author>
    <arxiv:primary_category term="cs.LG"/>
  </entry>
</feed>`;

  it("domain is 'arxiv'", () => {
    expect(new ArxivFeed({ http: makeMockHttp(ATOM) }).domain).toBe("arxiv");
  });

  it("parses Atom entries into PreprintEvents", async () => {
    const feed = new ArxivFeed({ http: makeMockHttp(ATOM) });
    const events = await feed.fetch();
    expect(events).toHaveLength(2);
    const e = events[0]!;
    expect(e.id).toBe("2401.12345v2");
    expect(e.version).toBe("2");
    expect(e.title).toBe("Attention & Everything"); // entity decoded
    expect(e.metadata!.abstract).toBe("A study of whitespace and abstracts."); // ws collapsed
    expect(e.authors).toBe("Ada Lovelace, Alan Turing");
    expect(e.category).toBe("cs.AI");
    expect(e.doi).toBe("10.48550/arXiv.2401.12345"); // canonical, version stripped
    expect(e.published).toBe("10.1000/journal.2024.1"); // journal DOI → graduated
    expect(e.severity).toBe("medium");
    expect(e.url).toBe("http://arxiv.org/abs/2401.12345v2");
  });

  it("unpublished preprint has no journal DOI and low severity", async () => {
    const events = await new ArxivFeed({ http: makeMockHttp(ATOM) }).fetch();
    expect(events[1]!.published).toBeUndefined();
    expect(events[1]!.severity).toBe("low");
    expect(events[1]!.category).toBe("cs.LG");
  });

  it("builds the query URL with category, sort, and max_results", async () => {
    let capturedUrl = "";
    const feed = new ArxivFeed({
      http: async (url) => {
        capturedUrl = url;
        return ATOM;
      },
    });
    await feed.fetch({ category: "cs.CL", maxResults: 5 });
    expect(capturedUrl).toContain("search_query=cat%3Acs.CL");
    expect(capturedUrl).toContain("max_results=5");
    expect(capturedUrl).toContain("sortBy=submittedDate");
  });

  it("falls back to mock on empty/non-XML response", async () => {
    const events = await new ArxivFeed({ http: makeMockHttp("") }).fetch();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.source).toContain("mock");
  });
});
