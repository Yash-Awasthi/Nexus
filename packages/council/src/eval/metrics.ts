// SPDX-License-Identifier: Apache-2.0
/**
 * Vote statistics with intervals, because a rate without n is a rumour.
 *
 * Everything here is arithmetic over `ModelVote[]` plus a price table: how agreed a council was, how often
 * it could not decide, and what a verdict costs in tokens × price × rounds. The intervals are Wilson score
 * intervals rather than normal approximations — a convergence of 100% on five votes has a much wider honest
 * range than ±0, and the normal approximation would print 100% ± 0 and invite exactly the wrong conclusion.
 */

import type { ModelVote } from "@nexus/contracts";

export interface Proportion {
  /** Observed rate, 0–1. */
  rate: number;
  n: number;
  /** Wilson 95% interval. */
  lower: number;
  upper: number;
}

/** Wilson score interval for a binomial proportion. Returns 0..1 bounds even at 0/0. */
export function wilson(successes: number, n: number, z = 1.96): Proportion {
  if (n <= 0) return { rate: 0, n: 0, lower: 0, upper: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return {
    rate: round(p),
    n,
    lower: round(Math.max(0, centre - half)),
    upper: round(Math.min(1, centre + half)),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface VoteAgreement {
  yes: number;
  no: number;
  abstain: number;
  /** Share of decided votes on the winning side — 1 means unanimous, 0.5 means split. */
  convergence: number;
  /** 1 − convergence: how far the council was from one position. */
  disagreement: number;
  /** No side reached the majority threshold the engine uses (60%). */
  noMajority: boolean;
  /** The side with more weight, or `tie` when decided votes are equal. */
  majority: "yes" | "no" | "tie";
}

export const MAJORITY_THRESHOLD = 0.6;

export function voteAgreement(votes: readonly ModelVote[]): VoteAgreement {
  const yes = votes.filter((vote) => vote.vote === "yes").length;
  const no = votes.filter((vote) => vote.vote === "no").length;
  const abstain = votes.filter((vote) => vote.vote === "abstain").length;
  const decided = yes + no;
  const convergence = decided === 0 ? 0 : Math.max(yes, no) / decided;
  const majority = yes === no ? "tie" : yes > no ? "yes" : "no";
  return {
    yes,
    no,
    abstain,
    convergence: round(convergence),
    disagreement: round(1 - convergence),
    noMajority: decided === 0 || convergence < MAJORITY_THRESHOLD,
    majority,
  };
}

/** Price per million tokens, the unit providers publish. Two numbers per model, nothing else. */
export interface ModelPrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export interface VerdictCost {
  /** Mean cost of one finished verdict across the prompts measured. */
  meanUsd: number;
  /** Total across every run, so a regression in rounds or members shows up. */
  totalUsd: number;
  /** Mean prompt/completion tokens per verdict, which is what a reader tunes. */
  promptTokens: number;
  completionTokens: number;
}

/**
 * Cost of a verdict from measured usage and a published price.
 *
 * Rounds multiply the call count, not the tokens per call: a three-round protocol pays three times for the
 * same council, which is the number that decides whether a mode is worth offering.
 */
export function verdictCost(input: {
  promptTokens: number;
  completionTokens: number;
  /** Calls that produced the verdict: members × rounds. */
  calls: number;
  price: ModelPrice;
}): number {
  const perCall =
    (input.promptTokens / 1_000_000) * input.price.inputPerMillionUsd +
    (input.completionTokens / 1_000_000) * input.price.outputPerMillionUsd;
  return round(perCall * input.calls);
}
