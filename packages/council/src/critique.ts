// SPDX-License-Identifier: Apache-2.0
/**
 * Peer critique + red-team critique — llmcouncil's critique protocol for
 * @nexus/council.
 *
 * {@link DeliberativeCouncil.review} asks each advisor to triage ALL responses
 * (strongest / biggest blind spot / missed-by-all). This protocol is the other
 * critique shape: every critic writes structured feedback about EVERY OTHER
 * response (never its own), in one of two framings —
 *
 *   critique — critical reviewer: per response, Strengths, Weaknesses, Errors,
 *              and a 0-100 Confidence in its correctness.
 *   redteam  — red-team adversary: per response, Flaws, Edge Cases, Adversarial
 *              Inputs, and Failure Modes. "Be aggressive and creative."
 *
 * The critic sees the anonymized or labeled responses of everyone else. Output
 * is per-critic text (llmcouncil parity — the raw critique is what a
 * downstream revision round feeds back to the authors), carried through the
 * same injected {@link ILLMTransport} as every other council protocol, so the
 * module is provider-agnostic and deterministic to test.
 */

import type { ILLMResponse, ILLMTransport } from "./engine.js";

/** A response (or candidate) eligible for critique. */
export interface CritiqueTarget {
  label: string;
  content: string;
}

/** One critic's structured critique of everyone else's responses. */
export interface Critique {
  critic: string;
  content: string;
}

export interface CritiqueOptions {
  question: string;
  /** The responses being critiqued (the critic's own is excluded). */
  targets: readonly CritiqueTarget[];
  /** Critic labels — one model call per critic. */
  critics: readonly string[];
  /** Injected LLM transport used for every critique call. */
  transport: ILLMTransport;
  /**
   * "critique" (critical reviewer: strengths/weaknesses/errors/confidence) or
   * "redteam" (adversary: flaws/edge cases/adversarial inputs/failure modes).
   */
  mode?: "critique" | "redteam";
  /** Hide target labels in the prompt. Default false. */
  anonymize?: boolean;
}

export interface CritiqueResult {
  question: string;
  mode: "critique" | "redteam";
  /** One structured-feedback blob per critic. */
  critiques: Critique[];
}

/** Headings the reviewer framing asks each target to be judged under. */
const REVIEWER_BODY = `For each response, provide structured feedback:
* **Strengths**: What the response does well
* **Weaknesses**: Where it falls short
* **Errors**: Any factual or logical errors
* **Confidence**: Your confidence in the response's correctness (0-100%)

Be thorough and specific.`;

/** Headings the adversarial framing asks each target to be judged under. */
const ADVERSARY_BODY = `For each response, identify:
* **Flaws**: Logical errors, unsupported claims, or incorrect reasoning
* **Edge Cases**: Scenarios where the response would fail or produce wrong results
* **Adversarial Inputs**: Inputs that could exploit weaknesses in the approach
* **Failure Modes**: How and when the response would break down

Be aggressive and creative in finding problems.`;

function promptFor(
  question: string,
  targets: readonly CritiqueTarget[],
  mode: "critique" | "redteam",
  anonymize: boolean,
): string {
  const list = targets
    .map((t) => {
      const name = anonymize ? "an anonymous response" : `"${t.label}"`;
      return `### ${name}\n${t.content}`;
    })
    .join("\n\n");
  const system =
    mode === "redteam"
      ? "You are a red team adversary. Your job is to stress test the following responses by finding flaws, edge cases, adversarial inputs, or failure modes."
      : "You are a critical reviewer. Evaluate each of the following responses to the question below.";
  const body = mode === "redteam" ? ADVERSARY_BODY : REVIEWER_BODY;
  return `${system}\n\n**Question:** ${question}\n\n**Responses:**\n\n${list}\n\n${body}`;
}

/**
 * Run the peer-critique / red-team protocol: each critic critiques every
 * target except its own response, in the chosen framing. A critic with no
 * visible targets (single-target run) is skipped — there is nothing to
 * critique.
 */
export async function runCritique(opts: CritiqueOptions): Promise<CritiqueResult> {
  const { question, targets, critics, transport, mode = "critique", anonymize = false } = opts;
  const responses: ILLMResponse[] = await Promise.all(
    critics.map((critic) => {
      const others = targets.filter((t) => t.label !== critic);
      if (others.length === 0) {
        return Promise.resolve({
          content: "",
          model: "skipped",
          usage: { promptTokens: 0, completionTokens: 0 },
          latencyMs: 0,
        });
      }
      return transport.chat(
        [
          {
            role: "system",
            content: "Council critique protocol. Follow the user's instructions exactly.",
          },
          { role: "user", content: promptFor(question, others, mode, anonymize) },
        ],
        { temperature: 0.4, maxTokens: 1024 },
      );
    }),
  );

  const critiques: Critique[] = [];
  critics.forEach((critic, i) => {
    const content = responses[i]!.content;
    if (content.length > 0) critiques.push({ critic, content });
  });

  return { question, mode, critiques };
}
