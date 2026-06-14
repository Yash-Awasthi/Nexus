// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  RunCostTracker,
  InMemoryRunCostStore,
  estimateCost,
  MODEL_PRICING,
  type RunStep,
} from "../src/index.js";

// ── estimateCost ──────────────────────────────────────────────────────────────

describe("estimateCost", () => {
  it("calculates cost for a known model", () => {
    const cost = estimateCost("gpt-4o", 1000, 500);
    expect(cost).toBeGreaterThan(0);
    // input: 1000/1000 * 0.0025 + 500/1000 * 0.01 = 0.0025 + 0.005 = 0.0075
    expect(cost).toBeCloseTo(0.0075, 6);
  });

  it("falls back to default price for unknown model", () => {
    const cost = estimateCost("totally-unknown-model-xyz", 1000, 1000);
    expect(cost).toBeGreaterThan(0);
  });

  it("returns 0 cost for 0 tokens", () => {
    expect(estimateCost("gpt-4o", 0, 0)).toBe(0);
  });

  it("output tokens cost more than input tokens for same model", () => {
    const inputCost = estimateCost("gpt-4o", 1000, 0);
    const outputCost = estimateCost("gpt-4o", 0, 1000);
    expect(outputCost).toBeGreaterThan(inputCost);
  });

  it("MODEL_PRICING covers common models", () => {
    for (const model of ["gpt-4o", "claude-sonnet-4.6", "gemini-2.5-flash"]) {
      expect(MODEL_PRICING[model]).toBeDefined();
    }
  });
});

// ── RunCostTracker ────────────────────────────────────────────────────────────

describe("RunCostTracker", () => {
  let now = 1_000_000;
  const mockNow = () => now;

  function makeTracker() {
    return new RunCostTracker({ now: mockNow });
  }

  it("starts a run and returns a runId", () => {
    const tracker = makeTracker();
    const runId = tracker.startRun("test-run");
    expect(typeof runId).toBe("string");
    expect(runId.length).toBeGreaterThan(0);
  });

  it("lists active run IDs", () => {
    const tracker = makeTracker();
    const runId = tracker.startRun("active");
    expect(tracker.activeRunIds()).toContain(runId);
  });

  it("recordStep adds a step to the run", () => {
    const tracker = makeTracker();
    const runId = tracker.startRun("test");
    const step = tracker.recordStep(runId, {
      step: "summarise",
      model: "gpt-4o",
      inputTokens: 500,
      outputTokens: 200,
    });
    expect(step.step).toBe("summarise");
    expect(step.model).toBe("gpt-4o");
    expect(step.totalTokens).toBe(700);
    expect(step.costUsd).toBeGreaterThan(0);
  });

  it("throws for unknown runId in recordStep", () => {
    const tracker = makeTracker();
    expect(() =>
      tracker.recordStep("nonexistent-id", { step: "x", model: "gpt-4o", inputTokens: 1, outputTokens: 1 }),
    ).toThrow();
  });

  it("endRun returns correct summary", () => {
    const tracker = makeTracker();
    const runId = tracker.startRun("research");

    tracker.recordStep(runId, { step: "classify", model: "gpt-4o", inputTokens: 100, outputTokens: 50 });
    tracker.recordStep(runId, { step: "summarise", model: "gpt-4o", inputTokens: 200, outputTokens: 100 });

    now += 5000;
    const summary = tracker.endRun(runId);

    expect(summary.totalTokens).toBe(450);
    expect(summary.totalInputTokens).toBe(300);
    expect(summary.totalOutputTokens).toBe(150);
    expect(summary.totalUsd).toBeGreaterThan(0);
    expect(summary.steps).toHaveLength(2);
    expect(summary.durationMs).toBe(5000);
  });

  it("removes run from active after endRun", () => {
    const tracker = makeTracker();
    const runId = tracker.startRun("temp");
    tracker.endRun(runId);
    expect(tracker.activeRunIds()).not.toContain(runId);
  });

  it("throws for unknown runId in endRun", () => {
    const tracker = makeTracker();
    expect(() => tracker.endRun("nonexistent")).toThrow();
  });

  it("peekRun returns summary without ending the run", () => {
    const tracker = makeTracker();
    const runId = tracker.startRun("peek-test");
    tracker.recordStep(runId, { step: "step1", model: "gpt-4o", inputTokens: 100, outputTokens: 50 });
    const peek = tracker.peekRun(runId);
    expect(peek.steps).toHaveLength(1);
    // Run still active
    expect(tracker.activeRunIds()).toContain(runId);
  });

  it("costByModel aggregates cost per model", () => {
    const tracker = makeTracker();
    const runId = tracker.startRun("multi-model");
    tracker.recordStep(runId, { step: "a", model: "gpt-4o", inputTokens: 500, outputTokens: 200 });
    tracker.recordStep(runId, { step: "b", model: "claude-sonnet-4.6", inputTokens: 300, outputTokens: 100 });
    const summary = tracker.endRun(runId);
    expect(summary.costByModel["gpt-4o"]).toBeGreaterThan(0);
    expect(summary.costByModel["claude-sonnet-4.6"]).toBeGreaterThan(0);
  });

  it("tokensByStep aggregates tokens per step name", () => {
    const tracker = makeTracker();
    const runId = tracker.startRun("steps");
    tracker.recordStep(runId, { step: "classify", model: "gpt-4o", inputTokens: 100, outputTokens: 50 });
    tracker.recordStep(runId, { step: "classify", model: "gpt-4o", inputTokens: 200, outputTokens: 100 });
    const summary = tracker.endRun(runId);
    // Both "classify" steps are summed
    expect(summary.tokensByStep["classify"]).toBe(450);
  });

  it("supports multiple concurrent runs", () => {
    const tracker = makeTracker();
    const id1 = tracker.startRun("run-1");
    const id2 = tracker.startRun("run-2");
    tracker.recordStep(id1, { step: "s1", model: "gpt-4o", inputTokens: 100, outputTokens: 50 });
    tracker.recordStep(id2, { step: "s2", model: "gpt-4o", inputTokens: 200, outputTokens: 100 });
    const s1 = tracker.endRun(id1);
    const s2 = tracker.endRun(id2);
    expect(s1.totalTokens).toBe(150);
    expect(s2.totalTokens).toBe(300);
  });

  it("persists to store on endRun", async () => {
    const store = new InMemoryRunCostStore();
    const tracker = new RunCostTracker({ store, now: mockNow });
    const runId = tracker.startRun("persist");
    tracker.recordStep(runId, { step: "x", model: "gpt-4o", inputTokens: 10, outputTokens: 5 });
    tracker.endRun(runId);
    // Allow fire-and-forget to complete
    await new Promise((r) => setTimeout(r, 10));
    const saved = await store.list();
    expect(saved.length).toBeGreaterThan(0);
  });
});
