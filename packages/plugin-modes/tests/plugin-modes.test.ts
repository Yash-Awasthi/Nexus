// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  PluginModeRegistry,
  BUILTIN_MODES,
  globalModes,
  type PluginMode,
  type BaseAutoTuneParams,
} from "../src/index.js";

const BASE: BaseAutoTuneParams = {
  temperature: 0.7,
  top_p: 0.9,
  top_k: 50,
  frequency_penalty: 0.1,
  presence_penalty: 0.1,
  repetition_penalty: 1.0,
};

// ── PluginModeRegistry ────────────────────────────────────────────────────────

describe("PluginModeRegistry", () => {
  it("register and get", () => {
    const r = new PluginModeRegistry();
    const mode: PluginMode = {
      id: "test",
      params: { temperatureDelta: 0.1 },
      systemPromptSnippet: "test snippet",
    };
    r.register(mode);
    expect(r.get("test")).toBe(mode);
  });

  it("has() returns correct boolean", () => {
    const r = new PluginModeRegistry();
    r.register({ id: "x", params: {}, systemPromptSnippet: "" });
    expect(r.has("x")).toBe(true);
    expect(r.has("y")).toBe(false);
  });

  it("list() returns all registered modes", () => {
    const r = new PluginModeRegistry();
    r.register({ id: "a", params: {}, systemPromptSnippet: "" });
    r.register({ id: "b", params: {}, systemPromptSnippet: "" });
    expect(r.list()).toHaveLength(2);
  });

  it("overwrites existing mode on re-register", () => {
    const r = new PluginModeRegistry();
    r.register({ id: "m", params: { temperatureDelta: 0.1 }, systemPromptSnippet: "old" });
    r.register({ id: "m", params: { temperatureDelta: 0.5 }, systemPromptSnippet: "new" });
    expect(r.get("m")!.systemPromptSnippet).toBe("new");
  });
});

// ── apply() ───────────────────────────────────────────────────────────────────

describe("PluginModeRegistry.apply()", () => {
  it("returns base params with empty snippet for unknown mode", () => {
    const r = new PluginModeRegistry();
    const result = r.apply(BASE, "unknown");
    expect(result.params.temperature).toBe(0.7);
    expect(result.systemPromptSnippet).toBe("");
    expect(result.locale).toBeUndefined();
  });

  it("applies temperatureDelta correctly", () => {
    const r = new PluginModeRegistry();
    r.register({ id: "hot", params: { temperatureDelta: 0.3 }, systemPromptSnippet: "" });
    const { params } = r.apply(BASE, "hot");
    expect(params.temperature).toBeCloseTo(1.0);
  });

  it("applies negative temperatureDelta correctly", () => {
    const r = new PluginModeRegistry();
    r.register({ id: "cold", params: { temperatureDelta: -0.5 }, systemPromptSnippet: "" });
    const { params } = r.apply(BASE, "cold");
    expect(params.temperature).toBeCloseTo(0.2);
  });

  it("clamps temperature to [0, 2]", () => {
    const r = new PluginModeRegistry();
    r.register({ id: "over", params: { temperatureDelta: 5 }, systemPromptSnippet: "" });
    r.register({ id: "under", params: { temperatureDelta: -5 }, systemPromptSnippet: "" });
    expect(r.apply(BASE, "over").params.temperature).toBe(2);
    expect(r.apply(BASE, "under").params.temperature).toBe(0);
  });

  it("clamps top_p to [0, 1]", () => {
    const r = new PluginModeRegistry();
    r.register({ id: "m", params: { top_pDelta: 5 }, systemPromptSnippet: "" });
    expect(r.apply(BASE, "m").params.top_p).toBe(1);
  });

  it("clamps top_k to [1, 100] and rounds", () => {
    const r = new PluginModeRegistry();
    r.register({ id: "big", params: { top_kDelta: 200 }, systemPromptSnippet: "" });
    r.register({ id: "small", params: { top_kDelta: -200 }, systemPromptSnippet: "" });
    expect(r.apply(BASE, "big").params.top_k).toBe(100);
    expect(r.apply(BASE, "small").params.top_k).toBe(1);
  });

  it("returns systemPromptSnippet from mode", () => {
    const r = new PluginModeRegistry();
    r.register({ id: "m", params: {}, systemPromptSnippet: "Be brief." });
    expect(r.apply(BASE, "m").systemPromptSnippet).toBe("Be brief.");
  });

  it("returns locale from mode", () => {
    const r = new PluginModeRegistry();
    r.register({ id: "ar-mode", params: {}, systemPromptSnippet: "Respond in Arabic.", locale: "ar" });
    expect(r.apply(BASE, "ar-mode").locale).toBe("ar");
  });

  it("uses default params when base is empty", () => {
    const r = new PluginModeRegistry();
    r.register({ id: "m", params: { temperatureDelta: 0.1 }, systemPromptSnippet: "" });
    const result = r.apply({}, "m");
    // default temperature is 0.7, delta 0.1 → 0.8
    expect(result.params.temperature).toBeCloseTo(0.8);
  });

  it("preserves repetition_penalty unchanged", () => {
    const r = new PluginModeRegistry();
    r.register({ id: "m", params: { temperatureDelta: 0.1 }, systemPromptSnippet: "" });
    expect(r.apply({ ...BASE, repetition_penalty: 1.15 }, "m").params.repetition_penalty).toBe(1.15);
  });
});

