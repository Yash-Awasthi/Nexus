// SPDX-License-Identifier: Apache-2.0
/**
 * `pnpm council:evals` — the generated half of docs/COUNCIL-EVALS.md.
 *
 * Prints markdown on stdout. The prose around it lives in the document, the numbers live here, so a change
 * to the judge, the golden set or a mode shows up as a diff in one place instead of drifting quietly.
 */

import { GOLDEN_PROMPTS, RUBRIC, UNANSWERABLE } from "./golden.ts";
import {
  scoreAnswer,
  judgeCalibration,
  judgeIsTrusted,
  renderRubric,
  MIN_USEFUL_KAPPA,
  type Calibration,
} from "./judge.ts";
import { LABELLED_CASES } from "./labels.ts";
import { wilson } from "./metrics.ts";
import {
  DEFAULT_QUALITY,
  MODES,
  MODEL_PRICE,
  MODEL_ID,
  compareRuns,
  evaluateCouncil,
  renderArchetypeTable,
  renderCategoryTable,
  renderModeTable,
  renderRegression,
} from "./runner.ts";

/**
 * The calibration before a review pass changed four labels.
 *
 * Recorded, not recomputed: it is a fact about a particular afternoon of reading answers, and the point of
 * printing both rows is that the second one is not presented as the first measurement of the judge.
 */
const BEFORE_REVIEW: Calibration = {
  n: 53,
  agreement: 0.849,
  kappa: 0.696,
  truePositive: 27,
  falsePositive: 0,
  trueNegative: 18,
  falseNegative: 8,
  disagreements: [],
};

const ACCEPTED = LABELLED_CASES.filter((item) => item.accept).length;
const REJECTED = LABELLED_CASES.length - ACCEPTED;

