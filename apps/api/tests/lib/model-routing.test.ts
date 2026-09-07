// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { ModelCapability } from "../../src/lib/model-discovery.js";
import { routeModel } from "../../src/lib/model-routing.js";

function m(partial: Partial<ModelCapability> & { id: string }): ModelCapability {
  return {
    provider: "test",
    contextWindow: 128_000,
    maxOutput: 8_192,
    vision: false,
    toolUse: true,
    streaming: true,
    reasoningTier: "fast",
    inputCostPer1M: 1,
    outputCostPer1M: 2,
    source: "catalog",
    ...partial,
  };
}

const POOL: ModelCapability[] = [
  m({ id: "cheap-fast", provider: "groq", inputCostPer1M: 0.05, outputCostPer1M: 0.08, reasoningTier: "fast" }),
  m({ id: "big-deep", provider: "anthropic", contextWindow: 1_000_000, vision: true, toolUse: true, reasoningTier: "deep", inputCostPer1M: 15, outputCostPer1M: 75 }),
  m({ id: "local-free", provider: "ollama", inputCostPer1M: null, outputCostPer1M: null, reasoningTier: "fast", maxOutput: 4_096 }),
  m({ id: "mid-vision", provider: "openai", vision: true, reasoningTier: "reasoning", inputCostPer1M: 2.5, outputCostPer1M: 10 }),
  m({ id: "no-tools", provider: "tiny", toolUse: false, reasoningTier: "fast" }),
];

describe("routeModel — §15.7", () => {
  it("filters out models failing a hard requirement (toolUse)", () => {
    const r = routeModel(POOL, { toolUse: true });
    // tier-exact tie (cheap-fast, local-free) → cost breaks it: local (free) wins
    expect(r.chosen?.id).toBe("local-free");
    expect(r.candidates.map((c) => c.model.id)).not.toContain("no-tools");
  });

  it("minReasoningTier filters and ranks (deep needed → big-deep chosen)", () => {
    const r = routeModel(POOL, { minReasoningTier: "deep" });
    expect(r.chosen?.id).toBe("big-deep");
    expect(r.candidates.some((c) => c.model.reasoningTier === "fast")).toBe(false);
  });

  it("preferCheapest flips the ranking among eligible models", () => {
    const req = { toolUse: true, preferCheapest: true };
    expect(routeModel(POOL, req).chosen?.id).toBe("local-free"); // $0 beats $0.13
    const freeFirst = routeModel(POOL, { toolUse: true, preferCheapest: true, minContextWindow: 200_000 });
    // cheap-fast + local-free (128k) + mid-vision (128k) filtered by context →
    // big-deep is the only eligible model left
    expect(freeFirst.chosen?.id).toBe("big-deep");
  });

  it("prefers the free local model when eligible and ranking capability-first with tier=fast", () => {
    const r = routeModel(POOL, { toolUse: true, minReasoningTier: "fast" });
    expect(r.chosen?.id).toBe("local-free"); // tier-exact + $0
    expect(r.chosen?.provider).toBe("ollama");
  });

  it("minContextWindow / maxOutputNeeded filter small models", () => {
    const r = routeModel(POOL, { minContextWindow: 500_000, toolUse: true });
    expect(r.chosen?.id).toBe("big-deep");
    const r2 = routeModel(POOL, { maxOutputNeeded: 8_192, vision: true });
    expect(r2.chosen?.id).toBe("mid-vision");
  });

  it("unsatisfiable requirement → chosen null + per-candidate unmatched reasons", () => {
    const r = routeModel(POOL, { vision: true, minReasoningTier: "deep", minContextWindow: 10_000_000 });
    expect(r.chosen).toBeNull();
    expect(r.candidates).toEqual([]);
    expect(r.unmatched.length).toBeGreaterThan(0);
    expect(r.unmatched[0]).toMatch(/context \d+ < 10000000|no vision/);
  });

  it("vision=true excludes non-vision models even when cheap", () => {
    const r = routeModel(POOL, { vision: true, preferCheapest: true });
    expect(r.chosen?.id).toBe("mid-vision");
  });
});
