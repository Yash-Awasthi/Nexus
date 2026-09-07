// SPDX-License-Identifier: Apache-2.0
/**
 * Model-as-Verifier (MAV) — llmcouncil's verification protocol for
 * @nexus/council.
 *
 * Given a question and several candidate answers, N verifier models each
 * independently judge every candidate (the full candidates × verifiers
 * cross-product), returning a structured boolean verdict: is this response
 * correct, complete, and well reasoned? Each verifier vote is tallied per
 * candidate and the candidate with the most approving votes is the verified
 * answer. Distinct from {@link @nexus/best-of-n}: there the same judge scores
 * samples on a numeric scale; here many independent verifiers each make a
 * yes/no verification decision, so a hallucination that fools one judge can
 * still be caught by the others.
 *
 * The LLM transport is the same injected {@link ILLMTransport} the engine and
 * DeliberativeCouncil use, so nothing is provider-coupled and the protocol is
 * deterministic to test. Verdict parsing is injectable; the default expects
 * `{ "verdict": true, "aspect": "correctness", "reasoning": "…" }` JSON and
 * falls back to scanning for the verdict field when the model wraps or
 * truncates the JSON.
 */

import type { ILLMResponse, ILLMTransport } from "./engine.js";

/** A candidate answer awaiting verification. */
export interface CandidateAnswer {
  label: string;
  content: string;
}

/** One verifier's structured judgment of one candidate. */
export interface VerifierVerdict {
  verdict: boolean;
  /** What the verifier primarily evaluated (correctness, completeness, …). */
  aspect: string;
  reasoning: string;
}

export interface MavVerificationOptions {
  /** The question every candidate answers. */
  question: string;
  /** Candidate answers to cross-check. */
  candidates: readonly CandidateAnswer[];
  /** Verifier labels — one model call per verifier per candidate. */
  verifiers: readonly string[];
  /** Injected LLM transport used for every verifier call. */
  transport: ILLMTransport;
  /**
   * Render candidate answers without their labels in the prompt. Default
   * false. (The label is always used to tally scores regardless.)
   */
  anonymize?: boolean;
  /**
   * Verdict parser override. Defaults to {@link parseVerdict} (JSON with a
   * field-scan fallback). Injectable so callers can use their own schemas.
   */
  parse?: (content: string) => VerifierVerdict;
}

/** Verdict of every verifier on every candidate, plus the tallies. */
export interface MavVerificationResult {
  /** The candidate with the most approving verifier votes (first on ties). */
  verified: CandidateAnswer;
  /** label → number of approving verifier votes. */
  scores: Record<string, number>;
  /** One entry per candidates × verifiers call, for inspectability. */
  verdicts: {
    candidate: string;
    verifier: string;
    verdict: VerifierVerdict;
  }[];
}

/** The verifier system prompt — independent judge, not advocate. */
const VERIFIER_SYSTEM = `You are a verification agent. Evaluate whether a response correctly answers a question. You are one of several independent verifiers: give your own honest judgment, do not assume the response is correct, and look for factual errors, gaps, and weak reasoning.`;

/** Wrap the candidate for the verifier, optionally anonymized. */
function verificationPrompt(
  question: string,
  candidate: CandidateAnswer,
  anonymize: boolean,
): string {
  const who = anonymize ? "the candidate" : `"${candidate.label}"`;
  return [
    `Question:\n${question}`,
    ``,
    `Response from ${who}:`,
    candidate.content,
    ``,
    `Is this response correct, complete, and well reasoned? Reply with ONLY valid JSON (no markdown fences):`,
    `{ "verdict": true, "aspect": "correctness", "reasoning": "..." }`,
    ``,
    `Set "verdict" to true if the response is substantially correct, false otherwise. The "aspect" field should name what you primarily evaluated (e.g. "correctness", "completeness", "reasoning"). The "reasoning" field should explain your judgment.`,
  ].join("\n");
}

/**
 * Default verdict parser: JSON with markdown fences stripped, then a
 * field-scan fallback for wrapped or truncated output (llmcouncil parity).
 */
export function parseVerdict(content: string): VerifierVerdict {
  try {
    const cleaned = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned) as Partial<VerifierVerdict>;
    if (typeof parsed.verdict === "boolean") {
      return {
        verdict: parsed.verdict,
        aspect: typeof parsed.aspect === "string" ? parsed.aspect : "correctness",
        reasoning:
          typeof parsed.reasoning === "string" ? parsed.reasoning : "(no reasoning given)",
      };
    }
  } catch {
    // fall through to the scan
  }
  const lower = content.toLowerCase();
  return {
    verdict: lower.includes('"verdict": true') || lower.includes('"verdict":true'),
    aspect: "correctness",
    reasoning: `Parse fallback: ${content.slice(0, 200)}`,
  };
}

/**
 * Run the MAV protocol: every verifier judges every candidate in parallel,
 * approving votes are tallied per candidate, and the highest-scoring candidate
 * is the verified answer (first candidate wins ties, llmcouncil parity).
 */
export async function runMavVerification(
  opts: MavVerificationOptions,
): Promise<MavVerificationResult> {
  const { question, candidates, verifiers, transport, anonymize = false } = opts;
  const parse = opts.parse ?? parseVerdict;
  const responses: ILLMResponse[] = await Promise.all(
    verifiers.flatMap((verifier) =>
      candidates.map((candidate) =>
        transport.chat(
          [
            { role: "system", content: VERIFIER_SYSTEM },
            {
              role: "user",
              content: verificationPrompt(question, candidate, anonymize),
            },
          ],
          { temperature: 0.2, maxTokens: 512 },
        ),
      ),
    ),
  );

  const scores: Record<string, number> = Object.fromEntries(
    candidates.map((c) => [c.label, 0]),
  );
  const verdicts: MavVerificationResult["verdicts"] = [];
  let i = 0;
  for (const verifier of verifiers) {
    for (const candidate of candidates) {
      const verdict = parse(responses[i]!.content);
      i++;
      verdicts.push({ candidate: candidate.label, verifier, verdict });
      if (verdict.verdict) scores[candidate.label] = (scores[candidate.label] ?? 0) + 1;
    }
  }

  let best: CandidateAnswer = candidates[0]!;
  for (const candidate of candidates) {
    if ((scores[candidate.label] ?? 0) > (scores[best.label] ?? 0)) best = candidate;
  }
  return { verified: best, scores, verdicts };
}