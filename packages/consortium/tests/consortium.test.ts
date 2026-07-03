// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import {
  scoreResponse,
  getModelsForTier,
  collectAllResponses,
  synthesize,
  ORCHESTRATOR_MODELS,
  type ConsortiumMessage,
} from "../src/index.js";

describe("scoreResponse (inlined)", () => {
  it("scores empty content as 0", () => {
    expect(scoreResponse("", "test")).toBe(0);
  });

  it("scores longer content higher", () => {
    const s1 = scoreResponse("Yes.", "question");
    const s2 = scoreResponse(
      "This is a comprehensive and detailed answer covering all aspects of the question with specific examples and code snippets where appropriate.",
      "question",
    );
    expect(s2).toBeGreaterThan(s1);
  });
});

describe("getModelsForTier", () => {
  it("fast returns fewest models", () => {
    expect(getModelsForTier("fast").length).toBeGreaterThan(0);
    expect(getModelsForTier("ultra").length).toBeGreaterThan(getModelsForTier("fast").length);
  });
});

describe("collectAllResponses", () => {
  it("returns empty results for empty model list", async () => {
    const results = await collectAllResponses([], [], "key", {}, {}, fetch);
    expect(results).toHaveLength(0);
  });

  it("collects successful responses", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Response from model" } }] }),
    });

    const results = await collectAllResponses(
      ["m1", "m2"],
      [{ role: "user" as const, content: "test" }],
      "key",
      {},
      { hardTimeout: 5000 },
      mockFetch as unknown as typeof fetch,
    );

    expect(results.length).toBe(2);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it("handles failed models gracefully", async () => {
    let callN = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callN++;
      if (callN === 1) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "OK" } }] }) };
    });

    const results = await collectAllResponses(
      ["fail-model", "ok-model"],
      [{ role: "user" as const, content: "test" }],
      "key",
      {},
      { hardTimeout: 5000 },
      mockFetch as unknown as typeof fetch,
    );

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
  });

  it("notifies onModelResult callback for each result", async () => {
    const notifications: number[] = [];
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "OK" } }] }),
    });

    await collectAllResponses(
      ["m1", "m2", "m3"],
      [{ role: "user" as const, content: "test" }],
      "key",
      {},
      {
        hardTimeout: 5000,
        onModelResult: (_r, settled, total) => {
          notifications.push(settled);
        },
      },
      mockFetch as unknown as typeof fetch,
    );

    expect(notifications.length).toBe(3);
    expect(Math.max(...notifications)).toBe(3);
  });
});

describe("synthesize", () => {
  it("throws when orchestrator returns empty content", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "" } }] }),
    });

    await expect(
      synthesize(
        "test query",
        [{ model: "m1", content: "response", score: 80, durationMs: 100, success: true }],
        "key",
        ORCHESTRATOR_MODELS[0],
        4096,
        mockFetch as unknown as typeof fetch,
      ),
    ).rejects.toThrow();
  });

  it("returns synthesis from orchestrator model", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Synthesized ground truth" } }] }),
    });

    const result = await synthesize(
      "What is machine learning?",
      [
        {
          model: "m1",
          content: "It is pattern recognition",
          score: 75,
          durationMs: 200,
          success: true,
        },
      ],
      "key",
      ORCHESTRATOR_MODELS[0],
      4096,
      mockFetch as unknown as typeof fetch,
    );

    expect(result.synthesis).toBe("Synthesized ground truth");
    expect(result.model).toBe(ORCHESTRATOR_MODELS[0]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws if orchestrator HTTP fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    await expect(
      synthesize(
        "test",
        [],
        "key",
        ORCHESTRATOR_MODELS[0],
        1024,
        mockFetch as unknown as typeof fetch,
      ),
    ).rejects.toThrow();
  });
});

describe("ORCHESTRATOR_MODELS", () => {
  it("contains at least one model", () => {
    expect(ORCHESTRATOR_MODELS.length).toBeGreaterThan(0);
  });

  it("all models are non-empty strings", () => {
    for (const m of ORCHESTRATOR_MODELS) {
      expect(typeof m).toBe("string");
      expect(m.length).toBeGreaterThan(0);
    }
  });
});
