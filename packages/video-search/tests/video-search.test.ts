// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MockVideoBackend,
  VideoSearchCache,
  IntentExtractor,
  VideoRanker,
  VideoSearchAgent,
  VideoSearchEngine,
  type VideoResult,
  type ChatMessage,
  type ModelFn,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeVideo(id: string, title: string, overrides: Partial<VideoResult> = {}): VideoResult {
  return {
    id, title,
    url: `https://youtube.com/watch?v=${id}`,
    source: "youtube",
    viewCount: 1000,
    duration: 300,
    ...overrides,
  };
}

const noopModel: ModelFn = async (_sys, user) => user.replace(/.*query:\s*/i, "").trim();

const echoModel: ModelFn = async (_sys, user) => {
  const match = user.match(/query:\s*(.+)/i);
  return match?.[1]?.trim() ?? user;
};

// ── MockVideoBackend ──────────────────────────────────────────────────────────

describe("MockVideoBackend", () => {
  it("search returns matching videos by title", async () => {
    const backend = new MockVideoBackend([
      makeVideo("v1", "Python tutorial"),
      makeVideo("v2", "JavaScript tutorial"),
      makeVideo("v3", "React hooks explained"),
    ]);
    const results = await backend.search("python", 5);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("v1");
  });

  it("search matches by description", async () => {
    const backend = new MockVideoBackend([
      makeVideo("v1", "Intro", { description: "All about Python programming" }),
    ]);
    const results = await backend.search("python", 5);
    expect(results).toHaveLength(1);
  });

  it("search is case-insensitive", async () => {
    const backend = new MockVideoBackend([makeVideo("v1", "PYTHON TUTORIAL")]);
    expect(await backend.search("python", 5)).toHaveLength(1);
  });

  it("search respects maxResults limit", async () => {
    const backend = new MockVideoBackend([
      makeVideo("v1", "Python 1"),
      makeVideo("v2", "Python 2"),
      makeVideo("v3", "Python 3"),
    ]);
    const results = await backend.search("python", 2);
    expect(results).toHaveLength(2);
  });

  it("addVideo adds to catalog", async () => {
    const backend = new MockVideoBackend();
    backend.addVideo(makeVideo("v1", "Rust tutorial"));
    const results = await backend.search("rust", 10);
    expect(results).toHaveLength(1);
  });

  it("clear empties catalog", async () => {
    const backend = new MockVideoBackend([makeVideo("v1", "test")]);
    backend.clear();
    expect(backend.size()).toBe(0);
    expect(await backend.search("test", 10)).toHaveLength(0);
  });
});

// ── VideoSearchCache ──────────────────────────────────────────────────────────