// ── applyAll() ────────────────────────────────────────────────────────────────

describe("PluginModeRegistry.applyAll()", () => {
  it("returns base params with empty snippet for no modes", () => {
    const r = new PluginModeRegistry();
    const result = r.applyAll(BASE, []);
    expect(result.params.temperature).toBe(0.7);
    expect(result.systemPromptSnippet).toBe("");
  });

  it("accumulates deltas across multiple modes", () => {
    const r = new PluginModeRegistry();
    r.register({ id: "a", params: { temperatureDelta: 0.1 }, systemPromptSnippet: "A" });
    r.register({ id: "b", params: { temperatureDelta: 0.1 }, systemPromptSnippet: "B" });
    const result = r.applyAll(BASE, ["a", "b"]);
    expect(result.params.temperature).toBeCloseTo(0.9);
  });

  it("joins system prompt snippets with double newline", () => {
    const r = new PluginModeRegistry();
    r.register({ id: "a", params: {}, systemPromptSnippet: "Snippet A." });
    r.register({ id: "b", params: {}, systemPromptSnippet: "Snippet B." });
    const result = r.applyAll(BASE, ["a", "b"]);
    expect(result.systemPromptSnippet).toBe("Snippet A.\n\nSnippet B.");
  });

  it("picks first locale encountered", () => {
    const r = new PluginModeRegistry();
    r.register({ id: "ar", params: {}, systemPromptSnippet: "", locale: "ar" });
    r.register({ id: "bn", params: {}, systemPromptSnippet: "", locale: "bn" });
    expect(r.applyAll(BASE, ["ar", "bn"]).locale).toBe("ar");
  });

  it("skips snippet for modes with empty snippet", () => {
    const r = new PluginModeRegistry();
    r.register({ id: "a", params: {}, systemPromptSnippet: "" });
    r.register({ id: "b", params: {}, systemPromptSnippet: "B" });
    expect(r.applyAll(BASE, ["a", "b"]).systemPromptSnippet).toBe("B");
  });
});

// ── BUILTIN_MODES ─────────────────────────────────────────────────────────────

describe("BUILTIN_MODES", () => {
  it("exports all 7 built-in modes", () => {
    const ids = BUILTIN_MODES.map((m) => m.id);
    expect(ids).toContain("chill");
    expect(ids).toContain("precise");
    expect(ids).toContain("creative");
    expect(ids).toContain("debug");
    expect(ids).toContain("concise");
    expect(ids).toContain("ar");
    expect(ids).toContain("bn");
  });

  it("chill lowers temperature", () => {
    const result = globalModes.apply(BASE, "chill");
    expect(result.params.temperature).toBeLessThan(BASE.temperature!);
  });

  it("precise lowers temperature and top_k", () => {
    const result = globalModes.apply(BASE, "precise");
    expect(result.params.temperature).toBeLessThan(BASE.temperature!);
    expect(result.params.top_k).toBeLessThan(BASE.top_k!);
  });

  it("creative raises temperature and top_k", () => {
    const result = globalModes.apply(BASE, "creative");
    expect(result.params.temperature).toBeGreaterThan(BASE.temperature!);
    expect(result.params.top_k).toBeGreaterThan(BASE.top_k!);
  });

  it("ar mode has locale 'ar'", () => {
    expect(globalModes.apply(BASE, "ar").locale).toBe("ar");
  });

  it("bn mode has locale 'bn'", () => {
    expect(globalModes.apply(BASE, "bn").locale).toBe("bn");
  });

  it("all built-in modes have non-empty systemPromptSnippet", () => {
    for (const mode of BUILTIN_MODES) {
      expect(mode.systemPromptSnippet.length).toBeGreaterThan(0);
    }
  });
});

// ── globalModes ───────────────────────────────────────────────────────────────

describe("globalModes", () => {
  it("contains all BUILTIN_MODES", () => {
    const ids = globalModes.list().map((m) => m.id);
    for (const mode of BUILTIN_MODES) {
      expect(ids).toContain(mode.id);
    }
  });
});
