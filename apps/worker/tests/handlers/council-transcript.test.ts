// SPDX-License-Identifier: Apache-2.0
// End-to-end wiring test (pass 59): buildCouncilRunTranscript composes the
// pass-58 inspectable transcript artifact from a real council job's inputs —
// route evidence, one stage per vote, handler-consistent dissent mapping,
// metrics/traces/total_ms, OR-of-five degradation verdict. Pure: no DB, no LLM.
import { describe, it, expect } from "vitest";
import { buildCouncilRunTranscript, councilTranscriptJson } from "@nexus/council";
import type { CouncilRequest, ProposalResult, ModelVote } from "@nexus/contracts";

const request: CouncilRequest = {
  proposal: {
    title: "Should we ship the migration?",
    description: "Cut over to the new storage layer in production.",
  },
  timeoutMs: 60_000,
};

const votes: ModelVote[] = [
  { model: "nexus/smart", provider: "groq", vote: "yes", reasoning: "data checks pass", confidence: 0.9, latencyMs: 812 },
  { model: "nexus/sonnet", provider: "anthropic", vote: "yes", reasoning: "agreed", confidence: 0.8, latencyMs: 1240 },
  { model: "nexus/haiku", provider: "anthropic", vote: "no", reasoning: "rollback gap", confidence: 0.6, latencyMs: 340 },
];

function result(outcome: ProposalResult["outcome"]): ProposalResult {
  return {
    proposalId: "p-1",
    outcome,
    consensus: outcome === "approved" ? 0.87 : 0.45,
    summary: "Ship after the rollback runbook lands.",
    votes,
    totalCostUsd: 0.0123,
  };
}

describe("buildCouncilRunTranscript", () => {
  it("records route evidence, per-vote stages, and the final answer", () => {
    const t = buildCouncilRunTranscript({ request, result: result("approved"), votes, startedAt: 1_700_000_000_000 });
    expect(t.protocol).toBe("council");
    expect(t.query).toContain("Should we ship the migration?");
    expect(t.finalAnswer).toContain("rollback runbook");
    expect(t.confidence).toBeCloseTo(0.87, 5);
    expect(t.routing).toMatchObject({ mode: "explicit", tier: "council" });
    expect(t.routing.assigned_models).toEqual(["nexus/smart", "nexus/sonnet", "nexus/haiku"]);
    expect(t.auditTrail[0]).toMatchObject({ step: "routing" });
    expect(t.auditTrail[1]).toMatchObject({ step: "finalize", outcome: "approved" });
    expect(t.stages.map((s) => s.name)).toEqual([
      "vote:nexus/smart",
      "vote:nexus/sonnet",
      "vote:nexus/haiku",
    ]);
    expect(t.stages[0]).toMatchObject({ vote: "yes", provider: "groq", latencyMs: 812 });
  });

  it("maps dissent like the handler (non-majority, non-abstain)", () => {
    const t = buildCouncilRunTranscript({ request, result: result("approved"), votes, startedAt: 1 });
    expect(t.dissent).toEqual(["nexus/haiku"]);
  });

  it("records no dissents when the outcome is deferred (no majority)", () => {
    const t = buildCouncilRunTranscript({ request, result: result("deferred"), votes, startedAt: 1 });
    expect(t.dissent).toEqual([]);
  });

  it("finalizes metrics, traces, and total_ms over the run", () => {
    const startedAt = Date.now() - 5_000;
    const t = buildCouncilRunTranscript({ request, result: result("approved"), votes, startedAt });
    expect(t.metrics.successful_model_calls).toBe(3);
    expect(t.metrics.failed_model_calls).toBe(0);
    expect(t.metrics.total_ms).toBeGreaterThanOrEqual(4_999);
    expect(t.modelCallTraces).toHaveLength(3);
    expect(t.modelCallTraces[1]).toMatchObject({ model: "nexus/sonnet", latencyMs: 1240 });
    expect(t.degraded).toBe(false);
    expect(t.warnings).toEqual([]);
  });

  it("flags and clamps an invalid consensus through the degradation OR", () => {
    const bad = result("approved");
    bad.consensus = 1.7;
    const t = buildCouncilRunTranscript({ request, result: bad, votes, startedAt: 1 });
    expect(t.confidence).toBe(1);
    expect(t.degraded).toBe(true);
    expect(t.warnings).toContain("Model-reported confidence was invalid and has been clamped.");
  });

  it("serializes to a JSON event payload", () => {
    const t = buildCouncilRunTranscript({ request, result: result("approved"), votes, startedAt: 1_700_000_000_000 });
    const parsed = JSON.parse(councilTranscriptJson(t));
    expect(parsed.id).toMatch(/^council-/);
    expect(parsed.stages).toHaveLength(3);
    expect(parsed.dissent).toEqual(["nexus/haiku"]);
    expect(parsed.routing.mode).toBe("explicit");
  });
});