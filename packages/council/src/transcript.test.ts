// SPDX-License-Identifier: Apache-2.0
// Inspectable transcript artifact (Weiping Council parity, row 128 — pass 58):
// createTranscript/recordStage/appendAudit/recordRouting build the run record;
// finalizeTranscript computes the OR-of-five degraded verdict with faithful
// warning strings, confidence clamping + failure-ratio capping, and metrics.
import { describe, it, expect } from "vitest";
import {
  createTranscript,
  recordStage,
  appendAudit,
  recordRouting,
  finalizeTranscript,
  transcriptToJson,
  type CouncilTranscript,
} from "./index.js";

function base(): CouncilTranscript {
  return createTranscript({
    id: "run-1",
    query: "Should we ship?",
    protocol: "council",
    createdAt: "2026-01-01T00:00:00Z",
  });
}

describe("transcript construction", () => {
  it("initializes every artifact field", () => {
    const t = base();
    expect(t.id).toBe("run-1");
    expect(t.query).toBe("Should we ship?");
    expect(t.protocol).toBe("council");
    expect(t.stages).toEqual([]);
    expect(t.finalAnswer).toBe("");
    expect(t.confidence).toBe(0);
    expect(t.dissent).toEqual([]);
    expect(t.auditTrail).toEqual([]);
    expect(t.routing).toEqual({});
    expect(t.metrics).toEqual({});
    expect(t.providerHealth).toEqual([]);
    expect(t.modelCallTraces).toEqual([]);
    expect(t.degraded).toBe(false);
    expect(t.warnings).toEqual([]);
  });

  it("recordStage and appendAudit accumulate in order", () => {
    const t = base();
    recordStage(t, { name: "Round 1", speaker: "acme-70b" });
    recordStage(t, { name: "Round 2", speaker: "globex-8b" });
    appendAudit(t, "route", { tier: "standard" });
    appendAudit(t, "finalize");
    expect(t.stages.map((s) => s.name)).toEqual(["Round 1", "Round 2"]);
    expect(t.auditTrail).toEqual([{ step: "route", tier: "standard" }, { step: "finalize" }]);
  });

  it("recordRouting stores route evidence and prepends the routing audit entry", () => {
    const t = base();
    recordRouting(t, {
      mode: "auto",
      selected_protocol: "council",
      tier: "full_council",
      reason: "complex",
    });
    appendAudit(t, "decompose", { subtask_count: 3 });
    expect(t.routing).toMatchObject({ mode: "auto", tier: "full_council" });
    expect(t.auditTrail[0]).toMatchObject({ step: "routing", reason: "complex" });
    expect(t.auditTrail[1]).toMatchObject({ step: "decompose" });
  });
});

describe("finalizeTranscript degradation semantics", () => {
  it("clean run: not degraded, call metrics tallied, no warnings", () => {
    const t = base();
    t.confidence = 0.8;
    finalizeTranscript(t, {
      startedAt: Date.now() - 1500,
      modelCallTraces: [
        { model: "a", role: "reviewer" },
        { model: "b", role: "chairman" },
      ],
    });
    expect(t.degraded).toBe(false);
    expect(t.warnings).toEqual([]);
    expect(t.metrics.successful_model_calls).toBe(2);
    expect(t.metrics.failed_model_calls).toBe(0);
    expect(t.metrics.total_ms).toBeGreaterThanOrEqual(1490);
  });

  it("provider not ready → degraded with the faithful warning", () => {
    const t = base();
    finalizeTranscript(t, { providerHealth: [{ id: "openai", ready: false }] });
    expect(t.degraded).toBe(true);
    expect(t.warnings).toContain(
      "One or more providers are not ready; check environment configuration.",
    );
  });

  it("trace errors → degraded, failure counts, confidence capped at success ratio", () => {
    const t = base();
    t.confidence = 0.9;
    finalizeTranscript(t, {
      modelCallTraces: [{ model: "a" }, { model: "b", error_kind: "rate_limit" }],
    });
    expect(t.degraded).toBe(true);
    expect(t.warnings).toContain("One or more model calls returned an error or degraded response.");
    expect(t.metrics.successful_model_calls).toBe(1);
    expect(t.metrics.failed_model_calls).toBe(1);
    expect(t.confidence).toBe(0.5); // min(0.9, 1/2)
  });

  it("context warnings degrade the run (agentmemory/context match)", () => {
    const t = base();
    finalizeTranscript(t, { warnings: ["agentmemory recall failed"] });
    expect(t.degraded).toBe(true);
    expect(t.warnings).toContain("Context recall is unavailable or degraded for this run.");
  });

  it("invalid confidence is clamped AND flagged, then warning-capped", () => {
    const high = base();
    high.confidence = 1.5;
    finalizeTranscript(high, {});
    expect(high.confidence).toBe(1);
    expect(high.degraded).toBe(true);
    expect(high.warnings).toContain("Model-reported confidence was invalid and has been clamped.");

    const nan = base();
    nan.confidence = Number.NaN;
    finalizeTranscript(nan, {});
    expect(nan.confidence).toBe(0);
    expect(nan.degraded).toBe(true);

    const valid = base();
    valid.confidence = 0.42;
    finalizeTranscript(valid, {});
    expect(valid.confidence).toBe(0.42);
    expect(valid.degraded).toBe(false);
  });

  it("protocol degradation propagates through the OR", () => {
    const t = base();
    finalizeTranscript(t, { protocolDegraded: true, warnings: ["sub-task failed"] });
    expect(t.degraded).toBe(true);
  });

  it("warnings are deduped and sorted at finalization", () => {
    const t = base();
    finalizeTranscript(t, {
      warnings: ["zeta issue", "alpha issue", "zeta issue"],
      providerHealth: [{ id: "x", ready: false }],
    });
    expect(t.warnings).toEqual([
      "One or more providers are not ready; check environment configuration.",
      "alpha issue",
      "zeta issue",
    ]);
  });
});

describe("serialization", () => {
  it("transcriptToJson round-trips every field", () => {
    const t = base();
    recordRouting(t, { mode: "auto" });
    recordStage(t, { name: "Round 1" });
    t.finalAnswer = "yes";
    t.confidence = 0.9;
    finalizeTranscript(t, { modelCallTraces: [{ model: "a" }] });
    const parsed = JSON.parse(transcriptToJson(t)) as CouncilTranscript;
    expect(parsed.id).toBe("run-1");
    expect(parsed.stages[0]!.name).toBe("Round 1");
    expect(parsed.routing).toEqual({ mode: "auto" });
    expect(parsed.finalAnswer).toBe("yes");
    expect(parsed.degraded).toBe(false);
    expect(parsed.metrics.successful_model_calls).toBe(1);
  });
});
