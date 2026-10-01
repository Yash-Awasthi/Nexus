// SPDX-License-Identifier: Apache-2.0
/**
 * §1.5 seed round-trip tests — provider_models rows → ProviderModel → registry.
 * Pure unit tests over the structural row shape; no DB, no network. Prices are
 * stored per-token in the DB and surface as per-1M-token USD on the registry's
 * ProviderModel (the shape @nexus/billing prices from).
 */
import { describe, it, expect } from "vitest";

import {
  ProviderRegistry,
  registerFromProviderModelRows,
  rowToModelDefinition,
  type ProviderModelRowLike,
} from "../src/index.js";

function makeRow(overrides: Partial<ProviderModelRowLike> = {}): ProviderModelRowLike {
  return {
    id: "anthropic/claude-3-5-sonnet-20241022",
    provider: "anthropic",
    name: "Claude 3.5 Sonnet",
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    costPerInputToken: 3e-6,
    costPerOutputToken: 15e-6,
    costPerCacheReadToken: 0.3e-6,
    costPerCacheWriteToken: 3.75e-6,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    knowledgeCutoff: "2024-04",
    releaseDate: "2024-10-22",
    deprecated: false,
    capabilities: { vision: true, functionCalling: true, streaming: true, promptCaching: true },
    source: "models.dev",
    ...overrides,
  };
}

describe("rowToModelDefinition", () => {
  it("maps ids, names and limits verbatim", () => {
    const def = rowToModelDefinition(makeRow());
    expect(def.id).toBe("anthropic/claude-3-5-sonnet-20241022");
    expect(def.name).toBe("Claude 3.5 Sonnet");
    expect(def.contextWindow).toBe(200_000);
    expect(def.maxOutput).toBe(8192);
  });

  it("scales per-token DB prices to per-1M-token registry prices", () => {
    const def = rowToModelDefinition(makeRow());
    expect(def.inputCost).toBeCloseTo(3, 9); // $3 / MTok
    expect(def.outputCost).toBeCloseTo(15, 9); // $15 / MTok
  });

  it("derives vision/toolUse from the stored capability record", () => {
    const def = rowToModelDefinition(makeRow());
    expect(def.vision).toBe(true);
    expect(def.toolUse).toBe(true);
    expect(def.streaming).toBe(true);
  });

  it("falls back to modality-derived vision when the stored record is empty", () => {
    const def = rowToModelDefinition(makeRow({ capabilities: null }));
    expect(def.vision).toBe(true); // image input modality
    expect(def.toolUse).toBe(false); // unknown → conservative
  });

  it("yields null prices for free models", () => {
    const def = rowToModelDefinition(
      makeRow({
        id: "groq/llama-3.1-8b-instant",
        provider: "groq",
        costPerInputToken: null,
        costPerOutputToken: null,
        costPerCacheReadToken: null,
        costPerCacheWriteToken: null,
        inputModalities: ["text"],
        capabilities: null,
      }),
    );
    expect(def.inputCost).toBeNull();
    expect(def.outputCost).toBeNull();
    expect(def.vision).toBe(false);
  });
});

describe("registerFromProviderModelRows", () => {
  it("registers every non-deprecated row and makes it priceable via findModel", () => {
    const reg = new ProviderRegistry();
    const count = registerFromProviderModelRows(reg, [
      makeRow(),
      makeRow({ id: "groq/llama-3.1-8b-instant", provider: "groq", name: "Llama 3.1 8B" }),
    ]);
    expect(count).toBe(2);
    expect(reg.findModel("anthropic/claude-3-5-sonnet-20241022")).toBeDefined();
    expect(reg.findModel("groq/llama-3.1-8b-instant")).toBeDefined();
    // 1M input tokens at $3/M → $3 — billing prices via findModel().model.inputCost
    const m = reg.findModel("anthropic/claude-3-5-sonnet-20241022")!.model;
    expect(m.inputCost).toBeCloseTo(3, 9); // USD per 1M tokens
  });

  it("skips deprecated rows — they stay in the table but out of the registry", () => {
    const reg = new ProviderRegistry();
    const count = registerFromProviderModelRows(reg, [
      makeRow(),
      makeRow({ id: "old/model", provider: "old", deprecated: true }),
    ]);
    expect(count).toBe(1);
    expect(reg.findModel("old/model")).toBeUndefined();
  });

  it("registers nothing for an empty table", () => {
    const reg = new ProviderRegistry();
    expect(registerFromProviderModelRows(reg, [])).toBe(0);
    expect(reg.list()).toHaveLength(0);
  });
});
