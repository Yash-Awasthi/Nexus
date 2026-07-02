// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "@nexus/provider-registry";
import {
  computeCost,
  estimateMaxCost,
  BillingLedger,
  QuotaExceededError,
} from "../src/cost.js";

// Local registry so tests don't depend on the evolving global catalogue.
function makeRegistry(): ProviderRegistry {
  const r = new ProviderRegistry();
  r.register({
    id: "test/model",
    provider: "test",
    name: "Test Model",
    contextWindow: 100_000,
    maxOutputTokens: 1000,
    costPerInputToken: 3e-6, // $3 / MTok
    costPerOutputToken: 15e-6, // $15 / MTok
    costPerCacheReadToken: 0.3e-6, // $0.30 / MTok
    costPerCacheWriteToken: 3.75e-6,
    capabilities: {
      vision: false,
      functionCalling: true,
      streaming: true,
      promptCaching: true,
      jsonMode: true,
      systemPrompt: true,
    },
  });
  return r;
}

describe("computeCost", () => {
  const reg = makeRegistry();

  it("prices input + output", () => {
    const c = computeCost("test/model", { inputTokens: 1_000_000, outputTokens: 1_000_000 }, reg);
    expect(c.inputCost).toBeCloseTo(3, 9);
    expect(c.outputCost).toBeCloseTo(15, 9);
    expect(c.totalCost).toBeCloseTo(18, 9);
    expect(c.unknownModel).toBe(false);
  });

  it("uses dedicated cache rates when present", () => {
    const c = computeCost(
      "test/model",
      { cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
      reg,
    );
    expect(c.cacheReadCost).toBeCloseTo(0.3, 9);
    expect(c.cacheWriteCost).toBeCloseTo(3.75, 9);
  });

  it("falls back to input rate for cache when model has no cache price", () => {
    const r = new ProviderRegistry();
    r.register({
      id: "nocache/m",
      provider: "x",
      name: "m",
      contextWindow: 1,
      maxOutputTokens: 1,
      costPerInputToken: 2e-6,
      costPerOutputToken: 4e-6,
      capabilities: {
        vision: false,
        functionCalling: false,
        streaming: true,
        promptCaching: false,
        jsonMode: false,
        systemPrompt: true,
      },
    });
    const c = computeCost("nocache/m", { cacheReadTokens: 1_000_000 }, r);
    expect(c.cacheReadCost).toBeCloseTo(2, 9); // input rate fallback
  });

  it("unknown model → zero cost, flagged, never throws", () => {
    const c = computeCost("ghost/model", { inputTokens: 9999 }, reg);
    expect(c.unknownModel).toBe(true);
    expect(c.totalCost).toBe(0);
  });
});

describe("estimateMaxCost", () => {
  const reg = makeRegistry();
  it("reserves against full maxOutputTokens by default", () => {
    // 1000 input @ $3/MTok + 1000 maxOutput @ $15/MTok
    const est = estimateMaxCost("test/model", 1000, { registry: reg });
    expect(est).toBeCloseTo(1000 * 3e-6 + 1000 * 15e-6, 12);
  });
  it("honours an explicit assumedOutputTokens", () => {
    const est = estimateMaxCost("test/model", 0, { assumedOutputTokens: 500, registry: reg });
    expect(est).toBeCloseTo(500 * 15e-6, 12);
  });
});

describe("BillingLedger", () => {
  it("tracks reserved / committed / projected", () => {
    const l = new BillingLedger();
    l.reserve("a", 1);
    l.reserve("b", 2);
    expect(l.reserved).toBe(3);
    expect(l.committed).toBe(0);
    expect(l.projected).toBe(3);
  });

  it("settle drops the hold, charges actual, reports refund delta", () => {
    const l = new BillingLedger();
    l.reserve("a", 10);
    const r = l.settle("a", 7);
    expect(r.charged).toBe(7);
    expect(r.estimated).toBe(10);
    expect(r.delta).toBe(-3); // refund
    expect(l.reserved).toBe(0);
    expect(l.committed).toBe(7);
  });

  it("settle reports overage when actual exceeds estimate", () => {
    const l = new BillingLedger();
    l.reserve("a", 5);
    expect(l.settle("a", 8).delta).toBe(3); // overage
  });

  it("enforces the cap before the call (throws, no overspend)", () => {
    const l = new BillingLedger(10, "user:u1");
    l.reserve("a", 8);
    expect(() => l.reserve("b", 5)).toThrowError(QuotaExceededError);
    // failed reservation left no hold
    expect(l.reserved).toBe(8);
  });

  it("re-reserving the same id replaces the prior hold (no double count)", () => {
    const l = new BillingLedger(10);
    l.reserve("a", 4);
    l.reserve("a", 9); // replace, not add — would exceed if added
    expect(l.reserved).toBe(9);
  });

  it("release cancels a hold without charging", () => {
    const l = new BillingLedger();
    l.reserve("a", 5);
    l.release("a");
    expect(l.reserved).toBe(0);
    expect(l.committed).toBe(0);
  });

  it("remaining reflects the cap, null when uncapped", () => {
    expect(new BillingLedger().remaining).toBeNull();
    const l = new BillingLedger(10);
    l.reserve("a", 4);
    expect(l.remaining).toBe(6);
  });

  it("composes scopes for a hierarchy: reserve against all, one cap trips", () => {
    const token = new BillingLedger(100, "token");
    const user = new BillingLedger(5, "user");
    token.reserve("req1", 4);
    user.reserve("req1", 4);
    // second request fits token but not user
    token.reserve("req2", 4);
    expect(() => user.reserve("req2", 4)).toThrowError(QuotaExceededError);
  });
});
