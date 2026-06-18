// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import {
  scoreResponse,
  getModelsForTier,
  queryModel,
  raceModels,
  UltraplinianRunner,
  UltraplinianError,
  ULTRAPLINIAN_MODELS,
  type UltraplinianMessage,
  type ModelResult,
} from "../src/index.js";

// ── scoreResponse ─────────────────────────────────────────────────────────────

describe("scoreResponse", () => {
  it("returns 0 for empty content", () => {
    expect(scoreResponse("", "anything")).toBe(0);
  });

  it("returns 0 for very short content", () => {
    expect(scoreResponse("ok", "anything")).toBe(0);
  });

  it("scores longer content higher than short content", () => {
    const short = scoreResponse("Yes.", "explain monads");
    const long = scoreResponse(
      "Monads are a design pattern in functional programming that represent computations as a sequence of steps. They provide a way to chain operations while handling side effects in a pure functional style. Key examples include the Maybe monad for null handling and the IO monad for side effects.",
      "explain monads",
    );
    expect(long).toBeGreaterThan(short);
  });

  it("penalises refusal language", () => {
    const normal = scoreResponse("Here is how to do it: ...", "how to fix bug");
    const refusal = scoreResponse(
      "I cannot help with that. I'm unable to assist. As an AI I must decline.",
      "how to fix bug",
    );
    expect(normal).toBeGreaterThan(refusal);
  });

  it("rewards structured content with headers and code blocks", () => {
    const plain = scoreResponse("Here is the answer: do this thing.", "implement function");
    const structured = scoreResponse(
      `## Solution\n\n\`\`\`typescript\nfunction example() {\n  return 42;\n}\n\`\`\`\n\n- Step 1: setup\n- Step 2: implement`,
      "implement function",
    );
    expect(structured).toBeGreaterThan(plain);
  });

  it("penalises preamble like 'Sure, of course'", () => {
    const direct = scoreResponse(
      "Photosynthesis is the process plants use to convert sunlight into glucose.",
      "what is photosynthesis",
    );
    const preamble = scoreResponse(
      "Sure! I'd be happy to help! Photosynthesis is the process plants use to convert sunlight into glucose.",
      "what is photosynthesis",
    );
    expect(direct).toBeGreaterThanOrEqual(preamble);
  });

  it("returns a number between 0 and 100", () => {
    const score = scoreResponse(
      "A decent length answer about the topic with some detail.",
      "topic question",
    );
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("rewards content relevant to the query", () => {
    const relevant = scoreResponse(
      "TypeScript is a strongly typed programming language that builds on JavaScript giving better tooling at any scale.",
      "what is typescript",
    );
    const irrelevant = scoreResponse(
      "Cooking requires ingredients, preparation, heat, and patience. Always season to taste.",
      "what is typescript",
    );
    expect(relevant).toBeGreaterThan(irrelevant);
  });
});

// ── getModelsForTier ──────────────────────────────────────────────────────────

describe("getModelsForTier", () => {
  it("fast tier returns only fast models", () => {
    const models = getModelsForTier("fast");
    expect(models.length).toBe(ULTRAPLINIAN_MODELS.fast.length);
  });

  it("standard tier includes fast models (additive)", () => {
    const fast = getModelsForTier("fast");
    const standard = getModelsForTier("standard");
    expect(standard.length).toBeGreaterThan(fast.length);
    for (const m of fast) {
      expect(standard).toContain(m);
    }
  });

  it("ultra tier is the largest", () => {
    const fast = getModelsForTier("fast");
    const ultra = getModelsForTier("ultra");
    expect(ultra.length).toBeGreaterThan(fast.length);
  });

  it("returns no duplicate models within a tier", () => {
    for (const tier of ["fast", "standard", "smart", "power", "ultra"] as const) {
      const models = getModelsForTier(tier);
      expect(new Set(models).size).toBe(models.length);
    }
  });
});

// ── queryModel ────────────────────────────────────────────────────────────────

describe("queryModel", () => {
  it("returns success result from a mocked fetch", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Mocked response content here" } }],
      }),
    });

    const result = await queryModel(
      "gpt-4o",
      [{ role: "user", content: "Hello" }],
      "key",
      {},
      undefined,
      mockFetch as unknown as typeof fetch,
    );

    expect(result.success).toBe(true);
    expect(result.content).toBe("Mocked response content here");
    expect(result.model).toBe("gpt-4o");
  });

  it("returns failure result on HTTP error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: "Rate limited" } }),
    });

    const result = await queryModel(
      "gpt-4o",
      [{ role: "user", content: "Hello" }],
      "key",
      {},
      undefined,
      mockFetch as unknown as typeof fetch,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("returns failure result on network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await queryModel(
      "gpt-4o",
      [{ role: "user", content: "Hello" }],
      "key",
      {},
      undefined,
      mockFetch as unknown as typeof fetch,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Network error");
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const mockFetch = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));

    const result = await queryModel(
      "gpt-4o",
      [{ role: "user", content: "Hello" }],
      "key",
      {},
      controller.signal,
      mockFetch as unknown as typeof fetch,
    );

    expect(result.success).toBe(false);
  });
});

