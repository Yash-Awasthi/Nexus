// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  detectContext,
  computeAutoTuneParams,
  updateEma,
  InMemoryEmaStore,
  CONTEXT_LABELS,
  type ContextType,
} from "../src/index.js";

describe("detectContext", () => {
  it("detects code context from code-related keywords", () => {
    const result = detectContext("How do I fix this TypeScript function that returns undefined?");
    expect(result.type).toBe("code");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("detects creative context from creative keywords", () => {
    const result = detectContext("Write a poem about the ocean at sunset");
    expect(result.type).toBe("creative");
  });

  it("detects analytical context from analysis keywords", () => {
    const result = detectContext("Analyze the pros and cons of microservices versus monoliths");
    expect(result.type).toBe("analytical");
  });

  it("detects conversational context for short messages", () => {
    const result = detectContext("Hey! How are you?");
    expect(result.type).toBe("conversational");
  });

  it("returns confidence between 0 and 1", () => {
    const result = detectContext("some message");
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("returns all context types in scores", () => {
    const result = detectContext("test message");
    const types = result.scores.map((s) => s.type);
    expect(types).toContain("code");
    expect(types).toContain("creative");
    expect(types).toContain("analytical");
  });

  it("defaults to conversational with confidence 0.5 when no patterns score", () => {
    // String > 30 chars with no keyword/symbol hits → total=0 → default branch
    // (empty string still matches conversational /^.{0,30}$/ and scores confidence=1)
    const result = detectContext("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); // 34 chars, no patterns
    expect(result.type).toBe("conversational");
    expect(result.confidence).toBe(0.5);
  });

  it("uses conversation history for scoring", () => {
    const history = [
      { role: "user", content: "fix the TypeScript compile error" },
      { role: "assistant", content: "Here's the fixed code..." },
    ];
    const result = detectContext("ok thanks", history);
    // History has code signals — confidence in code should be higher than without history
    const withHistory = result.scores.find((s) => s.type === "code")?.score ?? 0;
    const withoutHistory =
      detectContext("ok thanks").scores.find((s) => s.type === "code")?.score ?? 0;
    expect(withHistory).toBeGreaterThanOrEqual(withoutHistory);
  });
});

describe("computeAutoTuneParams", () => {
  it("returns lower temperature for code context", () => {
    const code = computeAutoTuneParams({ message: "fix my TypeScript interface function error" });
    const creative = computeAutoTuneParams({ message: "write a fantasy poem about dragons" });
    expect(code.params.temperature).toBeLessThan(creative.params.temperature);
  });

  it("returns higher temperature for creative context", () => {
    const creative = computeAutoTuneParams({
      message: "write a surreal poem with abstract metaphors",
    });
    expect(creative.params.temperature).toBeGreaterThan(0.8);
  });

  it("clamps temperature to [0, 2]", () => {
    const result = computeAutoTuneParams({ message: "test", overrides: { temperature: 99 } });
    expect(result.params.temperature).toBeLessThanOrEqual(2.0);
  });

  it("clamps top_p to [0, 1]", () => {
    const result = computeAutoTuneParams({ message: "test", overrides: { top_p: -5 } });
    expect(result.params.top_p).toBeGreaterThanOrEqual(0);
  });

  it("user overrides take absolute precedence", () => {
    const result = computeAutoTuneParams({
      message: "write a creative story",
      overrides: { temperature: 0.1 },
    });
    expect(result.params.temperature).toBe(0.1);
  });

  it("includes reasoning string", () => {
    const result = computeAutoTuneParams({ message: "how do I refactor this function?" });
    expect(result.reasoning).toBeTruthy();
    expect(typeof result.reasoning).toBe("string");
  });

  it("applies EMA learned delta when samples >= 3", () => {
    const learnedDelta = {
      temperature: 0.15,
      top_p: 0.05,
      frequency_penalty: 0,
      presence_penalty: 0,
      samples: 5,
    };
    const without = computeAutoTuneParams({ message: "analyze this data" });
    const withDelta = computeAutoTuneParams({ message: "analyze this data", learnedDelta });
    // With delta the temperature should be shifted
    expect(Math.abs(withDelta.params.temperature - without.params.temperature)).toBeGreaterThan(0);
  });

  it("ignores EMA when samples < 3", () => {
    const learnedDelta = {
      temperature: 0.5,
      top_p: 0.1,
      frequency_penalty: 0,
      presence_penalty: 0,
      samples: 1,
    };
    const without = computeAutoTuneParams({ message: "test" });
    const withDelta = computeAutoTuneParams({ message: "test", learnedDelta });
    expect(withDelta.params.temperature).toBe(without.params.temperature);
  });

  it("applies repetition penalty boost for long conversations", () => {
    const shortHistory = Array.from({ length: 3 }, (_, i) => ({
      role: "user",
      content: `msg${i}`,
    }));
    const longHistory = Array.from({ length: 20 }, (_, i) => ({
      role: "user",
      content: `msg${i}`,
    }));
    const short = computeAutoTuneParams({ message: "test", history: shortHistory });
    const long = computeAutoTuneParams({ message: "test", history: longHistory });
    expect(long.params.repetition_penalty).toBeGreaterThan(short.params.repetition_penalty);
  });
});

describe("updateEma + InMemoryEmaStore", () => {
  it("stores a learned delta after one update", async () => {
    const store = new InMemoryEmaStore();
    await updateEma("code", 2, store); // rating 2 < 3 → should push temp up
    const delta = await store.get("code");
    expect(delta).toBeDefined();
    expect(delta!.samples).toBe(1);
  });

  it("positive rating leads to downward temperature adjustment", async () => {
    const store = new InMemoryEmaStore();
    await updateEma("creative", 5, store); // rating 5 > 3 → temp was too high
    const delta = await store.get("creative");
    // Deviation = 5-3 = +2, tempAdjust = -(+2)/2 * 0.05 = -0.05 * EMA
    expect(delta!.temperature).toBeLessThan(0);
  });

  it("negative rating leads to upward temperature adjustment", async () => {
    const store = new InMemoryEmaStore();
    await updateEma("analytical", 1, store); // rating 1 < 3 → too boring
    const delta = await store.get("analytical");
    expect(delta!.temperature).toBeGreaterThan(0);
  });

  it("accumulates samples across multiple ratings", async () => {
    const store = new InMemoryEmaStore();
    await updateEma("code", 3, store);
    await updateEma("code", 3, store);
    await updateEma("code", 3, store);
    const delta = await store.get("code");
    expect(delta!.samples).toBe(3);
  });
});

describe("CONTEXT_LABELS", () => {
  it("has a label for all context types", () => {
    const types: ContextType[] = ["code", "creative", "analytical", "conversational", "chaotic"];
    for (const t of types) {
      expect(CONTEXT_LABELS[t]).toBeTruthy();
    }
  });
});
