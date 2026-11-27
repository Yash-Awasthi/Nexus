// SPDX-License-Identifier: Apache-2.0
/**
 * The registry's accounting half: free-tier pools, spend, health and compression.
 *
 * `provider-registry.test.ts` covers lookups and the models.dev importer; these methods had no test at
 * all, and they are the ones that decide whether the product stays inside a free tier. `computeBudget`
 * is the number a person reads before asking "can we afford this month", so its deduplication, its
 * pool-risk split and its by-provider breakdown each get an assertion rather than a printed total.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ProviderRegistry,
  type FreeTierPool,
  type ProviderEntry,
  type ProviderModel,
} from "../../src/registry/index.ts";

const model = (id: string, overrides: Partial<ProviderModel> = {}): ProviderModel => ({
  id,
  name: id,
  contextWindow: 8192,
  maxOutput: 2048,
  inputCost: 1,
  outputCost: 2,
  ...overrides,
});

const pool = (overrides: Partial<FreeTierPool> = {}): FreeTierPool => ({
  poolId: "pool-a",
  provider: "a",
  monthlyTokens: 1_000_000,
  rpm: 60,
  tpm: 60_000,
  termsRisk: "safe",
  lastVerified: "2026-01-01",
  ...overrides,
});

function entry(id: string, overrides: Partial<ProviderEntry> = {}): ProviderEntry {
  return {
    id,
    name: id,
    baseUrl: "",
    authType: "bearer",
    models: [model(`${id}/chat`)],
    monthlySpendLimit: null,
    currentSpend: 0,
    currentTokens: 0,
    healthScore: 100,
    lastHealthCheck: "2026-01-01T00:00:00.000Z",
    capabilities: {
      chat: true,
      embeddings: false,
      imageGeneration: false,
      audioTranscription: false,
      webSearch: false,
      codeExecution: false,
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("free-tier pools", () => {
  it("keeps a pool while the provider that owns it is registered", () => {
    const registry = new ProviderRegistry().register(entry("a", { freeTier: pool() }));
    expect(registry.computeBudget().deduplicatedPools).toBe(1);
  });

  it("drops the pool when the provider is unregistered, so the budget cannot outlive it", () => {
    const registry = new ProviderRegistry().register(entry("a", { freeTier: pool() }));
    registry.unregister("a");
    expect(registry.get("a")).toBeUndefined();
    expect(registry.computeBudget().deduplicatedPools).toBe(0);
    expect(registry.computeBudget().totalMonthlyTokens).toBe(0);
  });

  it("unregistering an unknown provider is a no-op rather than a throw", () => {
    const registry = new ProviderRegistry();
    expect(() => registry.unregister("ghost")).not.toThrow();
    expect(registry.list()).toEqual([]);
  });

  it("separates metered free tiers from permanently free ones", () => {
    const registry = new ProviderRegistry()
      .register(entry("metered", { freeTier: pool({ poolId: "p1", provider: "metered" }) }))
      .register(
        entry("unlimited", {
          freeTier: pool({ poolId: "p2", provider: "unlimited", monthlyTokens: null }),
        }),
      )
      .register(entry("paid"));
    expect(registry.listFree().map((p) => p.id)).toEqual(["metered"]);
    expect(registry.listPermanentlyFree().map((p) => p.id)).toEqual(["unlimited"]);
  });
});

describe("computeBudget", () => {
  it("deduplicates pools that two providers point at, and counts them once", () => {
    const shared = pool({ poolId: "shared", provider: "a", monthlyTokens: 2_000_000 });
    const registry = new ProviderRegistry()
      .register(entry("a", { freeTier: shared }))
      // The second provider points at the same pool: the same key, the same limit.
      .register(entry("b", { freeTier: { ...shared } }));
    const budget = registry.computeBudget();
    expect(budget.deduplicatedPools).toBe(1);
    expect(budget.totalMonthlyTokens).toBe(2_000_000);
    expect(budget.byProvider).toEqual({ a: { tokens: 2_000_000, pools: 1 } });
  });

  it("splits pools by terms risk and leaves only safe ones in freePoolCount", () => {
    const registry = new ProviderRegistry()
      .register(entry("safe", { freeTier: pool({ poolId: "s", provider: "safe" }) }))
      .register(
        entry("caution", {
          freeTier: pool({ poolId: "c", provider: "caution", termsRisk: "caution" }),
        }),
      )
      .register(
        entry("avoid", { freeTier: pool({ poolId: "a", provider: "avoid", termsRisk: "avoid" }) }),
      );
    const budget = registry.computeBudget();
    expect(budget.deduplicatedPools).toBe(3);
    expect(budget.freePoolCount).toBe(1);
    expect(budget.cautionPoolCount).toBe(1);
    expect(budget.avoidPoolCount).toBe(1);
  });

  it("counts a permanently free pool as zero tokens instead of failing on null", () => {
    const registry = new ProviderRegistry().register(
      entry("unlimited", {
        freeTier: pool({ poolId: "u", provider: "unlimited", monthlyTokens: null }),
      }),
    );
    const budget = registry.computeBudget();
    expect(budget.totalMonthlyTokens).toBe(0);
    expect(budget.byProvider["unlimited"]).toEqual({ tokens: 0, pools: 1 });
  });

  it("adds several pools from one provider into one byProvider row", () => {
    const registry = new ProviderRegistry()
      .register(
        entry("a", { freeTier: pool({ poolId: "a1", provider: "a", monthlyTokens: 1_000 }) }),
      )
      .register(
        entry("a2", { freeTier: pool({ poolId: "a2", provider: "a", monthlyTokens: 500 }) }),
      );
    expect(registry.computeBudget().byProvider["a"]).toEqual({ tokens: 1_500, pools: 2 });
  });

  it("estimates the paid cost of the whole free budget from each model's input rate", () => {
    const registry = new ProviderRegistry().register(
      entry("a", {
        models: [model("a/chat", { inputCost: 10 })],
        freeTier: pool({ poolId: "a1", provider: "a", monthlyTokens: 1_000_000 }),
      }),
    );
    // 1M tokens at $10/M, discounted to the 70 % the comment describes.
    expect(registry.computeBudget().estimatedCostIfPaid).toBeCloseTo(7, 6);
  });

  it("ignores a free model when estimating cost, because there is nothing to pay", () => {
    const registry = new ProviderRegistry().register(
      entry("a", {
        models: [model("a/free", { inputCost: null })],
        freeTier: pool({ poolId: "a1", provider: "a", monthlyTokens: 1_000_000 }),
      }),
    );
    expect(registry.computeBudget().estimatedCostIfPaid).toBe(0);
  });

  it("is empty, not broken, with nothing registered", () => {
    expect(new ProviderRegistry().computeBudget()).toEqual({
      totalMonthlyTokens: 0,
      freePoolCount: 0,
      cautionPoolCount: 0,
      avoidPoolCount: 0,
      deduplicatedPools: 0,
      estimatedCostIfPaid: 0,
      byProvider: {},
    });
  });
});

describe("usage accounting", () => {
  it("sums this window's tokens and cost per provider", () => {
    const registry = new ProviderRegistry();
    registry.trackUsage("a", 100, 0.02);
    registry.trackUsage("a", 50, 0.01);
    registry.trackUsage("b", 999, 9);
    expect(registry.getMonthlyUsage("a")).toEqual({ tokens: 150, cost: 0.02 + 0.01 });
    expect(registry.getMonthlyUsage("b").tokens).toBe(999);
  });

  it("reports zero for a provider that has never been used", () => {
    expect(new ProviderRegistry().getMonthlyUsage("never")).toEqual({ tokens: 0, cost: 0 });
  });

  it("drops entries older than thirty days, so the window means a month", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-31T00:00:00.000Z"));
    const registry = new ProviderRegistry();
    registry.trackUsage("a", 10, 0.1);

    vi.setSystemTime(new Date("2026-03-05T00:00:00.000Z"));
    registry.trackUsage("a", 5, 0.05);
    expect(registry.getMonthlyUsage("a")).toEqual({ tokens: 5, cost: 0.05 });
  });
});

describe("compression estimate", () => {
  it("returns the three strategies, ordered from least to most aggressive", () => {
    const results = new ProviderRegistry().estimateCompression(1_000, 500);
    expect(results.map((r) => r.strategy)).toEqual([
      "system-dedup",
      "conversation-summarize",
      "stacked-full",
    ]);
    for (const result of results) {
      expect(result.originalTokens).toBe(1_500);
      expect(result.compressedTokens).toBeLessThan(result.originalTokens);
      expect(result.savingsPercent).toBe(Math.round((1 - result.ratio) * 100));
    }
    expect(results[2]!.compressedTokens).toBeLessThan(results[1]!.compressedTokens);
  });
});

describe("health scoring", () => {
  it("clamps a score into 0–100 and stamps the check time", () => {
    const registry = new ProviderRegistry().register(entry("a"));
    registry.updateHealth("a", 250);
    expect(registry.get("a")!.healthScore).toBe(100);
    registry.updateHealth("a", -10);
    expect(registry.get("a")!.healthScore).toBe(0);
  });

  it("ignores an unknown provider instead of creating one", () => {
    const registry = new ProviderRegistry();
    registry.updateHealth("ghost", 50);
    expect(registry.get("ghost")).toBeUndefined();
  });

  it("prefers the healthiest free provider and never recommends one to avoid on terms", () => {
    const registry = new ProviderRegistry()
      .register(
        entry("weak", { freeTier: pool({ poolId: "w", provider: "weak" }), healthScore: 20 }),
      )
      .register(
        entry("risky", {
          freeTier: pool({ poolId: "r", provider: "risky", termsRisk: "avoid" }),
          healthScore: 99,
        }),
      )
      .register(
        entry("strong", { freeTier: pool({ poolId: "s", provider: "strong" }), healthScore: 80 }),
      );
    expect(registry.getHealthiestFree()!.id).toBe("strong");
    expect(new ProviderRegistry().getHealthiestFree()).toBeUndefined();
  });
});

describe("free-model discovery", () => {
  it("finds free models by pattern, and only from metered free tiers", () => {
    const registry = new ProviderRegistry()
      .register(
        entry("a", {
          models: [model("a/llama-free", { inputCost: 0 }), model("a/paid", { inputCost: 5 })],
          freeTier: pool({ poolId: "a1", provider: "a" }),
        }),
      )
      .register(
        entry("b", {
          models: [model("b/llama-free", { inputCost: 0 })],
          freeTier: pool({ poolId: "b1", provider: "b", monthlyTokens: null }),
        }),
      )
      .register(entry("paid", { models: [model("paid/llama-free", { inputCost: 0 })] }));
    const found = registry.findFree("llama-free");
    expect(found.map((hit) => hit.provider.id)).toEqual(["a"]);
  });

  it("returns nothing for a pattern no free model matches", () => {
    const registry = new ProviderRegistry().register(
      entry("a", { freeTier: pool({ poolId: "a1", provider: "a" }), models: [model("a/paid")] }),
    );
    expect(registry.findFree("llama")).toEqual([]);
  });
});

describe("cheapest and largest", () => {
  it("picks the cheapest output rate overall, ignoring the input rate", () => {
    const registry = new ProviderRegistry().register(
      entry("a", {
        models: [
          model("a/expensive", { inputCost: 0.1, outputCost: 50 }),
          model("a/cheap", { inputCost: 90, outputCost: 0.5 }),
        ],
      }),
    );
    expect(registry.findCheapestModel()!.model.id).toBe("a/cheap");
    expect(new ProviderRegistry().findCheapestModel()).toBeUndefined();
  });

  it("picks the largest context window, and the first model registered on a tie", () => {
    const registry = new ProviderRegistry().register(
      entry("a", {
        models: [
          model("a/small", { contextWindow: 8_000 }),
          model("a/large", { contextWindow: 200_000 }),
        ],
      }),
    );
    expect(registry.findLargestContext()!.model.id).toBe("a/large");
    expect(new ProviderRegistry().findLargestContext()).toBeUndefined();
  });

  it("findCheapest honours a pattern and treats a free model as zero", () => {
    const registry = new ProviderRegistry().register(
      entry("a", {
        models: [
          model("a/small", { inputCost: 3 }),
          model("a/small-free", { inputCost: null }),
          model("a/big", { inputCost: 1 }),
        ],
      }),
    );
    expect(registry.findCheapest("small")!.model.id).toBe("a/small-free");
    expect(registry.findCheapest()!.model.id).toBe("a/small-free");
  });
});
