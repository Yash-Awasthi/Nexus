// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MockSearchStrategy,
  StrategyChain,
  TimelineBuilder,
  SearchOrchestrator,
  createDefaultOrchestrator,
  applyFilters,
  ExaSearchStrategy,
  BraveSearchStrategy,
  SerperSearchStrategy,
  searchExa,
  searchBrave,
  searchSerper,
  type FetchLike,
  type SearchResult,
  type SearchRequest,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "r-1",
    content: "test content",
    source: "mock",
    type: "document",
    score: 0.8,
    timestamp: "2026-01-15T10:00:00.000Z",
    ...overrides,
  };
}

// ── MockSearchStrategy ────────────────────────────────────────────────────────

describe("MockSearchStrategy", () => {
  it("returns default result for query", async () => {
    const strategy = new MockSearchStrategy("chroma");
    const response = await strategy.search({ query: "test" });
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.source).toBe("chroma");
  });

  it("records calls", async () => {
    const strategy = new MockSearchStrategy();
    await strategy.search({ query: "a" });
    await strategy.search({ query: "b" });
    expect(strategy.calls).toHaveLength(2);
    expect(strategy.calls[0]!.query).toBe("a");
  });

  it("throws when configured", async () => {
    const strategy = new MockSearchStrategy("sqlite", { throws: "connection error" });
    await expect(strategy.search({ query: "x" })).rejects.toThrow("connection error");
  });

  it("returns empty when configured", async () => {
    const strategy = new MockSearchStrategy("mock", { empty: true });
    const response = await strategy.search({ query: "x" });
    expect(response.results).toHaveLength(0);
    expect(response.totalFound).toBe(0);
  });

  it("returns custom results", async () => {
    const results = [makeResult({ id: "custom-1", content: "custom" })];
    const strategy = new MockSearchStrategy("mock", { results });
    const response = await strategy.search({ query: "anything" });
    expect(response.results[0]!.id).toBe("custom-1");
  });
});

// ── applyFilters ──────────────────────────────────────────────────────────────

describe("applyFilters", () => {
  const results: SearchResult[] = [
    makeResult({
      id: "1",
      projectId: "proj-a",
      type: "document",
      score: 0.9,
      timestamp: "2026-01-10T00:00:00.000Z",
    }),
    makeResult({
      id: "2",
      projectId: "proj-b",
      type: "code",
      score: 0.5,
      timestamp: "2026-01-20T00:00:00.000Z",
    }),
    makeResult({
      id: "3",
      projectId: "proj-a",
      type: "message",
      score: 0.7,
      timestamp: "2026-01-15T00:00:00.000Z",
    }),
  ];

  it("filters by projectId", () => {
    const out = applyFilters(results, { projectId: "proj-a" });
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.projectId === "proj-a")).toBe(true);
  });

  it("filters by types", () => {
    const out = applyFilters(results, { types: ["code"] });
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("code");
  });

  it("filters by minScore", () => {
    const out = applyFilters(results, { minScore: 0.7 });
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.score >= 0.7)).toBe(true);
  });

  it("filters by after/before", () => {
    const out = applyFilters(results, {
      after: "2026-01-12T00:00:00.000Z",
      before: "2026-01-18T00:00:00.000Z",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("3");
  });

  it("combines multiple filters", () => {
    const out = applyFilters(results, { projectId: "proj-a", minScore: 0.85 });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("1");
  });
});

// ── StrategyChain ─────────────────────────────────────────────────────────────

describe("StrategyChain", () => {
  it("returns first non-empty result (fallback mode)", async () => {
    const empty = new MockSearchStrategy("chroma", { empty: true });
    const filled = new MockSearchStrategy("sqlite");
    const chain = new StrategyChain({ strategies: [empty, filled] });
    const response = await chain.search({ query: "q" });
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.source).toBe("sqlite");
    // empty strategy was called, filled was called
    expect(empty.calls).toHaveLength(1);
    expect(filled.calls).toHaveLength(1);
  });

  it("skips failed strategies and tries next", async () => {
    const failing = new MockSearchStrategy("chroma", { throws: "down" });
    const ok = new MockSearchStrategy("sqlite");
    const chain = new StrategyChain({ strategies: [failing, ok] });
    const response = await chain.search({ query: "q" });
    expect(response.results.length).toBeGreaterThan(0);
  });

  it("returns empty when all strategies fail", async () => {
    const c1 = new MockSearchStrategy("chroma", { throws: "err" });
    const c2 = new MockSearchStrategy("sqlite", { throws: "err" });
    const chain = new StrategyChain({ strategies: [c1, c2] });
    const response = await chain.search({ query: "q" });
    expect(response.results).toHaveLength(0);
  });

  it("exhaustive mode merges all results", async () => {
    const r1 = makeResult({ id: "a", content: "first" });
    const r2 = makeResult({ id: "b", content: "second" });
    const s1 = new MockSearchStrategy("chroma", { results: [r1] });
    const s2 = new MockSearchStrategy("sqlite", { results: [r2] });
    const chain = new StrategyChain({ strategies: [s1, s2], exhaustive: true });
    const response = await chain.search({ query: "q" });
    expect(response.results).toHaveLength(2);
  });

  it("strategies() returns list", () => {
    const s1 = new MockSearchStrategy("chroma");
    const chain = new StrategyChain({ strategies: [s1] });
    expect(chain.strategies_()).toHaveLength(1);
  });
});

