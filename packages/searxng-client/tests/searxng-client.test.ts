// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  QueryBuilder,
  SearxngClient,
  ResultDeduplicator,
  MultiEngineRouter,
  type SearxngResponse,
  type SearxngResult,
  type HttpGetFn,
} from "../src/index.js";

// ── Mock HTTP ─────────────────────────────────────────────────────────────────

function makeMockHttp(results: SearxngResult[] = []): HttpGetFn {
  return async (_url): Promise<SearxngResponse> => ({
    query: "test",
    results,
    suggestions: ["suggestion1"],
    answers: [],
    infoboxes: [],
    number_of_results: results.length,
    latency: 0.1,
  });
}

const sampleResult: SearxngResult = {
  url: "https://example.com",
  title: "Example",
  content: "Example content about the topic",
  engine: "google",
  score: 0.9,
  category: "general",
};

// ── QueryBuilder ──────────────────────────────────────────────────────────────

describe("QueryBuilder", () => {
  it("builds a basic search URL", () => {
    const url = new QueryBuilder()
      .setQuery("typescript tutorial")
      .setFormat("json")
      .build("https://searxng.example.com");
    expect(url).toContain("q=typescript+tutorial");
    expect(url).toContain("format=json");
    expect(url).toContain("/search?");
  });

  it("includes categories", () => {
    const url = new QueryBuilder()
      .setQuery("q")
      .setCategories(["general", "news"])
      .build("https://sx.com");
    expect(url).toContain("categories=general%2Cnews");
  });

  it("includes engines", () => {
    const url = new QueryBuilder()
      .setQuery("q")
      .setEngines(["google", "bing"])
      .build("https://sx.com");
    expect(url).toContain("engines=google%2Cbing");
  });

  it("includes language", () => {
    const url = new QueryBuilder().setQuery("q").setLanguage("en").build("https://sx.com");
    expect(url).toContain("language=en");
  });

  it("includes page number", () => {
    const url = new QueryBuilder().setQuery("q").setPage(3).build("https://sx.com");
    expect(url).toContain("pageno=3");
  });

  it("includes time range", () => {
    const url = new QueryBuilder().setQuery("q").setTimeRange("week").build("https://sx.com");
    expect(url).toContain("time_range=week");
  });

  it("includes safe search", () => {
    const url = new QueryBuilder().setQuery("q").setSafeSearch(1).build("https://sx.com");
    expect(url).toContain("safesearch=1");
  });

  it("strips trailing slash from baseUrl", () => {
    const url = new QueryBuilder().setQuery("q").build("https://sx.com/");
    expect(url).toContain("https://sx.com/search");
    expect(url).not.toContain("//search");
  });

  it("getParams returns current params", () => {
    const builder = new QueryBuilder().setQuery("hello").setLanguage("fr");
    const params = builder.getParams();
    expect(params["q"]).toBe("hello");
    expect(params["language"]).toBe("fr");
  });

  it("supports chaining", () => {
    const builder = new QueryBuilder();
    expect(builder.setQuery("q")).toBe(builder);
    expect(builder.setLanguage("en")).toBe(builder);
  });
});

// ── SearxngClient ─────────────────────────────────────────────────────────────

describe("SearxngClient", () => {
  it("searches and returns response", async () => {
    const client = new SearxngClient("https://sx.com", { http: makeMockHttp([sampleResult]) });
    const resp = await client.search("TypeScript");
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0]!.url).toBe("https://example.com");
  });

  it("applies default options", async () => {
    const urls: string[] = [];
    const http: HttpGetFn = async (url) => {
      urls.push(url);
      return {
        query: "q",
        results: [],
        suggestions: [],
        answers: [],
        infoboxes: [],
        number_of_results: 0,
        latency: 0,
      };
    };
    const client = new SearxngClient("https://sx.com", {
      http,
      defaults: { language: "de", safeSearch: 1 },
    });
    await client.search("test");
    expect(urls[0]).toContain("language=de");
    expect(urls[0]).toContain("safesearch=1");
  });

  it("merges options, query options override defaults", async () => {
    const urls: string[] = [];
    const http: HttpGetFn = async (url) => {
      urls.push(url);
      return {
        query: "q",
        results: [],
        suggestions: [],
        answers: [],
        infoboxes: [],
        number_of_results: 0,
        latency: 0,
      };
    };
    const client = new SearxngClient("https://sx.com", {
      http,
      defaults: { language: "en", safeSearch: 0 },
    });
    await client.search("test", { language: "fr" });
    expect(urls[0]).toContain("language=fr");
  });

  it("getBaseUrl returns base URL without trailing slash", () => {
    const client = new SearxngClient("https://sx.com/", {});
    expect(client.getBaseUrl()).toBe("https://sx.com");
  });
});

// ── ResultDeduplicator ────────────────────────────────────────────────────────

