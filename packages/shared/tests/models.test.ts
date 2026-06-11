// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { MODEL_KEYS, MODEL_REGISTRY, getModel, type ModelKey } from "../src/models.js";

describe("MODEL_REGISTRY", () => {
  it("has at least 10 entries", () => {
    expect(MODEL_KEYS.length).toBeGreaterThanOrEqual(10);
  });

  it("every entry has a non-empty id and provider", () => {
    for (const key of MODEL_KEYS) {
      const m = MODEL_REGISTRY[key];
      expect(m.id.length).toBeGreaterThan(0);
      expect(["anthropic", "openai", "google", "groq", "mistral"]).toContain(m.provider);
    }
  });

  it("every entry has positive contextWindow and maxOutput", () => {
    for (const key of MODEL_KEYS) {
      const m = MODEL_REGISTRY[key];
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxOutput).toBeGreaterThan(0);
    }
  });

  it("every entry has non-negative pricing", () => {
    for (const key of MODEL_KEYS) {
      const m = MODEL_REGISTRY[key];
      expect(m.inputPricePer1M).toBeGreaterThanOrEqual(0);
      expect(m.outputPricePer1M).toBeGreaterThanOrEqual(0);
    }
  });

  it("getModel returns the correct entry", () => {
    const m = getModel("anthropic/claude-sonnet-4-5");
    expect(m.provider).toBe("anthropic");
    expect(m.id).toBe("claude-sonnet-4-5");
  });

  it("all 5 providers are represented", () => {
    const providers = new Set(MODEL_KEYS.map((k) => MODEL_REGISTRY[k].provider));
    expect(providers.has("anthropic")).toBe(true);
    expect(providers.has("openai")).toBe(true);
    expect(providers.has("google")).toBe(true);
    expect(providers.has("groq")).toBe(true);
    expect(providers.has("mistral")).toBe(true);
  });

  it("type-level: ModelKey is a literal union of registry keys", () => {
    // Compile-time check: this assignment would fail if ModelKey were 'string'
    const key: ModelKey = "groq/llama-3-3-70b-versatile";
    expect(MODEL_REGISTRY[key].provider).toBe("groq");
  });
});