// ── TimelineBuilder ───────────────────────────────────────────────────────────

describe("TimelineBuilder", () => {
  it("groups results by date", () => {
    const results: SearchResult[] = [
      makeResult({ id: "a", timestamp: "2026-01-10T08:00:00.000Z" }),
      makeResult({ id: "b", timestamp: "2026-01-10T14:00:00.000Z" }),
      makeResult({ id: "c", timestamp: "2026-01-11T09:00:00.000Z" }),
    ];
    const builder = new TimelineBuilder();
    const timeline = builder.build(results);
    expect(timeline.segments).toHaveLength(2);
    expect(timeline.segments[0]!.date).toBe("2026-01-10");
    expect(timeline.segments[0]!.results).toHaveLength(2);
    expect(timeline.segments[1]!.date).toBe("2026-01-11");
    expect(timeline.totalResults).toBe(3);
  });

  it("returns empty timeline for empty results", () => {
    const builder = new TimelineBuilder();
    const timeline = builder.build([]);
    expect(timeline.segments).toHaveLength(0);
    expect(timeline.totalResults).toBe(0);
  });

  it("segments are in chronological order", () => {
    const results: SearchResult[] = [
      makeResult({ id: "z", timestamp: "2026-03-01T00:00:00.000Z" }),
      makeResult({ id: "a", timestamp: "2026-01-01T00:00:00.000Z" }),
    ];
    const builder = new TimelineBuilder();
    const timeline = builder.build(results);
    expect(timeline.segments[0]!.date).toBe("2026-01-01");
    expect(timeline.segments[1]!.date).toBe("2026-03-01");
  });

  it("flatten returns results in sorted order", () => {
    const results: SearchResult[] = [
      makeResult({ id: "a", timestamp: "2026-01-10T08:00:00.000Z" }),
      makeResult({ id: "b", timestamp: "2026-01-11T09:00:00.000Z" }),
    ];
    const builder = new TimelineBuilder();
    const timeline = builder.build(results);
    const flat = builder.flatten(timeline);
    expect(flat).toHaveLength(2);
  });
});

// ── SearchOrchestrator ────────────────────────────────────────────────────────

describe("SearchOrchestrator", () => {
  it("search returns filtered results", async () => {
    const results = [
      makeResult({ id: "a", projectId: "proj-1", score: 0.9 }),
      makeResult({ id: "b", projectId: "proj-2", score: 0.3 }),
    ];
    const strategy = new MockSearchStrategy("mock", { results });
    const chain = new StrategyChain({ strategies: [strategy] });
    const orchestrator = new SearchOrchestrator({ chain });
    const response = await orchestrator.search({
      query: "q",
      filters: { projectId: "proj-1" },
    });
    expect(response.results).toHaveLength(1);
    expect(response.results[0]!.id).toBe("a");
  });

  it("searchTimeline returns grouped output", async () => {
    const results = [
      makeResult({ id: "a", timestamp: "2026-01-10T00:00:00.000Z" }),
      makeResult({ id: "b", timestamp: "2026-01-11T00:00:00.000Z" }),
    ];
    const strategy = new MockSearchStrategy("mock", { results });
    const chain = new StrategyChain({ strategies: [strategy] });
    const orchestrator = new SearchOrchestrator({ chain });
    const timeline = await orchestrator.searchTimeline({ query: "q" });
    expect(timeline.segments.length).toBeGreaterThanOrEqual(1);
  });

  it("respects maxResults", async () => {
    const results = Array.from({ length: 10 }, (_, i) => makeResult({ id: `r${i}` }));
    const strategy = new MockSearchStrategy("mock", { results });
    const chain = new StrategyChain({ strategies: [strategy] });
    const orchestrator = new SearchOrchestrator({ chain, defaultMaxResults: 3 });
    const response = await orchestrator.search({ query: "q" });
    expect(response.results).toHaveLength(3);
  });

  it("getChain and getTimelineBuilder return instances", () => {
    const orchestrator = createDefaultOrchestrator();
    expect(orchestrator.getChain()).toBeDefined();
    expect(orchestrator.getTimelineBuilder()).toBeDefined();
  });
});