describe("ResultDeduplicator", () => {
  it("deduplicates by URL", () => {
    const dedup = new ResultDeduplicator();
    dedup.add([{ ...sampleResult, url: "https://a.com", score: 0.9 }]);
    dedup.add([{ ...sampleResult, url: "https://a.com", score: 0.8 }]); // dup
    dedup.add([{ ...sampleResult, url: "https://b.com", score: 0.7 }]);
    expect(dedup.count()).toBe(2);
  });

  it("case-insensitive URL dedup", () => {
    const dedup = new ResultDeduplicator();
    dedup.add([{ ...sampleResult, url: "https://EXAMPLE.COM" }]);
    dedup.add([{ ...sampleResult, url: "https://example.com" }]);
    expect(dedup.count()).toBe(1);
  });

  it("sorts by score descending", () => {
    const dedup = new ResultDeduplicator();
    dedup.add([
      { ...sampleResult, url: "https://low.com", score: 0.3 },
      { ...sampleResult, url: "https://high.com", score: 0.9 },
      { ...sampleResult, url: "https://mid.com", score: 0.6 },
    ]);
    const results = dedup.get();
    expect(results[0]!.score).toBe(0.9);
    expect(results[1]!.score).toBe(0.6);
    expect(results[2]!.score).toBe(0.3);
  });

  it("get(false) skips sort", () => {
    const dedup = new ResultDeduplicator();
    dedup.add([
      { ...sampleResult, url: "https://low.com", score: 0.1 },
      { ...sampleResult, url: "https://high.com", score: 0.9 },
    ]);
    const unsorted = dedup.get(false);
    expect(unsorted[0]!.score).toBe(0.1); // insertion order
  });

  it("clear resets state", () => {
    const dedup = new ResultDeduplicator();
    dedup.add([sampleResult]);
    dedup.clear();
    expect(dedup.count()).toBe(0);
    dedup.add([sampleResult]);
    expect(dedup.count()).toBe(1); // can add again
  });

  it("supports chaining", () => {
    const dedup = new ResultDeduplicator();
    expect(dedup.add([])).toBe(dedup);
  });
});

// ── MultiEngineRouter ─────────────────────────────────────────────────────────

describe("MultiEngineRouter", () => {
  it("fans out to multiple instances", async () => {
    const results1 = [{ ...sampleResult, url: "https://r1.com", score: 0.9 }];
    const results2 = [{ ...sampleResult, url: "https://r2.com", score: 0.7 }];

    const c1 = new SearxngClient("https://sx1.com", { http: makeMockHttp(results1) });
    const c2 = new SearxngClient("https://sx2.com", { http: makeMockHttp(results2) });

    const router = new MultiEngineRouter([
      { client: c1, weight: 1, name: "instance1" },
      { client: c2, weight: 1, name: "instance2" },
    ]);

    const result = await router.search("TypeScript");
    expect(result.results.length).toBe(2);
    expect(result.instanceResults.has("instance1")).toBe(true);
    expect(result.instanceResults.has("instance2")).toBe(true);
  });

  it("deduplicates overlapping results", async () => {
    const sharedResult = [{ ...sampleResult, url: "https://shared.com", score: 0.8 }];
    const c1 = new SearxngClient("https://sx1.com", { http: makeMockHttp(sharedResult) });
    const c2 = new SearxngClient("https://sx2.com", { http: makeMockHttp(sharedResult) });

    const router = new MultiEngineRouter([
      { client: c1, weight: 1, name: "i1" },
      { client: c2, weight: 1, name: "i2" },
    ]);
    const result = await router.search("q");
    expect(result.results).toHaveLength(1);
  });

  it("applies weight to scores", async () => {
    const results = [{ ...sampleResult, url: "https://x.com", score: 0.5 }];
    const c1 = new SearxngClient("https://sx1.com", { http: makeMockHttp(results) });

    const router = new MultiEngineRouter([{ client: c1, weight: 2, name: "i1" }]);
    const result = await router.search("q");
    // score should be 0.5 * 2 = 1.0
    expect(result.results[0]!.score).toBeCloseTo(1.0);
  });

  it("handles instance failures gracefully", async () => {
    const failHttp: HttpGetFn = async () => {
      throw new Error("down");
    };
    const c1 = new SearxngClient("https://down.com", { http: failHttp });
    const c2 = new SearxngClient("https://up.com", { http: makeMockHttp([sampleResult]) });

    const router = new MultiEngineRouter([
      { client: c1, weight: 1, name: "down" },
      { client: c2, weight: 1, name: "up" },
    ]);
    const result = await router.search("q");
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("addInstance increases count", () => {
    const router = new MultiEngineRouter([]);
    const c = new SearxngClient("https://sx.com", { http: makeMockHttp() });
    router.addInstance({ client: c, weight: 1, name: "new" });
    expect(router.instanceCount()).toBe(1);
  });

  it("returns query in result", async () => {
    const c = new SearxngClient("https://sx.com", { http: makeMockHttp() });
    const router = new MultiEngineRouter([{ client: c, weight: 1, name: "i" }]);
    const result = await router.search("my query");
    expect(result.query).toBe("my query");
  });
});
