// SPDX-License-Identifier: Apache-2.0
// End-to-end wiring test (pass 65): the API's council route now emits the
// pass-58/59 run-level transcript as the worker-shaped "council.transcript"
// JSON event — route evidence, one stage per vote, handler-consistent dissent
// mapping, metrics/traces/total_ms, OR-of-five degradation verdict. Pure: no
// DB, no LLM (imports only @nexus/council recorder + @nexus/contracts types).
import { describe, it, expect, vi, afterEach } from "vitest";

import {
  buildCouncilRunTranscript,
  emitCouncilTranscript,
  type CouncilRunInput,
} from "../../src/lib/council-transcript.js";
import type { CouncilRequest, ProposalResult, ModelVote } from "@nexus/contracts";

const request: CouncilRequest = {
  proposal: {
    title: "Should we ship the migration?",
    description: "Cut over to the new storage layer in production.",
  },
  timeoutMs: 60_000,
};

const votes: ModelVote[] = [
  {
    model: "nexus/smart",
    provider: "groq",
    vote: "yes",
    reasoning: "data checks pass",
    confidence: 0.9,
    latencyMs: 812,
  },
  {
    model: "nexus/sonnet",
    provider: "anthropic",
    vote: "yes",
    reasoning: "agreed",
    confidence: 0.8,
    latencyMs: 1240,
  },
  {
    model: "nexus/haiku",
    provider: "anthropic",
    vote: "no",
    reasoning: "rollback gap",
    confidence: 0.6,
    latencyMs: 340,
  },
];

function result(outcome: ProposalResult["outcome"]): ProposalResult {
  return {
    proposalId: "p-1",
    title: "Should we ship the migration?",
    outcome,
    consensus: outcome === "approved" ? 0.87 : 0.45,
    summary: "Ship after the rollback runbook lands.",
    votes,
    majority: outcome === "approved" ? "yes" : "no",
    dissent: outcome === "approved" ? 1 : 0,
    totalLatencyMs: votes.reduce((s, v) => s + v.latencyMs, 0),
    deliberatedAt: new Date().toISOString(),
    totalCostUsd: 0.0123,
  };
}

describe("buildCouncilRunTranscript (API route shape)", () => {
  it("records route evidence, per-vote stages, and the final answer", () => {
    const t = buildCouncilRunTranscript({
      request,
      result: result("approved"),
      votes,
      startedAt: 1_700_000_000_000,
    });
    expect(t.protocol).toBe("council");
    expect(t.query).toContain("Should we ship the migration?");
    expect(t.finalAnswer).toContain("rollback runbook");
    expect(t.confidence).toBeCloseTo(0.87, 5);
    expect(t.routing).toMatchObject({ mode: "explicit", tier: "council" });
    expect(t.routing.assigned_models).toEqual(["nexus/smart", "nexus/sonnet", "nexus/haiku"]);
    expect(t.auditTrail[1]).toMatchObject({ step: "finalize", outcome: "approved" });
    expect(t.stages.map((s) => s.name)).toEqual([
      "vote:nexus/smart",
      "vote:nexus/sonnet",
      "vote:nexus/haiku",
    ]);
    expect(t.stages[0]).toMatchObject({ vote: "yes", provider: "groq", latencyMs: 812 });
  });

  it("maps dissent like the route (non-majority, non-abstain)", () => {
    const t = buildCouncilRunTranscript({
      request,
      result: result("approved"),
      votes,
      startedAt: 1,
    });
    expect(t.dissent).toEqual(["nexus/haiku"]);
  });

  it("records no dissents when the outcome is deferred (no majority)", () => {
    const t = buildCouncilRunTranscript({
      request,
      result: result("deferred"),
      votes,
      startedAt: 1,
    });
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
    bad.consensus = NaN;
    const t = buildCouncilRunTranscript({ request, result: bad, votes, startedAt: 1 });
    expect(t.degraded).toBe(true);
    expect(t.confidence).toBe(0); // non-finite → 0, per the Weiping port
    expect(JSON.stringify(t.warnings)).toContain("confidence");
  });
});

describe("emitCouncilTranscript (worker-shaped event)", () => {
  const original = console.log;
  const originalError = console.error;

  afterEach(() => {
    console.log = original;
    console.error = originalError;
  });

  it("emits a worker-shaped council.transcript event with signalId", () => {
    const spy = vi.fn();
    console.log = spy;
    const startedAt = Date.now() - 1_000;
    emitCouncilTranscript({
      signalId: "sig-9",
      request,
      result: result("approved"),
      votes,
      startedAt,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const raw = spy.mock.calls[0]![0] as string;
    const event = JSON.parse(raw) as {
      level: string;
      event: string;
      signalId: string;
      transcript: { protocol: string; degraded: boolean; stages: { name: string }[] };
    };
    // worker-shaped contract (pass 59): { level, event, signalId, transcript }
    expect(event.level).toBe("info");
    expect(event.event).toBe("council.transcript");
    expect(event.signalId).toBe("sig-9");
    expect(event.transcript.protocol).toBe("council");
    expect(event.transcript.degraded).toBe(false);
    expect(event.transcript.stages).toHaveLength(3);
  });

  it("never throws and skips an empty / failed run", () => {
    const bad = result("rejected");
    const input: CouncilRunInput = {
      signalId: "sig-1",
      request,
      result: bad,
      votes: [],
      startedAt: 1,
    };
    expect(() => emitCouncilTranscript(input)).not.toThrow();
  });
});