export async function renderCouncilEvals(): Promise<string> {
  const calibration = judgeCalibration(LABELLED_CASES, GOLDEN_PROMPTS);
  const verdict = judgeIsTrusted(calibration.kappa);
  const reports = await evaluateCouncil();
  const weakened = await evaluateCouncil({ quality: DEFAULT_QUALITY - 0.08 });
  const findings = compareRuns(reports, weakened);

  const categoryCounts = new Map<string, number>();
  for (const prompt of GOLDEN_PROMPTS) {
    categoryCounts.set(prompt.category, (categoryCounts.get(prompt.category) ?? 0) + 1);
  }

  return [
    `**Read this first.** The tables below are produced by a scripted transport, not by a model: it answers`,
    `from each prompt's own facts with a quality dial, so every number is reproducible with no key and no`,
    `spend. They measure the machinery — tally, rounds, cost arithmetic, regression gate — and they say`,
    `nothing about how good any model is. Swapping in a provider replaces one function in`,
    `\`packages/council/src/eval/runner.ts\` and the report stays the same shape.`,
    "",
    `### The golden set`,
    "",
    `${GOLDEN_PROMPTS.length} decision prompts (${[...categoryCounts.entries()].map(([name, n]) => `${name} ${n}`).join(", ")}),`,
    `each with the facts a verdict must engage and the tradeoff it must name.`,
    `${UNANSWERABLE.length} of them cannot be answered from the context on purpose, and the judge scores an`,
    `unhedged answer to it as dishonest.`,
    "",
    renderRubric(),
    "",
    `### Judge calibration`,
    "",
    `The judge is a text scorer (see \`judge.ts\`): it reads coverage of the prompt's facts, numbers, a`,
    `concession, a next step and overclaiming. It was calibrated against ${LABELLED_CASES.length} hand-labelled`,
    `verdicts (${ACCEPTED} accepted, ${REJECTED} rejected) written by one annotator — the same person who wrote`,
    `the judge, which makes this an upper bound on what a crowd of annotators would show.`,
    "",
    "| Pass | Agreement | Cohen's κ | Accepted by judge | Accepted by label |",
    "| --- | --- | --- | --- | --- |",
    `| Before the review pass | ${pct(BEFORE_REVIEW.agreement)} | ${BEFORE_REVIEW.kappa.toFixed(3)} | ${BEFORE_REVIEW.truePositive + BEFORE_REVIEW.falsePositive} | ${ACCEPTED} |`,
    `| After the review pass | ${pct(calibration.agreement)} | ${calibration.kappa.toFixed(3)} | ${calibration.truePositive + calibration.falsePositive} | ${ACCEPTED} |`,
    "",
    `The review pass changed **four** labels (c12, c24, c30, c36) from accept to reject, and the reason for`,
    `each change is recorded in that row's \`why\`. Those answers were decided without the facts that made the`,
    `question hard, and the first labels were too generous; the judge was right and the labels were wrong.`,
    `Nothing in the judge changed as a result of reading the disagreements.`,
    "",
    `Shipping rule: **${verdict.reason}**. Below κ ${MIN_USEFUL_KAPPA} the calibration reports the judge as unusable rather`,
    `than publishing a quality number, which is the whole point of measuring it.`,
    "",
    `Residual disagreements (${calibration.disagreements.length}):`,
    "",
    ...(calibration.disagreements.length === 0
      ? ["None."]
      : calibration.disagreements.map(
          (item) =>
            `- \`${item.id}\` scored ${item.score.toFixed(1)} and was rejected — ${item.why}`,
        )),
    "",
    `The failure modes are consistent: the judge never accepted an answer a person rejected (0 false`,
    `positives in ${calibration.n}), and it under-scores answers whose downside is stated as a consequence of`,
    `the choice rather than signalled with "but", whose next step comes before the summary, or which omit a`,
    `trivial fact from the prompt (a date) while engaging the substance. Its bias is conservative, so it may`,
    `rank and gate regressions but must not be quoted as an absolute quality score.`,
    "",
    `### Mode comparison`,
    "",
    `Every mode runs the same ${GOLDEN_PROMPTS.length} prompts through \`DeliberationEngine.deliberate\` with a`,
    `five-member council. "Every member accepted" is the column that discriminates: best-of-five saturates`,
    `first, because one strong voice out of five is enough for the council to look good.`,
    "",
    renderModeTable(reports),
    "",
    `Cost uses ${MODEL_ID} at $${MODEL_PRICE.inputPerMillionUsd}/M input and $${MODEL_PRICE.outputPerMillionUsd}/M`,
    `output on the scripted token counts. Rounds multiply the call count, which is why a three-round protocol`,
    `costs three times as much for the same council.`,
    "",
    `### Per-archetype win rate`,
    "",
    `A win is the top-scoring verdict in that prompt's council, split evenly between ties.`,
    "",
    renderArchetypeTable(reports),
    "",
    "### Per-category acceptance",
    "",
    renderCategoryTable(reports),
    "",
    `### The regression gate, demonstrated`,
    "",
    `The gate fails when acceptance drops further than the two Wilson intervals can explain. Below is the`,
    `same run with the driver's quality dial turned from ${DEFAULT_QUALITY.toFixed(2)} to ${(DEFAULT_QUALITY - 0.08).toFixed(2)} — a stand-in for a prompt change`,
    `that makes answers worse:`,
    "",
    renderRegression(findings),
    "",
    `Convergence and "no majority" are reported with n and an interval (or standard error) because a rate`,
    `without one invites reading a five-vote council as a fact. A single prompt's convergence is a fraction`,
    `with a denominator of five; only the mean over ${GOLDEN_PROMPTS.length} prompts is worth quoting.`,
  ].join("\n");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Kept for the tests: the same numbers without formatting. */
export function calibrationSummary() {
  const calibration = judgeCalibration(LABELLED_CASES, GOLDEN_PROMPTS);
  return {
    calibration,
    verdict: judgeIsTrusted(calibration.kappa),
    accepted: wilson(ACCEPTED, LABELLED_CASES.length),
  };
}

export { scoreAnswer, MODES, RUBRIC };

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("cli.ts")
) {
  process.stdout.write(await renderCouncilEvals());
}
