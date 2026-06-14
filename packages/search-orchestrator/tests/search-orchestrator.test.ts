// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  MockSearchStrategy,
  StrategyChain,
  TimelineBuilder,
  SearchOrchestrator,
  createDefaultOrchestrator,
  applyFilters,
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
    makeResult({ id: "1", projectId: "proj-a", type: "document", score: 0.9, timestamp: "2026-01-10T00:00:00.000Z" }),
    makeResult({ id: "2", projectId: "proj-b", type: "code",     score: 0.5, timestamp: "2026-01-20T00:00:00.000Z" }),
    makeResult({ id: "3", projectId: "proj-a", type: "message",  score: 0.7, timestamp: "2026-01-15T00:00:00.000Z" }),
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
      after:  "2026-01-12T00:00:00.000Z",
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
    const empty  = new MockSearchStrategy("chroma", { empty: true });
    const filled = new MockSearchStrategy("sqlite");
    const chain  = new StrategyChain({ strategies: [empty, filled] });
    const response = await chain.search({ query: "q" });
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.source).toBe("sqlite");
    // empty strategy was called, filled was called
    expect(empty.calls).toHaveLength(1);
    expect(filled.calls).toHaveLength(1);
  });

  it("skips failed strategies and tries next", async () => {
    const failing = new MockSearchStrategy("chroma", { throws: "down" });
    const ok      = new MockSearchStrategy("sqlite");
    const chain   = new StrategyChain({ strategies: [failing, ok] });
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
    const orchestrator = createDefaultOrchestrator();
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
