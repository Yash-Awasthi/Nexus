// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { classifyPrompt, calibrateConfidence } from "./prompt-tier.js";

describe("classifyPrompt (ported from llm-switchboard)", () => {
  it("forces REASONING when the user prompt carries 2+ reasoning markers", () => {
    const r = classifyPrompt("prove the theorem and derive the result step by step");
    expect(r.tier).toBe("REASONING");
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("never lets the system prompt trigger the reasoning override", () => {
    const r = classifyPrompt("hello there", {
      systemPrompt: "think step by step and prove every answer formally",
    });
    expect(r.tier).not.toBe("REASONING");
    expect(r.tier).toBe("SIMPLE");
  });

  it("scores agentic prompts at 1.0 and plain text at 0", () => {
    const agentic = classifyPrompt(
      "read file src/main.ts, edit it, npm install, then deploy and debug until it works, verify once done",
    );
    expect(agentic.agenticScore).toBe(1.0);

    const light = classifyPrompt("please fix the bug in this function");
    expect(light.agenticScore).toBe(0.2);

    const plain = classifyPrompt("what is the capital of france");
    expect(plain.agenticScore).toBe(0);
  });

  it("classifies a simple factual question as SIMPLE", () => {
    const r = classifyPrompt("what is the capital of france", { estimatedTokens: 10 });
    expect(r.tier).toBe("SIMPLE");
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("routes long technical prompts into the COMPLEX band (or ambiguous-with-high-score)", () => {
    const r = classifyPrompt(
      "build a distributed kubernetes microservice: design the architecture, " +
        "optimize the database schema, implement an async import function, " +
        "compile and deploy it, keep it under budget, output json, step 1 then step 2",
      { estimatedTokens: 900 },
    );
    // Score 0.3–0.5 lands in the COMPLEX band; confidence below threshold is
    // reported honestly as null (ambiguous), which the router resolves via
    // ambiguousDefaultTier — matching llm-switchboard semantics.
    expect(r.score).toBeGreaterThanOrEqual(0.3);
    expect(r.score).toBeLessThan(0.5);
    expect(["COMPLEX", null]).toContain(r.tier);
    expect(r.agenticScore).toBe(1.0);
  });

  it("calibrates confidence via sigmoid", () => {
    expect(calibrateConfidence(0, 12)).toBeCloseTo(0.5, 5);
    expect(calibrateConfidence(1, 12)).toBeCloseTo(0.9999939, 5);
    expect(calibrateConfidence(-1, 12)).toBeCloseTo(0.0000061, 5);
  });

  it("scores longer prompts above shorter ones (token dimension)", () => {
    const t = "explain the difference between two approaches";
    const short = classifyPrompt(t, { estimatedTokens: 5 });
    const long = classifyPrompt(t, { estimatedTokens: 900 });
    expect(long.score).toBeGreaterThan(short.score);
  });
});