// ── createDefaultOrchestrator ─────────────────────────────────────────────────

describe("createDefaultOrchestrator", () => {
  it("creates orchestrator with default strategies", async () => {
    // Pass an explicit mock so the test is not affected by DATABASE_URL /
    // CHROMA_URL env vars that may be set in CI but have no live service.
    const mock = new MockSearchStrategy("chroma");
    const orchestrator = createDefaultOrchestrator([mock]);
    const response = await orchestrator.search({ query: "hello" });
    expect(response.results.length).toBeGreaterThan(0);
  });

  it("accepts custom strategies", async () => {
    const custom = new MockSearchStrategy("hybrid", { results: [makeResult({ id: "custom" })] });
    const orchestrator = createDefaultOrchestrator([custom]);
    const response = await orchestrator.search({ query: "q" });
    expect(response.results[0]!.id).toBe("custom");
  });
});
// ─────────────────────────────────────────────────────────────────────────────
// §1.3 web-search providers — Exa / Brave / Serper
// ─────────────────────────────────────────────────────────────────────────────

/** Injectable fetch mock returning one JSON payload (or throwing). */
function fetchJson(body: unknown, status = 200): FetchLike {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  })) as unknown as FetchLike;
}

const EXA_BODY = {
  results: [
    {
      id: "exa-1",
      url: "https://example.com/a",
      title: "Result A",
      text: "Full text of A",
      score: 0.97,
      publishedDate: "2026-08-01T00:00:00.000Z",
    },
    { id: "exa-2", url: "https://example.com/b", title: "Result B", score: 0.81 },
  ],
};

describe("searchExa / ExaSearchStrategy (§1.3)", () => {
  it("throws without a key (no env, no apiKey)", async () => {
    vi.stubEnv("EXA_API_KEY", "");
    await expect(searchExa("q", { fetchFn: fetchJson(EXA_BODY) })).rejects.toThrow(/EXA_API_KEY/);
    vi.unstubAllEnvs();
  });

  it("POSTs the Exa wire shape: x-api-key header, type auto, text inline", async () => {
    const fetchFn = fetchJson(EXA_BODY);
    const results = await searchExa("hello", { apiKey: "exa-key", fetchFn });
    const f = fetchFn as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = f.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://api.exa.ai/search");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe("exa-key");
    const body = JSON.parse(init.body) as {
      query: string;
      numResults: number;
      type: string;
      text: boolean;
    };
    expect(body).toMatchObject({ query: "hello", numResults: 10, type: "auto", text: true });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: "exa-1",
      content: "Full text of A",
      source: "exa",
      score: 0.97,
      timestamp: "2026-08-01T00:00:00.000Z",
    });
    expect(results[0]!.metadata?.url).toBe("https://example.com/a");
    // Second result has no text → falls back to title
    expect(results[1]!.content).toBe("Result B");
  });

  it("respects type + includeText:false options", async () => {
    const fetchFn = fetchJson(EXA_BODY);
    await searchExa("q", { apiKey: "k", type: "neural", includeText: false, fetchFn });
    const body = JSON.parse(
      (
        (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { body: string }]
      )[1].body,
    ) as { type: string; text?: boolean };
    expect(body.type).toBe("neural");
    expect(body.text).toBeUndefined();
  });

  it("maps HTTP errors to thrown messages", async () => {
    await expect(
      searchExa("q", { apiKey: "k", fetchFn: fetchJson({ detail: "nope" }, 401) }),
    ).rejects.toThrow(/Exa 401/);
  });

  it("ExaSearchStrategy adapts into a SearchResponse with maxResults applied", async () => {
    const strategy = new ExaSearchStrategy({ apiKey: "k", fetchFn: fetchJson(EXA_BODY) });
    expect(strategy.name).toBe("exa");
    const res = await strategy.search({ query: "q", maxResults: 1 });
    expect(res.source).toBe("exa");
    expect(res.results).toHaveLength(1);
    expect(res.totalFound).toBe(2);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });
});