// ── raceModels ────────────────────────────────────────────────────────────────

describe("raceModels", () => {
  it("returns empty array for empty model list", async () => {
    const results = await raceModels([], [], "key", {}, {}, fetch);
    expect(results).toHaveLength(0);
  });

  it("collects all results when all succeed", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Response" } }] }),
    });

    const results = await raceModels(
      ["model-a", "model-b", "model-c"],
      [{ role: "user", content: "test" }],
      "key",
      {},
      { minResults: 2, gracePeriod: 0, hardTimeout: 5000 },
      mockFetch as unknown as typeof fetch,
    );

    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("finishes even if some models fail", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount % 2 === 0) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: "OK" } }] }) };
    });

    const results = await raceModels(
      ["m1", "m2", "m3", "m4"],
      [{ role: "user", content: "test" }],
      "key",
      {},
      { minResults: 1, gracePeriod: 0, hardTimeout: 5000 },
      mockFetch as unknown as typeof fetch,
    );

    const successes = results.filter((r) => r.success);
    expect(successes.length).toBeGreaterThan(0);
  });
});

// ── UltraplinianRunner ────────────────────────────────────────────────────────

describe("UltraplinianRunner", () => {
  it("throws UltraplinianError when all models fail", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const runner = new UltraplinianRunner({
      apiKey: "test",
      fetchFn: mockFetch as unknown as typeof fetch,
      raceConfig: { hardTimeout: 2000, gracePeriod: 0, minResults: 1 },
    });

    await expect(
      runner.race({
        tier: "fast",
        messages: [{ role: "user", content: "test" }],
        models: ["only-model"],
      }),
    ).rejects.toThrow(UltraplinianError);
  });

  it("returns winner with highest score among successful results", async () => {
    let callN = 0;
    const responses = [
      "Short answer.",
      "## Detailed Answer\n\nThis is a comprehensive response with multiple sections and ```code blocks``` and bullet points:\n- Point 1\n- Point 2\n- Point 3\n\nWith detailed explanation covering all aspects of the question.",
      "Medium length response that addresses the topic adequately.",
    ];

    const mockFetch = vi.fn().mockImplementation(async () => {
      const content = responses[callN % responses.length];
      callN++;
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    });

    const runner = new UltraplinianRunner({
      apiKey: "test",
      fetchFn: mockFetch as unknown as typeof fetch,
      raceConfig: { hardTimeout: 5000, gracePeriod: 0, minResults: 3 },
    });

    const result = await runner.race({
      tier: "fast",
      messages: [{ role: "user", content: "explain something" }],
      models: ["m1", "m2", "m3"],
    });

    expect(result.winner).toBeDefined();
    expect(result.winner.score).toBeGreaterThan(0);
    expect(result.modelsSucceeded).toBe(3);
  });

  it("throws error for empty model list", async () => {
    const runner = new UltraplinianRunner({ apiKey: "test" });
    await expect(runner.race({ tier: "fast", messages: [], models: [] })).rejects.toThrow(
      UltraplinianError,
    );
  });
});
