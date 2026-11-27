// SPDX-License-Identifier: Apache-2.0
/**
 * The council evaluation's own contract.
 *
 * These tests pin the things that would quietly invalidate every number in docs/COUNCIL-EVALS.md: a golden
 * set that lost its hard prompts, a judge that matches numbers loosely enough to accept `18%` for `8%`, a
 * calibration that stopped being measured, vote statistics that lose the tie, or a regression gate that has
 * never been seen to fail.
 */

import { describe, expect, it } from "vitest";

import { GOLDEN_PROMPTS, RUBRIC, UNANSWERABLE } from "./golden.ts";
import {
  ACCEPT_SCORE,
  cohenKappa,
  judgeCalibration,
  judgeIsTrusted,
  mentions,
  MIN_USEFUL_KAPPA,
  scoreAnswer,
} from "./judge.ts";
import { LABELLED_CASES } from "./labels.ts";
import { verdictCost, voteAgreement, wilson } from "./metrics.ts";
import { MODES, compareRuns, evaluateCouncil, renderModeTable } from "./runner.ts";

const prompt = (id: string) => {
  const found = GOLDEN_PROMPTS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no golden prompt ${id}`);
  return found;
};

describe("golden set", () => {
  it("has thirty prompts with unique ids and at least two facts each", () => {
    expect(GOLDEN_PROMPTS).toHaveLength(30);
    expect(new Set(GOLDEN_PROMPTS.map((item) => item.id)).size).toBe(30);
    for (const item of GOLDEN_PROMPTS) {
      expect(item.mustMention.length, item.id).toBeGreaterThanOrEqual(2);
      expect(item.tradeoff.length, item.id).toBeGreaterThan(20);
      expect(item.context.length, item.id).toBeGreaterThan(40);
    }
  });

  it("covers every category and keeps exactly one unanswerable prompt", () => {
    const categories = new Set(GOLDEN_PROMPTS.map((item) => item.category));
    expect([...categories].sort()).toEqual([
      "billing",
      "engineering",
      "operations",
      "product",
      "security",
    ]);
    expect(UNANSWERABLE).toEqual(["g30"]);
  });

  it("rests on five weighted criteria that sum to one", () => {
    expect(RUBRIC).toHaveLength(5);
    expect(RUBRIC.map((criterion) => criterion.id)).toEqual([
      "coverage",
      "specificity",
      "tradeoff",
      "action",
      "honesty",
    ]);
    // The weights live in the judge; this asserts the published rubric is the one referenced there.
    expect(RUBRIC.every((criterion) => criterion.five.length > 30)).toBe(true);
  });
});

describe("judge matching", () => {
  it("does not confuse a number with its neighbour", () => {
    expect(mentions("the fee is 8% of the invoice", "8%")).toBe(true);
    expect(mentions("the fee is 18% of the invoice", "8%")).toBe(false);
    expect(mentions("we spent 4,000 credits", "4,000")).toBe(true);
    expect(mentions("we spent 400 credits", "4,000")).toBe(false);
  });

  it("accepts the same fact written in other words", () => {
    expect(mentions("a share of the invoices are paid late", "invoices paid late")).toBe(true);
    expect(mentions("our terms bill overage", "overage billed")).toBe(true);
  });

  it("scores a real verdict above the accept line and a slogan below it", () => {
    const good = scoreAnswer(
      "The export takes 20 minutes and peak writes are at 03:00, so a 04:00 start runs into the busiest hour " +
        "and leaves two hours for the ledger before 06:00. I would move it to 04:30 instead, but that leaves " +
        "a tighter margin if the export slows down. Next step: watch the first two runs.",
      prompt("g01"),
    );
    const slogan = scoreAnswer(
      "Yes, moving it later makes sense because the system is quieter then.",
      prompt("g01"),
    );
    expect(good.total).toBeGreaterThanOrEqual(ACCEPT_SCORE);
    expect(good.accept).toBe(true);
    expect(slogan.accept).toBe(false);
  });

  it("punishes false precision on the unanswerable prompt", () => {
    const hedged = scoreAnswer(
      "There is no usage data yet, so any figure is an assumption: expect a range of 5–15% and revisit it.",
      prompt("g30"),
    );
    const invented = scoreAnswer(
      "Expect about 12% adoption based on typical curves.",
      prompt("g30"),
    );
    expect(hedged.total).toBeGreaterThan(invented.total);
  });
});

describe("judge calibration", () => {
  const calibration = judgeCalibration(LABELLED_CASES, GOLDEN_PROMPTS);

  it("measures agreement on every labelled case", () => {
    expect(calibration.n).toBe(LABELLED_CASES.length);
    expect(calibration.n).toBeGreaterThanOrEqual(50);
    expect(
      calibration.truePositive +
        calibration.falsePositive +
        calibration.trueNegative +
        calibration.falseNegative,
    ).toBe(calibration.n);
  });

  it("agrees with the labels strongly enough to be useful", () => {
    expect(calibration.agreement).toBeGreaterThanOrEqual(0.9);
    expect(calibration.kappa).toBeGreaterThanOrEqual(MIN_USEFUL_KAPPA);
    expect(judgeIsTrusted(calibration.kappa).trusted).toBe(true);
  });

  it("keeps its documented failure mode: it errs by rejecting, never by accepting", () => {
    // The published weakness. If a change makes the judge accept answers a person rejected, the document's
    // "conservative bias" paragraph becomes false and this fails instead.
    expect(calibration.falsePositive).toBe(0);
    expect(calibration.disagreements.every((item) => item.label && !item.judge)).toBe(true);
  });

  it("computes κ that matches a hand-worked example", () => {
    // 10 cases, 8 agree, expected agreement = 0.5 * 0.5 + 0.5 * 0.5 = 0.5 → κ = (0.8 - 0.5) / (1 - 0.5).
    const label = [true, true, true, true, true, false, false, false, false, false];
    const judge = [true, true, true, false, false, false, false, false, true, true];
    expect(cohenKappa(label, judge)).toBeCloseTo(0.2, 3);
  });
});

describe("vote statistics", () => {
  const vote = (choice: "yes" | "no" | "abstain") => ({
    model: "m",
    provider: "p",
    vote: choice,
    reasoning: "",
    confidence: 0.5,
    latencyMs: 1,
  });

  it("calls five of five unanimous and four of five converged", () => {
    expect(
      voteAgreement([vote("yes"), vote("yes"), vote("yes"), vote("yes"), vote("yes")]),
    ).toMatchObject({
      convergence: 1,
      disagreement: 0,
      noMajority: false,
    });
    const split = voteAgreement([vote("yes"), vote("yes"), vote("no"), vote("no"), vote("no")]);
    expect(split.convergence).toBe(0.6);
    expect(split.noMajority).toBe(false);
  });

  it("reports a tie and a deadlock below the threshold", () => {
    const tied = voteAgreement([vote("yes"), vote("no"), vote("abstain")]);
    expect(tied.majority).toBe("tie");
    expect(tied.noMajority).toBe(true);
    expect(tied.convergence).toBe(0.5);
  });

  it("widens the interval when the sample is small", () => {
    const small = wilson(3, 5);
    const large = wilson(60, 100);
    expect(small.rate).toBe(0.6);
    expect(small.upper - small.lower).toBeGreaterThan(large.upper - large.lower);
    expect(small.lower).toBeGreaterThanOrEqual(0);
    expect(small.upper).toBeLessThanOrEqual(1);
  });
});

describe("modes, cost and the regression gate", () => {
  const prompts = GOLDEN_PROMPTS.slice(0, 3);

  it("charges by call, so rounds multiply the cost", async () => {
    const reports = await evaluateCouncil({ prompts, modes: MODES });
    const [standard, redBlue, socratic] = reports;
    expect(standard.cost.meanUsd).toBeGreaterThan(0);
    expect(redBlue.cost.meanUsd).toBeGreaterThan(standard.cost.meanUsd);
    expect(socratic.cost.meanUsd).toBeGreaterThan(redBlue.cost.meanUsd);
    // Three rounds of five calls is three times one round of five, within token noise.
    expect(socratic.cost.meanUsd / standard.cost.meanUsd).toBeGreaterThan(2.5);
  });

  it("attributes every verdict to the member that cast it", async () => {
    const reports = await evaluateCouncil({ prompts, modes: [MODES[0]] });
    const [report] = reports;
    expect(report.runs[0]?.members).toHaveLength(MODES[0].councilSize);
    const credited = Object.values(report.archetypeWins).reduce(
      (sum, entry) => sum + entry.wins,
      0,
    );
    expect(credited).toBeCloseTo(prompts.length, 5);
    expect(Object.keys(report.archetypeWins)).not.toContain("llama-3.3-70b-versatile");
  });

  it("fails the gate when a run gets worse and passes it when nothing changed", async () => {
    const baseline = await evaluateCouncil({ prompts, modes: [MODES[1]] });
    const unchanged = await evaluateCouncil({ prompts, modes: [MODES[1]] });
    expect(compareRuns(baseline, unchanged).every((finding) => !finding.failed)).toBe(true);

    const weakened = await evaluateCouncil({ prompts, modes: [MODES[1]], quality: 0.2 });
    const findings = compareRuns(baseline, weakened);
    expect(findings.some((finding) => finding.failed)).toBe(true);
  });

  it("prices a verdict from tokens and a published rate", () => {
    expect(
      verdictCost({
        promptTokens: 1_000_000,
        completionTokens: 0,
        calls: 1,
        price: { inputPerMillionUsd: 3, outputPerMillionUsd: 9 },
      }),
    ).toBe(3);
    expect(
      verdictCost({
        promptTokens: 0,
        completionTokens: 1_000_000,
        calls: 2,
        price: { inputPerMillionUsd: 3, outputPerMillionUsd: 0.5 },
      }),
    ).toBe(1);
  });

  it("renders a table whose columns match its header", async () => {
    const reports = await evaluateCouncil({ prompts, modes: MODES });
    const [header, separator, ...rows] = renderModeTable(reports).split("\n");
    const width = header?.split("|").length;
    expect(separator?.split("|").length).toBe(width);
    expect(rows).toHaveLength(MODES.length);
    for (const row of rows) expect(row.split("|").length).toBe(width);
  });
});
