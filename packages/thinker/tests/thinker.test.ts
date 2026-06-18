// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import {
  Thinker,
  BestOfN,
  ThinkChainBuilder,
  ThinkingSession,
  ReasoningCache,
  type LlmCallFn,
} from "../src/index.js";

const fastLlm: LlmCallFn = async (prompt, _model) => ({
  scratchpad: `scratch: ${prompt.slice(0, 20)}`,
  conclusion: `conclude: ${prompt.slice(0, 10)}`,
  confidence: 0.8,
  tokens: 20,
});

// ── ThinkChainBuilder ──────────────────────────────────────────────────────────

describe("ThinkChainBuilder", () => {
  it("builds a chain with steps", () => {
    const b = new ThinkChainBuilder("c1", "test query", "gpt-4o");
    b.addStep({
      prompt: "p1",
      scratchpad: "s1",
      conclusion: "c1",
      confidence: 0.9,
      status: "done",
      durationMs: 10,
      tokens: 5,
    });
    b.addStep({
      prompt: "p2",
      scratchpad: "s2",
      conclusion: "c2",
      confidence: 0.7,
      status: "done",
      durationMs: 8,
      tokens: 4,
    });
    const chain = b.build();
    expect(chain.steps).toHaveLength(2);
    expect(chain.steps[0]!.index).toBe(0);
    expect(chain.steps[1]!.index).toBe(1);
    expect(chain.finalAnswer).toBe("c2");
    expect(chain.totalTokens).toBe(9);
    expect(chain.totalConfidence).toBeCloseTo(0.8);
    expect(chain.query).toBe("test query");
    expect(chain.model).toBe("gpt-4o");
  });

  it("handles zero steps", () => {
    const b = new ThinkChainBuilder("c0", "q", "m");
    const chain = b.build();
    expect(chain.steps).toHaveLength(0);
    expect(chain.finalAnswer).toBe("");
    expect(chain.totalConfidence).toBe(0);
  });
});

// ── Thinker ───────────────────────────────────────────────────────────────────

describe("Thinker", () => {
  it("returns a ThinkChain for a query", async () => {
    const t = new Thinker({ llmCall: fastLlm });
    const chain = await t.think("What is the speed of light?");
    expect(chain.query).toBe("What is the speed of light?");
    expect(chain.steps.length).toBeGreaterThan(0);
    expect(chain.finalAnswer).toBeTruthy();
    expect(chain.totalTokens).toBeGreaterThan(0);
    expect(chain.id).toMatch(/^chain-/);
  });

  it("stops early when minConfidence reached after first step", async () => {
    const highConfLlm: LlmCallFn = async () => ({
      scratchpad: "s",
      conclusion: "done",
      confidence: 0.99,
      tokens: 5,
    });
    const t = new Thinker({ llmCall: highConfLlm, maxSteps: 5, minConfidence: 0.9 });
    const chain = await t.think("q");
    // Should stop after step 2 (i >= 1 and confidence >= 0.9)
    expect(chain.steps.length).toBeLessThanOrEqual(3);
  });

  it("includes context in first step prompt", async () => {
    const prompts: string[] = [];
    const captureLlm: LlmCallFn = async (prompt) => {
      prompts.push(prompt);
      return { scratchpad: "s", conclusion: "c", confidence: 0.8, tokens: 5 };
    };
    const t = new Thinker({ llmCall: captureLlm, maxSteps: 1 });
    await t.think("What happened?", "Background: the system crashed.");
    expect(prompts[0]).toContain("Background: the system crashed.");
  });

  it("uses model from options", async () => {
    const t = new Thinker({ llmCall: fastLlm, model: "claude-opus-4" });
    const chain = await t.think("q");
    expect(chain.model).toBe("claude-opus-4");
  });

  it("records step duration and tokens", async () => {
    const t = new Thinker({ llmCall: fastLlm, maxSteps: 1 });
    const chain = await t.think("q");
    expect(chain.steps[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(chain.steps[0]!.tokens).toBeGreaterThan(0);
  });
});

// ── BestOfN ───────────────────────────────────────────────────────────────────

describe("BestOfN", () => {
  it("runs N chains and returns best", async () => {
    let callCount = 0;
    const varLlm: LlmCallFn = async () => {
      callCount++;
      return { scratchpad: "s", conclusion: "c", confidence: Math.random(), tokens: 5 };
    };
    const bon = new BestOfN({ n: 3, llmCall: varLlm });
    const { best, all } = await bon.run("question");
    expect(all).toHaveLength(3);
    expect(all).toContain(best);
    // best has highest confidence
    for (const c of all) {
      expect(best.totalConfidence).toBeGreaterThanOrEqual(c.totalConfidence);
    }
  });

  it("defaults to n=3", async () => {
    const bon = new BestOfN({ llmCall: fastLlm });
    const { all } = await bon.run("q");
    expect(all).toHaveLength(3);
  });
});

// ── ReasoningCache ────────────────────────────────────────────────────────────

describe("ReasoningCache", () => {
  it("stores and retrieves chains", async () => {
    const t = new Thinker({ llmCall: fastLlm, maxSteps: 1 });
    const chain = await t.think("q");
    const cache = new ReasoningCache();
    cache.set("q", chain);
    expect(cache.has("q")).toBe(true);
    expect(cache.get("q")).toBe(chain);
  });

  it("clears cache", () => {
    const cache = new ReasoningCache();
    const t = new Thinker({ llmCall: fastLlm });
    cache.set("q", {
      id: "x",
      query: "q",
      steps: [],
      finalAnswer: "",
      totalConfidence: 0,
      totalTokens: 0,
      durationMs: 0,
      model: "m",
    });
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.has("q")).toBe(false);
  });
});

// ── ThinkingSession ───────────────────────────────────────────────────────────

describe("ThinkingSession", () => {
  it("caches results for same query", async () => {
    const spy = vi.fn(fastLlm);
    const session = new ThinkingSession({ llmCall: spy, maxSteps: 1 });
    const r1 = await session.ask("What is X?");
    const r2 = await session.ask("What is X?");
    expect(r1).toBe(r2);
    // llm was called once (first call only)
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refreshes when forceRefresh=true", async () => {
    const spy = vi.fn(fastLlm);
    const session = new ThinkingSession({ llmCall: spy, maxSteps: 1 });
    await session.ask("q");
    await session.ask("q", undefined, true);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("cacheSize tracks entries", async () => {
    const session = new ThinkingSession({ llmCall: fastLlm, maxSteps: 1 });
    await session.ask("q1");
    await session.ask("q2");
    expect(session.cacheSize()).toBe(2);
  });

  it("clearCache empties cache", async () => {
    const session = new ThinkingSession({ llmCall: fastLlm, maxSteps: 1 });
    await session.ask("q");
    session.clearCache();
    expect(session.cacheSize()).toBe(0);
  });

  it("treats same query with different context as different cache key", async () => {
    const spy = vi.fn(fastLlm);
    const session = new ThinkingSession({ llmCall: spy, maxSteps: 1 });
    await session.ask("q", "ctx1");
    await session.ask("q", "ctx2");
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
