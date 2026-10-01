// SPDX-License-Identifier: Apache-2.0
// Focused tests for the shared run/tool transcript compositions (pass 66).
// Every app surface (worker council job, worker agent-MCP tools, CLI local
// agent, API council routes) imports these from @nexus/council instead of
// carrying its own copy — these tests pin the shared artifact contract so a
// change here is one change, not four.
import { describe, it, expect } from "vitest";

import {
  buildCouncilRunTranscript,
  councilTranscriptEvent,
  councilTranscriptJson,
  maskModelIdentity,
  maskedCouncilTranscript,
  recordToolTranscript,
  toolTranscriptEvent,
  type CouncilRunInput,
} from "./run-transcript.js";
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

function runInput(overrides: Partial<CouncilRunInput> = {}): CouncilRunInput {
  return {
    signalId: "sig-1",
    request,
    result: result("approved"),
    votes,
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("maskedCouncilTranscript / maskModelIdentity (blind-council masking)", () => {
  it("anonymizes every structured model-identity field into voter placeholders", () => {
    const m = maskedCouncilTranscript(runInput());
    expect(m.routing.assigned_models).toEqual(["voter_1", "voter_2", "voter_3"]);
    expect(m.stages.map((s) => s.name)).toEqual(["vote:voter_1", "vote:voter_2", "vote:voter_3"]);
    expect(m.dissent).toEqual(["voter_3"]);
    expect(m.modelCallTraces.map((tr) => tr.model)).toEqual(["voter_1", "voter_2", "voter_3"]);
    // the routing audit-trail copy is masked the same way
    const routingEntry = m.auditTrail.find((e) => e.step === "routing");
    expect(routingEntry?.assigned_models).toEqual(["voter_1", "voter_2", "voter_3"]);
    // no raw model string survives anywhere in the artifact
    expect(JSON.stringify(m)).not.toContain("nexus/");
  });

  it("keeps protocol/stage/verdict/dissent-count/metrics semantics identical to the unmasked run", () => {
    const plain = buildCouncilRunTranscript(runInput());
    const m = maskModelIdentity(plain);
    expect(m.protocol).toBe(plain.protocol);
    expect(m.id).toBe(plain.id);
    expect(m.query).toBe(plain.query);
    expect(m.finalAnswer).toBe(plain.finalAnswer);
    expect(m.confidence).toBe(plain.confidence);
    expect(m.degraded).toBe(plain.degraded);
    expect(m.metrics).toEqual(plain.metrics);
    expect(m.warnings).toEqual(plain.warnings);
    expect(m.auditTrail.filter((e) => e.step !== "routing")).toEqual(
      plain.auditTrail.filter((e) => e.step !== "routing"),
    );
    // stages keep every non-model field (vote/provider/confidence/latencyMs)
    expect(m.stages[0]).toMatchObject({ vote: "yes", provider: "groq" });
    expect(m.stages[0].confidence).toBe(plain.stages[0].confidence);
    expect(m.stages[0].latencyMs).toBe(plain.stages[0].latencyMs);
    expect(m.stages[0].name).not.toBe(plain.stages[0].name); // only the name is masked
    // traces keep provider + error semantics
    expect(m.modelCallTraces[0]).toMatchObject({ provider: "groq" });
  });

  it("maps deterministically: the same blind run always yields the same voter placeholders", () => {
    const a = maskedCouncilTranscript(runInput());
    const b = maskedCouncilTranscript(runInput());
    expect(a.routing.assigned_models).toEqual(b.routing.assigned_models);
    expect(a.stages.map((s) => s.name)).toEqual(b.stages.map((s) => s.name));
    expect(a.dissent).toEqual(b.dissent);
    expect(a.modelCallTraces.map((tr) => tr.model)).toEqual(
      b.modelCallTraces.map((tr) => tr.model),
    );
    // same model appearing in two votes still maps to the same voter
    const dup = runInput({
      votes: [...votes, { ...votes[0], latencyMs: 999 }],
    });
    const d = maskedCouncilTranscript(dup);
    expect(d.stages.map((s) => s.name)).toEqual([
      "vote:voter_1",
      "vote:voter_2",
      "vote:voter_3",
      "vote:voter_1",
    ]);
  });

  it("does not mutate the caller's unmasked transcript", () => {
    const plain = buildCouncilRunTranscript(runInput());
    const snapshot = JSON.stringify(plain);
    maskModelIdentity(plain);
    expect(JSON.stringify(plain)).toBe(snapshot);
  });

  it("preserves deferred runs (no majority → no dissents) under masking", () => {
    const m = maskedCouncilTranscript(runInput({ result: result("deferred") }));
    expect(m.dissent).toEqual([]);
    expect(m.stages.map((s) => s.name)).toEqual(["vote:voter_1", "vote:voter_2", "vote:voter_3"]);
  });
});

describe("buildCouncilRunTranscript (shared run recorder)", () => {
  it("records route evidence, per-vote stages, dissent, and finalize metrics", () => {
    const t = buildCouncilRunTranscript(runInput());
    expect(t.protocol).toBe("council");
    expect(t.query).toContain("Should we ship the migration?");
    expect(t.confidence).toBeCloseTo(0.87, 5);
    expect(t.routing).toMatchObject({ mode: "explicit", tier: "council" });
    expect(t.routing.assigned_models).toEqual(["nexus/smart", "nexus/sonnet", "nexus/haiku"]);
    expect(t.stages.map((s) => s.name)).toEqual([
      "vote:nexus/smart",
      "vote:nexus/sonnet",
      "vote:nexus/haiku",
    ]);
    expect(t.dissent).toEqual(["nexus/haiku"]);
    expect(t.auditTrail[1]).toMatchObject({ step: "finalize", outcome: "approved" });
    expect(t.metrics.successful_model_calls).toBe(3);
    expect(t.degraded).toBe(false);
  });

  it("records no dissents when the outcome is deferred", () => {
    const t = buildCouncilRunTranscript(runInput({ result: result("deferred") }));
    expect(t.dissent).toEqual([]);
  });
});

describe("recordToolTranscript (shared tool recorder)", () => {
  it("maps debate output to per-answer stages plus a debate audit entry", () => {
    const t = recordToolTranscript(
      "debate__run",
      "X or Y?",
      {
        converged: true,
        roundsRun: 3,
        majority: { answer: "Y", count: 1 },
        finalAnswers: [
          { agent: "A", answer: "X" },
          { agent: "B", answer: "Y" },
        ],
      },
      1_700_000_000_000,
    );
    expect(t.protocol).toBe("debate__run");
    expect(t.stages.map((s) => s.name).sort()).toEqual(["answer:A", "answer:B"]);
    expect(t.auditTrail.some((e) => e.step === "debate" && e.converged === true)).toBe(true);
    expect(t.degraded).toBe(false);
  });

  it("leaves a degraded transcript with the error when the call failed", () => {
    const t = recordToolTranscript("debate__run", "X?", undefined, 1_700_000_000_000, "boom");
    expect(t.degraded).toBe(true);
    expect(t.auditTrail.some((e) => e.step === "error")).toBe(true);
    expect(JSON.stringify(t.warnings)).toContain("boom");
  });
});

describe("worker-shaped event payloads", () => {
  it("builds the council.transcript event with an optional signalId", () => {
    const t = buildCouncilRunTranscript(runInput());
    const ev = councilTranscriptEvent("sig-1", t);
    expect(ev).toEqual({
      level: "info",
      event: "council.transcript",
      signalId: "sig-1",
      transcript: t,
    });
    expect(JSON.parse(councilTranscriptJson(t))).toEqual(JSON.parse(JSON.stringify(t)));
  });

  it("builds the tool.transcript event with an optional taskId", () => {
    const t = recordToolTranscript("debate__run", "X?", { converged: false }, 1);
    const ev = toolTranscriptEvent("task-9", t);
    expect(ev).toMatchObject({ level: "info", event: "tool.transcript", taskId: "task-9" });
    expect(ev.transcript.protocol).toBe("debate__run");
    expect(toolTranscriptEvent(undefined, t).taskId).toBeUndefined();
  });
});