describe("VideoSearchCache", () => {
  it("set and get returns response", () => {
    const cache = new VideoSearchCache();
    cache.set("python", { results: [], refinedQuery: "python", totalFound: 0, cached: false });
    expect(cache.get("python")).not.toBeNull();
  });

  it("get is case-insensitive", () => {
    const cache = new VideoSearchCache();
    cache.set("Python", { results: [], refinedQuery: "Python", totalFound: 0, cached: false });
    expect(cache.get("python")).not.toBeNull();
  });

  it("get returns null for expired entries", async () => {
    const cache = new VideoSearchCache(10);
    cache.set("q", { results: [], refinedQuery: "q", totalFound: 0, cached: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get("q")).toBeNull();
  });

  it("get marks returned response as cached: true", () => {
    const cache = new VideoSearchCache();
    cache.set("q", { results: [], refinedQuery: "q", totalFound: 0, cached: false });
    expect(cache.get("q")?.cached).toBe(true);
  });

  it("invalidate removes specific key", () => {
    const cache = new VideoSearchCache();
    cache.set("q", { results: [], refinedQuery: "q", totalFound: 0, cached: false });
    cache.invalidate("q");
    expect(cache.get("q")).toBeNull();
  });

  it("clear removes all entries", () => {
    const cache = new VideoSearchCache();
    cache.set("a", { results: [], refinedQuery: "a", totalFound: 0, cached: false });
    cache.set("b", { results: [], refinedQuery: "b", totalFound: 0, cached: false });
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

// ── IntentExtractor ───────────────────────────────────────────────────────────

describe("IntentExtractor", () => {
  it("refineQuery calls model and returns trimmed result", async () => {
    const model = vi.fn(async () => "  refined python  ");
    const extractor = new IntentExtractor(model);
    const result = await extractor.refineQuery({ query: "python" });
    expect(result).toBe("refined python");
  });

  it("falls back to original query when model throws", async () => {
    const model = vi.fn(async () => { throw new Error("oops"); });
    const extractor = new IntentExtractor(model);
    const result = await extractor.refineQuery({ query: "original" });
    expect(result).toBe("original");
  });

  it("falls back when model returns empty string", async () => {
    const model = vi.fn(async () => "   ");
    const extractor = new IntentExtractor(model);
    const result = await extractor.refineQuery({ query: "fallback" });
    expect(result).toBe("fallback");
  });

  it("includes chat history in model message", async () => {
    let capturedUser = "";
    const model = vi.fn(async (_sys: string, user: string) => { capturedUser = user; return "q"; });
    const extractor = new IntentExtractor(model);
    const history: ChatMessage[] = [
      { role: "user", content: "tell me about ML" },
      { role: "assistant", content: "ML is machine learning" },
    ];
    await extractor.refineQuery({ query: "more", chatHistory: history });
    expect(capturedUser).toContain("ML");
  });
});

// ── VideoRanker ───────────────────────────────────────────────────────────────

describe("VideoRanker", () => {
  const ranker = new VideoRanker();

  it("ranks by query term match", () => {
    const videos = [
      makeVideo("v1", "Python tutorial", { viewCount: 100 }),
      makeVideo("v2", "JavaScript tutorial unrelated", { viewCount: 100 }),
      makeVideo("v3", "Python advanced programming", { viewCount: 100 }),
    ];
    const ranked = ranker.rank(videos, "python advanced");
    expect(ranked[0]!.title).toContain("advanced");
  });

  it("filters by source", () => {
    const videos = [
      makeVideo("v1", "test", { source: "youtube" }),
      makeVideo("v2", "test", { source: "vimeo" }),
    ];
    const ranked = ranker.rank(videos, "test", { source: "youtube" });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.source).toBe("youtube");
  });

  it("filters by minDuration", () => {
    const videos = [
      makeVideo("v1", "test", { duration: 60 }),
      makeVideo("v2", "test", { duration: 600 }),
    ];
    const ranked = ranker.rank(videos, "test", { minDuration: 300 });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.duration).toBe(600);
  });

  it("filters by maxDuration", () => {
    const videos = [
      makeVideo("v1", "test", { duration: 60 }),
      makeVideo("v2", "test", { duration: 600 }),
    ];
    const ranked = ranker.rank(videos, "test", { maxDuration: 120 });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.duration).toBe(60);
  });

  it("attaches relevanceScore to each result", () => {
    const videos = [makeVideo("v1", "python")];
    const ranked = ranker.rank(videos, "python");
    expect(ranked[0]!.relevanceScore).toBeDefined();
    expect(ranked[0]!.relevanceScore).toBeGreaterThanOrEqual(0);
  });
});

// ── VideoSearchAgent ──────────────────────────────────────────────────────────

describe("VideoSearchAgent", () => {
  it("search returns results from backend", async () => {
    const backend = new MockVideoBackend([makeVideo("v1", "Python tutorial")]);
    const agent = new VideoSearchAgent(echoModel, backend);
    const response = await agent.search({ query: "python" });
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.cached).toBe(false);
    expect(typeof response.refinedQuery).toBe("string");
  });

  it("respects maxResults", async () => {
    const backend = new MockVideoBackend([
      makeVideo("v1", "test 1"),
      makeVideo("v2", "test 2"),
      makeVideo("v3", "test 3"),
    ]);
    const agent = new VideoSearchAgent(noopModel, backend);
    const response = await agent.search({ query: "test", maxResults: 2 });
    expect(response.results.length).toBeLessThanOrEqual(2);
  });

  it("applies source filter", async () => {
    const backend = new MockVideoBackend([
      makeVideo("v1", "test", { source: "youtube" }),
      makeVideo("v2", "test", { source: "vimeo" }),
    ]);
    const agent = new VideoSearchAgent(echoModel, backend);
    const response = await agent.search({ query: "test", source: "youtube" });
    response.results.forEach((r) => expect(r.source).toBe("youtube"));
  });
});

// ── VideoSearchEngine ─────────────────────────────────────────────────────────

describe("VideoSearchEngine", () => {
  it("first search returns cached: false", async () => {
    const backend = new MockVideoBackend([makeVideo("v1", "Python")]);
    const engine = new VideoSearchEngine({ model: echoModel, backend });
    const result = await engine.search({ query: "python" });
    expect(result.cached).toBe(false);
  });

  it("second search returns cached: true", async () => {
    const backend = new MockVideoBackend([makeVideo("v1", "Python")]);
    const engine = new VideoSearchEngine({ model: echoModel, backend });
    await engine.search({ query: "python" });
    const result = await engine.search({ query: "python" });
    expect(result.cached).toBe(true);
  });

  it("forceRefresh bypasses cache", async () => {
    const backend = new MockVideoBackend([makeVideo("v1", "Python")]);
    let modelCalls = 0;
    const model: ModelFn = async () => { modelCalls++; return "python"; };
    const engine = new VideoSearchEngine({ model, backend });
    await engine.search({ query: "python" });
    await engine.search({ query: "python", forceRefresh: true });
    expect(modelCalls).toBe(2);
  });

  it("getCache returns cache instance", () => {
    const backend = new MockVideoBackend();
    const engine = new VideoSearchEngine({ model: echoModel, backend });
    expect(engine.getCache()).toBeDefined();
  });
});
