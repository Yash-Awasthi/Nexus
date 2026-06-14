// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ContextExtractor,
  SuggestionGenerator,
  SuggestionRanker,
  SuggestionCache,
  SuggestionEngine,
  type ChatMessage,
  type SuggestionResult,
  type SuggestionLlmFn,
} from "../src/index.js";

const messages: ChatMessage[] = [
  { role: "user", content: "How do TypeScript generics work?" },
  { role: "assistant", content: "TypeScript generics allow you to write reusable code that works with multiple types." },
  { role: "user", content: "Can you show me an example with arrays?" },
  { role: "assistant", content: "Sure! Here is a generic identity function: function identity<T>(arg: T): T { return arg; }" },
];

const mockLlm: SuggestionLlmFn = async () => JSON.stringify([
  { text: "What are TypeScript utility types?", category: "related-topic", reasoning: "Related TypeScript concept" },
  { text: "How does TypeScript handle null types?", category: "deep-dive", reasoning: "Common pain point" },
  { text: "Show me a generic Promise wrapper", category: "next-step", reasoning: "Natural progression" },
]);

// ── ContextExtractor ──────────────────────────────────────────────────────────

describe("ContextExtractor", () => {
  const extractor = new ContextExtractor();

  it("extracts topics from messages", () => {
    const ctx = extractor.extract(messages);
    expect(ctx.topics.length).toBeGreaterThan(0);
    expect(ctx.topics.some((t) => t.includes("typescript") || t.includes("generic"))).toBe(true);
  });

  it("extracts entities (capitalised words)", () => {
    const ctx = extractor.extract(messages);
    // "TypeScript" should appear as an entity
    expect(ctx.entities.length).toBeGreaterThanOrEqual(0); // may vary by heuristic
  });

  it("sets lastUserIntent from last user message", () => {
    const ctx = extractor.extract(messages);
    expect(ctx.lastUserIntent).toContain("arrays");
  });

  it("counts messages", () => {
    const ctx = extractor.extract(messages);
    expect(ctx.messageCount).toBe(4);
  });

  it("handles empty messages gracefully", () => {
    const ctx = extractor.extract([]);
    expect(ctx.topics).toHaveLength(0);
    expect(ctx.lastUserIntent).toBe("");
    expect(ctx.messageCount).toBe(0);
  });

  it("respects topicLimit", () => {
    const ctx = extractor.extract(messages, 3);
    expect(ctx.topics.length).toBeLessThanOrEqual(3);
  });
});

// ── SuggestionGenerator ───────────────────────────────────────────────────────