const BRAVE_BODY = {
  web: {
    results: [
      {
        title: "Brave One",
        url: "https://brave.example/1",
        description: "First brave result",
        age: "2 days ago",
      },
      { title: "Brave Two", url: "https://brave.example/2", description: "Second" },
    ],
  },
};

describe("searchBrave / BraveSearchStrategy (§1.3)", () => {
  it("throws without a key", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    await expect(searchBrave("q", { fetchFn: fetchJson(BRAVE_BODY) })).rejects.toThrow(
      /BRAVE_API_KEY/,
    );
    vi.unstubAllEnvs();
  });

  it("GETs with X-Subscription-Token auth and count/country/freshness params", async () => {
    const fetchFn = fetchJson(BRAVE_BODY);
    const results = await searchBrave("hello", {
      apiKey: "brave-key",
      freshness: "pw",
      country: "de",
      fetchFn,
    });
    const f = fetchFn as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = f.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toContain("https://api.search.brave.com/res/v1/web/search?");
    expect(url).toContain("q=hello");
    expect(url).toContain("count=10");
    expect(url).toContain("country=de");
    expect(url).toContain("freshness=pw");
    expect(init.headers["X-Subscription-Token"]).toBe("brave-key");
    expect(results[0]).toMatchObject({
      id: "brave-0",
      content: "First brave result",
      source: "brave",
      score: 1,
      timestamp: "2 days ago",
    });
    expect(results[0]!.metadata?.url).toBe("https://brave.example/1");
  });

  it("handles an empty web block and HTTP errors", async () => {
    expect(await searchBrave("q", { apiKey: "k", fetchFn: fetchJson({}) })).toHaveLength(0);
    await expect(searchBrave("q", { apiKey: "k", fetchFn: fetchJson({}, 429) })).rejects.toThrow(
      /Brave 429/,
    );
  });

  it("BraveSearchStrategy adapts into a SearchResponse", async () => {
    const strategy = new BraveSearchStrategy({ apiKey: "k", fetchFn: fetchJson(BRAVE_BODY) });
    expect(strategy.name).toBe("brave");
    const res = await strategy.search({ query: "q" });
    expect(res.source).toBe("brave");
    expect(res.totalFound).toBe(2);
  });
});

const SERPER_BODY = {
  organic: [
    {
      title: "Serper One",
      link: "https://serper.example/1",
      snippet: "Top hit",
      position: 1,
      date: "3 days ago",
    },
    { title: "Serper Two", link: "https://serper.example/2", snippet: "Second hit", position: 2 },
  ],
};

describe("searchSerper / SerperSearchStrategy (§1.3)", () => {
  it("throws without a key", async () => {
    vi.stubEnv("SERPER_API_KEY", "");
    await expect(searchSerper("q", { fetchFn: fetchJson(SERPER_BODY) })).rejects.toThrow(
      /SERPER_API_KEY/,
    );
    vi.unstubAllEnvs();
  });

  it("POSTs {q,num,gl,hl} with X-API-KEY auth", async () => {
    const fetchFn = fetchJson(SERPER_BODY);
    const results = await searchSerper("hello", { apiKey: "sp-key", gl: "de", hl: "de", fetchFn });
    const f = fetchFn as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = f.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://google.serper.dev/search");
    expect(init.method).toBe("POST");
    expect(init.headers["X-API-KEY"]).toBe("sp-key");
    const body = JSON.parse(init.body) as { q: string; num: number; gl: string; hl: string };
    expect(body).toEqual({ q: "hello", num: 10, gl: "de", hl: "de" });
    expect(results[0]).toMatchObject({
      id: "serper-0",
      content: "Top hit",
      source: "serper",
      score: 1,
      timestamp: "3 days ago",
    });
    expect(results[0]!.metadata?.url).toBe("https://serper.example/1");
  });

  it("handles an empty organic list and HTTP errors", async () => {
    expect(await searchSerper("q", { apiKey: "k", fetchFn: fetchJson({}) })).toHaveLength(0);
    await expect(searchSerper("q", { apiKey: "k", fetchFn: fetchJson({}, 500) })).rejects.toThrow(
      /Serper 500/,
    );
  });

  it("SerperSearchStrategy adapts into a SearchResponse with maxResults applied", async () => {
    const strategy = new SerperSearchStrategy({ apiKey: "k", fetchFn: fetchJson(SERPER_BODY) });
    expect(strategy.name).toBe("serper");
    const res = await strategy.search({ query: "q", maxResults: 1 });
    expect(res.source).toBe("serper");
    expect(res.results).toHaveLength(1);
    expect(res.totalFound).toBe(2);
  });
});
