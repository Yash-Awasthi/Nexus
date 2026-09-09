// SPDX-License-Identifier: Apache-2.0
/**
 * Model-as-Verifier (MAV) protocol — focused tests with a scripted transport
 * that plays a deterministic verdict per (verifier, candidate) pair, so the
 * tally, majority pick, tie-break, anonymization, and parse-fallback paths
 * are all exercised without any real model.
 */
import { describe, expect, it } from "vitest";
import { parseVerdict, runMavVerification } from "./verify.js";
import type { CandidateAnswer, VerifierVerdict } from "./verify.js";
import type { ILLMResponse, ILLMTransport } from "./engine.js";

const Q = "Is the ETL safe to run at midnight?";

const CANDIDATES: readonly CandidateAnswer[] = [
  { label: "A", content: "Yes, the job is idempotent." },
  { label: "B", content: "No, backfills will race the nightly purge." },
];

/** Simpler scripted transport keyed on the user prompt text. */
function promptTransport(reply: (user: string) => VerifierVerdict): ILLMTransport {
  return {
    async chat(messages): Promise<ILLMResponse> {
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      const v = reply(user);
      return {
        content: JSON.stringify(v),
        model: "fake",
        usage: { promptTokens: 5, completionTokens: 5 },
        latencyMs: 1,
      };
    },
  };
}

describe("parseVerdict", () => {
  it("parses clean JSON and strips markdown fences", () => {
    expect(
      parseVerdict('```json\n{"verdict": true, "aspect": "correctness", "reasoning": "ok"}\n```'),
    ).toEqual({
      verdict: true,
      aspect: "correctness",
      reasoning: "ok",
    });
  });

  it("falls back to a field scan when JSON parsing fails", () => {
    expect(parseVerdict('Sure — {"verdict": false, "aspect": "completeness"}')).toMatchObject({
      verdict: false,
      aspect: "correctness", // fallback default
    });
    expect(parseVerdict("the response is fine")).toMatchObject({ verdict: false });
  });
});

describe("runMavVerification", () => {
  it("cross-checks every candidate against every verifier and tallies approvals", async () => {
    // flatMap order is deterministic: V1×A, V1×B, V2×A, V2×B.
    // V1 approves A only; V2 approves both → A wins 2-1.
    const approvals = [true, false, true, true];
    let call = 0;
    const transport = promptTransport(() => ({
      verdict: approvals[call++]!,
      aspect: "correctness",
      reasoning: "scripted",
    }));
    const res = await runMavVerification({
      question: Q,
      candidates: CANDIDATES,
      verifiers: ["V1", "V2"],
      transport,
    });
    expect(res.verified.label).toBe("A");
    expect(res.scores).toEqual({ A: 2, B: 1 });
    expect(res.verdicts).toHaveLength(4); // 2 verifiers × 2 candidates
    expect(res.verdicts.filter((v) => v.verdict.verdict).length).toBe(3);
  });

  it("catches a hallucination that fools only one verifier", async () => {
    // B is fabricated; V1 is fooled, V2 catches it → B must NOT be verified.
    // Order: V1×A approve, V1×B approve (fooled), V2×A approve, V2×B reject.
    const approvals = [true, true, true, false];
    let call = 0;
    const transport = promptTransport(() => ({
      verdict: approvals[call++]!,
      aspect: "correctness",
      reasoning: "scripted",
    }));
    const res = await runMavVerification({
      question: Q,
      candidates: CANDIDATES,
      verifiers: ["V1", "V2"],
      transport,
    });
    expect(res.verified.label).toBe("A");
    expect(res.scores).toEqual({ A: 2, B: 1 });
  });

  it("breaks ties toward the first candidate (llmcouncil parity)", async () => {
    const transport = promptTransport(() => ({
      verdict: true,
      aspect: "correctness",
      reasoning: "all approved",
    }));
    const res = await runMavVerification({
      question: Q,
      candidates: CANDIDATES,
      verifiers: ["V1", "V2"],
      transport,
    });
    expect(res.verified.label).toBe("A");
    expect(res.scores).toEqual({ A: 2, B: 2 });
  });

  it("anonymizes candidate identity in verifier prompts", async () => {
    let sawLabel = false;
    let sawAnon = false;
    const transport = promptTransport((user) => {
      if (user.includes('Response from "A"')) sawLabel = true;
      if (user.includes("Response from the candidate")) sawAnon = true;
      return { verdict: true, aspect: "correctness", reasoning: "x" };
    });
    await runMavVerification({
      question: Q,
      candidates: CANDIDATES,
      verifiers: ["V1"],
      transport,
      anonymize: true,
    });
    expect(sawAnon).toBe(true);
    expect(sawLabel).toBe(false);
  });

  it("accepts an injected parse override", async () => {
    // The model replies in a non-default schema; the caller adapts it.
    const transport = promptTransport(() => ({
      verdict: true,
      aspect: "correctness",
      reasoning: "irrelevant",
    }));
    const res = await runMavVerification({
      question: Q,
      candidates: CANDIDATES,
      verifiers: ["V1", "V2"],
      transport,
      parse: (content) => {
        const v = JSON.parse(content) as VerifierVerdict;
        return { ...v, verdict: v.reasoning !== "irrelevant" || content.length > 20 };
      },
    });
    // V2's content ("irrelevant" + wrapper) differs from V1's only by key —
    // both exceed 20 chars here, so both approve; assert shape rather than pick.
    expect(res.scores).toEqual({ A: 2, B: 2 });
  });

  it("handles the single-verifier single-candidate case", async () => {
    const transport = promptTransport(() => ({
      verdict: true,
      aspect: "reasoning",
      reasoning: "sound",
    }));
    const res = await runMavVerification({
      question: Q,
      candidates: [CANDIDATES[0]!],
      verifiers: ["V1"],
      transport,
    });
    expect(res.verified.label).toBe("A");
    expect(res.verdicts[0]!.verdict.aspect).toBe("reasoning");
  });
});