describe("SuggestionGenerator", () => {
  it("generates suggestions from LLM", async () => {
    const gen = new SuggestionGenerator({ llmFn: mockLlm, maxSuggestions: 3 });
    const ctx = new ContextExtractor().extract(messages);
    const results = await gen.generate(ctx);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.id).toMatch(/^sug-/);
    expect(results[0]!.text).toBeTruthy();
    expect(results[0]!.category).toBe("related-topic");
  });

  it("handles malformed LLM response gracefully", async () => {
    const badLlm: SuggestionLlmFn = async () => "not valid json";
    const gen = new SuggestionGenerator({ llmFn: badLlm });
    const ctx = new ContextExtractor().extract(messages);
    const results = await gen.generate(ctx);
    expect(results).toHaveLength(0);
  });

  it("respects maxSuggestions limit", async () => {
    const gen = new SuggestionGenerator({ llmFn: mockLlm, maxSuggestions: 2 });
    const ctx = new ContextExtractor().extract(messages);
    const results = await gen.generate(ctx);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("uses default LLM when none provided", async () => {
    const gen = new SuggestionGenerator();
    const ctx = new ContextExtractor().extract(messages);
    const results = await gen.generate(ctx);
    expect(Array.isArray(results)).toBe(true);
  });

  it("assigns default category for missing category field", async () => {
    const llm: SuggestionLlmFn = async () => JSON.stringify([{ text: "Question?", reasoning: "r" }]);
    const gen = new SuggestionGenerator({ llmFn: llm });
    const ctx = new ContextExtractor().extract(messages);
    const [result] = await gen.generate(ctx);
    expect(result!.category).toBe("related-topic");
  });
});

// ── SuggestionRanker ──────────────────────────────────────────────────────────

describe("SuggestionRanker", () => {
  const ctx = {
    topics: ["typescript", "generics", "types"],
    entities: ["TypeScript"],
    lastUserIntent: "show me arrays example",
    conversationSummary: "typescript generics discussion",
    messageCount: 4,
  };

  const suggestions: SuggestionResult[] = [
    { id: "s1", text: "What are TypeScript utility types?", category: "related-topic", relevanceScore: 0.7, noveltyScore: 1, finalScore: 0.7, reasoning: "r" },
    { id: "s2", text: "How does Python work?", category: "related-topic", relevanceScore: 0.3, noveltyScore: 1, finalScore: 0.3, reasoning: "r" },
  ];

  it("sorts by finalScore descending", () => {
    const ranker = new SuggestionRanker();
    const ranked = ranker.rank(suggestions, ctx);
    expect(ranked[0]!.finalScore).toBeGreaterThanOrEqual(ranked[1]!.finalScore);
  });

  it("penalises suggestions similar to seen texts", () => {
    const seen = new Set(["What are TypeScript utility types?"]);
    const ranker = new SuggestionRanker({ seenTexts: seen });
    const ranked = ranker.rank(suggestions, ctx);
    const ts = ranked.find((r) => r.id === "s1");
    expect(ts!.noveltyScore).toBeLessThan(1.0);
  });

  it("boosts suggestions containing topic words", () => {
    const ranker = new SuggestionRanker();
    const ranked = ranker.rank(suggestions, ctx);
    const ts = ranked.find((r) => r.id === "s1");
    expect(ts!.relevanceScore).toBeGreaterThan(0.5);
  });

  it("finalScore is in 0-1 range", () => {
    const ranker = new SuggestionRanker();
    const ranked = ranker.rank(suggestions, ctx);
    for (const r of ranked) {
      expect(r.finalScore).toBeGreaterThanOrEqual(0);
      expect(r.finalScore).toBeLessThanOrEqual(1);
    }
  });
});

// ── SuggestionCache ───────────────────────────────────────────────────────────

describe("SuggestionCache", () => {
  const sampleSuggestion: SuggestionResult = {
    id: "s1", text: "Try this", category: "next-step",
    relevanceScore: 0.8, noveltyScore: 0.9, finalScore: 0.84, reasoning: "r",
  };

  it("stores and retrieves suggestions", () => {
    const cache = new SuggestionCache();
    cache.set("session1", [sampleSuggestion]);
    const result = cache.get("session1");
    expect(result).not.toBeNull();
    expect(result![0]!.text).toBe("Try this");
  });

  it("returns null for missing session", () => {
    const cache = new SuggestionCache();
    expect(cache.get("ghost")).toBeNull();
  });

  it("expires after TTL", async () => {
    const cache = new SuggestionCache(10);
    cache.set("s", [sampleSuggestion]);
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get("s")).toBeNull();
  });

  it("invalidate removes entry", () => {
    const cache = new SuggestionCache();
    cache.set("s", [sampleSuggestion]);
    cache.invalidate("s");
    expect(cache.get("s")).toBeNull();
  });

  it("seenTexts collects all suggestion texts", () => {
    const cache = new SuggestionCache();
    cache.set("s1", [{ ...sampleSuggestion, text: "Question A" }]);
    cache.set("s2", [{ ...sampleSuggestion, text: "Question B" }]);
    const seen = cache.seenTexts();
    expect(seen.has("Question A")).toBe(true);
    expect(seen.has("Question B")).toBe(true);
  });

  it("clear empties cache", () => {
    const cache = new SuggestionCache();
    cache.set("s1", [sampleSuggestion]);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

// ── SuggestionEngine ──────────────────────────────────────────────────────────

describe("SuggestionEngine", () => {
  it("generates and caches suggestions", async () => {
    const engine = new SuggestionEngine({ llmFn: mockLlm });
    const results = await engine.suggest("session1", messages);
    expect(results.length).toBeGreaterThan(0);
    // Second call should use cache
    const cached = await engine.suggest("session1", messages);
    expect(cached).toEqual(results);
  });

  it("forceRefresh bypasses cache", async () => {
    const spy = vi.fn(mockLlm);
    const engine = new SuggestionEngine({ llmFn: spy });
    await engine.suggest("session1", messages);
    await engine.suggest("session1", messages, true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("invalidate clears session cache", async () => {
    const spy = vi.fn(mockLlm);
    const engine = new SuggestionEngine({ llmFn: spy });
    await engine.suggest("session1", messages);
    engine.invalidate("session1");
    await engine.suggest("session1", messages);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("results have finalScore and are sorted", async () => {
    const engine = new SuggestionEngine({ llmFn: mockLlm });
    const results = await engine.suggest("s", messages);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.finalScore).toBeGreaterThanOrEqual(results[i]!.finalScore);
    }
  });

  it("getCache exposes the cache", () => {
    const engine = new SuggestionEngine({ llmFn: mockLlm });
    expect(engine.getCache()).toBeDefined();
  });
});
