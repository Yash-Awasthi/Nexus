// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import { FeedbackStore, PipelineExporter } from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStore() { return new FeedbackStore(); }

function addFb(
  store: FeedbackStore,
  rating: "thumbs_up" | "thumbs_down" | "neutral" = "thumbs_up",
  overrides: Partial<{
    sessionId: string;
    messageId: string;
    promptText: string;
    responseText: string;
    model: string;
    userId: string;
  }> = {},
) {
  return store.addFeedback({
    sessionId:    overrides.sessionId    ?? "s1",
    messageId:    overrides.messageId    ?? "m1",
    promptText:   overrides.promptText   ?? "What is TypeScript?",
    responseText: overrides.responseText ?? "TypeScript is a typed superset of JavaScript.",
    model:        overrides.model        ?? "claude-3",
    rating,
    source: "ui",
    userId: overrides.userId ?? "user-1",
  });
}

// ── FeedbackStore ─────────────────────────────────────────────────────────────

describe("FeedbackStore — addFeedback", () => {
  let store: FeedbackStore;
  beforeEach(() => { store = makeStore(); });

  it("adds feedback and returns entry with id", () => {
    const e = addFb(store);
    expect(e.id).toBeTruthy();
    expect(e.createdAt).toBeTruthy();
    expect(e.rating).toBe("thumbs_up");
  });

  it("feedbackCount increments", () => {
    addFb(store);
    addFb(store, "thumbs_down");
    expect(store.feedbackCount()).toBe(2);
  });

  it("getFeedback retrieves by id", () => {
    const e = addFb(store);
    expect(store.getFeedback(e.id)).toEqual(e);
  });

  it("getFeedback returns undefined for unknown id", () => {
    expect(store.getFeedback("ghost")).toBeUndefined();
  });

  it("deleteFeedback removes entry", () => {
    const e = addFb(store);
    expect(store.deleteFeedback(e.id)).toBe(true);
    expect(store.feedbackCount()).toBe(0);
  });

  it("deleteFeedback returns false for unknown id", () => {
    expect(store.deleteFeedback("ghost")).toBe(false);
  });
});

describe("FeedbackStore — queryFeedback", () => {
  let store: FeedbackStore;
  beforeEach(() => {
    store = makeStore();
    addFb(store, "thumbs_up",   { sessionId: "s1", model: "claude-3", userId: "alice" });
    addFb(store, "thumbs_down", { sessionId: "s1", model: "gpt-4",    userId: "bob" });
    addFb(store, "neutral",     { sessionId: "s2", model: "claude-3", userId: "alice" });
  });

  it("returns all entries without filter", () => {
    expect(store.queryFeedback()).toHaveLength(3);
  });

  it("filters by sessionId", () => {
    expect(store.queryFeedback({ sessionId: "s1" })).toHaveLength(2);
  });

  it("filters by rating", () => {
    expect(store.queryFeedback({ rating: "thumbs_up" })).toHaveLength(1);
  });

  it("filters by model", () => {
    expect(store.queryFeedback({ model: "claude-3" })).toHaveLength(2);
  });

  it("filters by userId", () => {
    expect(store.queryFeedback({ userId: "alice" })).toHaveLength(2);
  });

  it("returns sorted by createdAt", () => {
    const r = store.queryFeedback();
    for (let i = 1; i < r.length; i++) {
      expect(r[i]!.createdAt >= r[i - 1]!.createdAt).toBe(true);
    }
  });
});

describe("FeedbackStore — preference pairs", () => {
  let store: FeedbackStore;
  beforeEach(() => { store = makeStore(); });

  it("adds and retrieves preference pairs", () => {
    const p = store.addPreferencePair({
      promptText: "What is X?",
      chosen: "Good answer",
      rejected: "Bad answer",
    });
    expect(p.id).toBeTruthy();
    expect(store.getPreferencePair(p.id)).toEqual(p);
  });

  it("listPreferencePairs returns all", () => {
    store.addPreferencePair({ promptText: "A?", chosen: "c1", rejected: "r1" });
    store.addPreferencePair({ promptText: "B?", chosen: "c2", rejected: "r2" });
    expect(store.listPreferencePairs()).toHaveLength(2);
  });

  it("pairCount reflects additions", () => {
    store.addPreferencePair({ promptText: "Q", chosen: "c", rejected: "r" });
    expect(store.pairCount()).toBe(1);
  });
});

describe("FeedbackStore — generatePreferencePairs", () => {
  it("generates pairs from thumbs_up vs thumbs_down on same prompt", () => {
    const store = makeStore();
    addFb(store, "thumbs_up",   { promptText: "Q?", responseText: "Good response" });
    addFb(store, "thumbs_down", { promptText: "Q?", responseText: "Bad response" });
    const pairs = store.generatePreferencePairs();
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.chosen).toBe("Good response");
    expect(pairs[0]!.rejected).toBe("Bad response");
  });

  it("generates no pairs when no matching thumbs_down", () => {
    const store = makeStore();
    addFb(store, "thumbs_up", { promptText: "Q?" });
    expect(store.generatePreferencePairs()).toHaveLength(0);
  });

  it("generates M×N pairs for M positive and N negative", () => {
    const store = makeStore();
    addFb(store, "thumbs_up",   { promptText: "Q?", responseText: "G1" });
    addFb(store, "thumbs_up",   { promptText: "Q?", responseText: "G2" });
    addFb(store, "thumbs_down", { promptText: "Q?", responseText: "B1" });
    const pairs = store.generatePreferencePairs();
    expect(pairs).toHaveLength(2); // 2 × 1
  });
});

describe("FeedbackStore — computeRewardSignal", () => {
  it("computes correct rewardScore", () => {
    const store = makeStore();
    addFb(store, "thumbs_up",   { sessionId: "s1" });
    addFb(store, "thumbs_up",   { sessionId: "s1" });
    addFb(store, "thumbs_down", { sessionId: "s1" });
    const signal = store.computeRewardSignal("s1");
    expect(signal.positiveCount).toBe(2);
    expect(signal.negativeCount).toBe(1);
    // (2-1)/3 = 0.333
    expect(signal.rewardScore).toBeCloseTo(1 / 3, 5);
  });

  it("rewardScore is 0 for session with no feedback", () => {
    const store = makeStore();
    const signal = store.computeRewardSignal("ghost");
    expect(signal.rewardScore).toBe(0);
    expect(signal.totalFeedback).toBe(0);
  });

  it("rewardScore is -1 for all thumbs_down", () => {
    const store = makeStore();
    addFb(store, "thumbs_down", { sessionId: "neg" });
    expect(store.computeRewardSignal("neg").rewardScore).toBe(-1);
  });
});

// ── PipelineExporter ──────────────────────────────────────────────────────────

describe("PipelineExporter", () => {
  let store: FeedbackStore;
  let exporter: PipelineExporter;

  beforeEach(() => {
    store = makeStore();
    exporter = new PipelineExporter(store);
  });

  it("toJSONL exports pairs as JSONL", () => {
    store.addPreferencePair({ promptText: "Q?", chosen: "C", rejected: "R" });
    const jsonl = exporter.toJSONL();
    const parsed = JSON.parse(jsonl);
    expect(parsed.prompt).toBe("Q?");
    expect(parsed.chosen).toBe("C");
    expect(parsed.rejected).toBe("R");
  });

  it("toJSONL returns empty string when no pairs", () => {
    expect(exporter.toJSONL()).toBe("");
  });

  it("feedbackToJSONL exports entries", () => {
    addFb(store);
    const jsonl = exporter.feedbackToJSONL();
    expect(jsonl).toContain("thumbs_up");
  });

  it("feedbackToJSONL supports filter", () => {
    addFb(store, "thumbs_up",   { sessionId: "s1" });
    addFb(store, "thumbs_down", { sessionId: "s2" });
    const jsonl = exporter.feedbackToJSONL({ sessionId: "s1" });
    const lines = jsonl.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it("stats returns correct breakdown", () => {
    addFb(store, "thumbs_up");
    addFb(store, "thumbs_up");
    addFb(store, "thumbs_down");
    addFb(store, "neutral");
    store.addPreferencePair({ promptText: "Q", chosen: "c", rejected: "r" });
    const s = exporter.stats();
    expect(s.totalFeedback).toBe(4);
    expect(s.totalPairs).toBe(1);
    expect(s.ratingBreakdown.thumbs_up).toBe(2);
    expect(s.ratingBreakdown.thumbs_down).toBe(1);
    expect(s.ratingBreakdown.neutral).toBe(1);
  });
});
