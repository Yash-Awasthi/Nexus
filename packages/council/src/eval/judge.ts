// SPDX-License-Identifier: Apache-2.0
/**
 * The judge: a deterministic rubric scorer, and the arithmetic that decides whether to trust it.
 *
 * Two things live here, and they are deliberately separate.
 *
 * 1. `scoreAnswer` turns a verdict into five 0–5 scores. It reads only the text — does it mention the
 *    numbers that make the decision hard, does it name a cost, does it end with something to do — so the
 *    same answer always earns the same score and a scoring change shows up as a diff rather than as drift.
 *
 * 2. `judgeCalibration` compares those accept/reject decisions against hand labels and reports agreement
 *    and Cohen's κ. A judge is a measuring instrument, and this is its calibration sheet: the numbers it
 *    reports are the numbers a reader is allowed to rely on. `MAX_TRUSTED_KAPPA` is the line above which a
 *    judge would have to be nailed down by better labels before anyone could claim it; `judgeIsTrusted`
 *    refuses to pass silently below `MIN_USEFUL_KAPPA`, because a judge that agrees with humans about half
 *    the time is a coin with extra steps and must not be quoted as a quality metric.
 */

import { RUBRIC, type GoldenPrompt, type RubricCriterion } from "./golden.ts";

export interface CriterionScore {
  id: RubricCriterion["id"];
  score: number;
  why: string;
}

export interface AnswerScore {
  promptId: string;
  criteria: CriterionScore[];
  /** Weighted mean of the five criteria, 0–5. */
  total: number;
  /** A verdict is accepted at or above 3.0; the calibration set uses the same cut. */
  accept: boolean;
}

/** Scores at or above this are accepted. One number, used by the runner and the calibration alike. */
export const ACCEPT_SCORE = 3;

// ── Text signals ──────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "and",
  "in",
  "on",
  "at",
  "for",
  "is",
  "are",
]);

/** Lowercase, drop thousands separators, and normalise the unit spellings people actually write. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\bminutes?\b/g, "min")
    .replace(/\bseconds?\b/g, "s")
    .replace(/\bhours?\b/g, "h")
    .replace(/\bmonths?\b/g, "mo")
    .replace(/\bweeks?\b/g, "wk")
    .replace(/[-_/]/g, " ")
    .replace(/\s+/g, " ");
}

/** Irregular forms that no suffix rule reaches. Short on purpose: guesses here become judge overfitting. */
const IRREGULAR: Record<string, string> = {
  people: "person",
  men: "man",
  women: "woman",
  children: "child",
};

/**
 * One token, reduced enough to match the other spellings of the same word.
 *
 * Light stemming (a trailing plural or `-ed`) rather than a stemmer: `audited`/`audit` and `ops`/`op` have to
 * match, and a real stemmer would also merge words that mean different things in a decision — `cost` and
 * `cosy` — which is worse than a near miss here.
 */
function stem(token: string): string {
  const irregular = IRREGULAR[token];
  if (irregular) return irregular;
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function words(text: string): string[] {
  return normalise(text)
    .replace(/[^a-z0-9%$]+/g, " ")
    .split(" ")
    .filter((token) => token !== "" && !STOPWORDS.has(token))
    .map(stem);
}

function tokensOf(point: string): string[] {
  return words(point);
}

/**
 * Does the answer mention this point?
 *
 * A point is engaged when its numbers appear (they are unambiguous, so `8%` never matches `18%`) and most of
 * its words appear as stems — order-free, because "60% of sell-ins blocked by MFA" and "MFA blocks 3% of
 * sign-ins" are the same engagement written two ways, and requiring adjacency punished the second one for
 * no reason a reader would recognise.
 */
export function mentions(answer: string, point: string): boolean {
  const answerWords = new Set(words(answer));
  const pointWords = tokensOf(point);
  if (pointWords.length === 0) return false;
  const numeric = pointWords.filter((token) => /^[\d.$%]+$/.test(token));
  const textual = pointWords.filter((token) => !/^[\d.$%]+$/.test(token));
  if (numeric.some((token) => !answerWords.has(token))) return false;
  if (textual.length === 0) return numeric.length > 0;
  const matched = textual.filter((token) => answerWords.has(token)).length;
  return matched / textual.length >= 0.6;
}

const VAGUE = ["soon", "various", "several things", "the system", "some users", "a number of"];

const TRADEOFF_MARKERS = [
  "but",
  "however",
  "although",
  "instead",
  "downside",
  "tradeoff",
  "trade-off",
  "cost",
  "risk",
  "at the expense",
  "the other option",
  "if you prefer",
  // A downside is often stated as a consequence rather than signposted: "a stolen backup then needs only the
  // environment key" is a cost. Without these the judge read explicit consequences as no concession at all.
  "breaks",
  "loses",
  "widens",
  "unbounded",
  "exposes",
  "needs only",
  "no longer",
  "worse",
  "at the cost",
  "slower",
  "spends",
];

const ACTION_MARKERS = [
  "next step",
  "recommend",
  "i would",
  "start by",
  "do this",
  "run ",
  "ship ",
  "page ",
  "roll back",
  "rollback",
  "write off",
  "schedule",
  "hold ",
  "wait ",
  "before ",
  "put ",
  "keep ",
  "add ",
  "use ",
  "give ",
  "move ",
  "cap ",
  "charge ",
  "split ",
  "compress ",
  "offer ",
  "generate ",
  "raise ",
  "lower ",
  "leave ",
  "watch ",
  "review ",
  "preinstall",
  "instead",
];

const HEDGES = [
  "cannot",
  "can't",
  "no data",
  "not enough",
  "unknown",
  "estimate",
  "assume",
  "assumption",
  "range",
  "if usage",
  "depends",
  "unclear",
];

const ABSOLUTES = [
  "definitely",
  "guaranteed",
  "certainly",
  "always will",
  "no risk",
  "will succeed",
];

// ── Scoring ───────────────────────────────────────────────────────────────────

function countPresent(text: string, needles: string[]): number {
  return needles.filter((needle) => text.includes(needle)).length;
}

function scoreCoverage(answer: string, prompt: GoldenPrompt): CriterionScore {
  const hits = prompt.mustMention.filter((point) => mentions(answer, point));
  const share = hits.length / prompt.mustMention.length;
  const missing = prompt.mustMention.filter((point) => !mentions(answer, point));
  // Vocabulary overlap is partial credit: an answer that names three of four facts in other words is better
  // than one that names none, and the difference used to be invisible at 0.
  const overlap = overlapShare(answer, prompt);
  const score =
    hits.length === 0
      ? Math.min(2, Math.round(overlap * 2))
      : Math.min(5, Math.max(1, Math.round(share * 5)));
  return {
    id: "coverage",
    score,
    why:
      missing.length === 0
        ? `engages all ${prompt.mustMention.length} facts`
        : `engages ${hits.length}/${prompt.mustMention.length} facts (vocabulary overlap ${(overlap * 100).toFixed(0)}%); silent on ${missing.join(", ")}`,
  };
}

/** Share of the prompt's fact vocabulary that appears anywhere in the answer, 0–1. */
function overlapShare(answer: string, prompt: GoldenPrompt): number {
  const answerWords = new Set(words(answer));
  const pointWords = new Set(prompt.mustMention.flatMap((point) => words(point)));
  if (pointWords.size === 0) return 0;
  let matched = 0;
  for (const word of pointWords) if (answerWords.has(word)) matched += 1;
  return matched / pointWords.size;
}

function scoreSpecificity(answer: string, prompt: GoldenPrompt): CriterionScore {
  const text = normalise(answer);
  const numbers = new Set(text.match(/\d[\d.]*/g) ?? []);
  const vague = countPresent(text, VAGUE);
  const fromPrompt = prompt.mustMention.filter((point) => mentions(answer, point)).length;
  let score = numbers.size >= 3 ? 5 : numbers.size === 2 ? 4 : numbers.size === 1 ? 3 : 1;
  if (fromPrompt === 0 && numbers.size === 0) score = 0;
  if (vague > 0) score = Math.max(0, score - 1);
  return {
    id: "specificity",
    score,
    why: `${numbers.size} number(s)${vague > 0 ? `, ${vague} vague phrase(s)` : ""}`,
  };
}

function scoreTradeoff(answer: string, prompt: GoldenPrompt): CriterionScore {
  const text = normalise(answer);
  const markers = countPresent(text, TRADEOFF_MARKERS);
  const bothSides = mentions(answer, prompt.tradeoff.split(" but ")[0] ?? "") && markers > 0;
  let score = markers >= 2 ? 4 : markers === 1 ? 3 : 0;
  if (bothSides) score = Math.min(5, score + 1);
  if (markers >= 1 && score === 0) score = 1;
  return {
    id: "tradeoff",
    score: Math.min(5, score),
    why: `${markers} concession marker(s)${bothSides ? ", names both sides" : ""}`,
  };
}

function scoreAction(answer: string, prompt: GoldenPrompt): CriterionScore {
  const text = normalise(answer);
  const lastThird = text.slice(Math.max(0, Math.floor((text.length * 2) / 3)));
  const inEnding = countPresent(lastThird, ACTION_MARKERS);
  const anywhere = countPresent(text, ACTION_MARKERS);
  const scored = inEnding > 0 ? 5 : anywhere > 0 ? 3 : 0;
  return {
    id: "action",
    score: scored,
    why:
      inEnding > 0
        ? "closes with a step"
        : anywhere > 0
          ? "a step appears but the verdict drifts afterwards"
          : `no step; a decision is ${
              prompt.category === "engineering" ? "a change to make" : "a thing to do"
            }`,
  };
}

function scoreHonesty(answer: string, prompt: GoldenPrompt): CriterionScore {
  const text = normalise(answer);
  const hedges = countPresent(text, HEDGES);
  const absolutes = countPresent(text, ABSOLUTES);
  if (!prompt.answerable) {
    const score = hedges >= 2 ? 5 : hedges === 1 ? 4 : 1;
    return {
      id: "honesty",
      score: absolutes > 0 ? Math.max(0, score - 2) : score,
      why:
        hedges === 0
          ? "the context cannot support a number, and the answer does not say so"
          : `hedges the estimate (${hedges} marker(s))`,
    };
  }
  const score = absolutes > 0 ? 2 : hedges > 0 ? 4 : 5;
  return {
    id: "honesty",
    score,
    why: absolutes > 0 ? "claims certainty the context does not support" : "no overclaiming",
  };
}

const WEIGHTS: Record<RubricCriterion["id"], number> = {
  coverage: 0.3,
  specificity: 0.2,
  tradeoff: 0.2,
  action: 0.2,
  honesty: 0.1,
};

/** Score one verdict against one prompt. */
export function scoreAnswer(answer: string, prompt: GoldenPrompt): AnswerScore {
  const criteria = [
    scoreCoverage(answer, prompt),
    scoreSpecificity(answer, prompt),
    scoreTradeoff(answer, prompt),
    scoreAction(answer, prompt),
    scoreHonesty(answer, prompt),
  ];
  const total =
    Math.round(criteria.reduce((sum, c) => sum + c.score * WEIGHTS[c.id], 0) * 100) / 100;
  return { promptId: prompt.id, criteria, total, accept: total >= ACCEPT_SCORE };
}

/** The rubric as the runner reports it, so a score can be read without opening this file. */
export function renderRubric(): string {
  const rows = RUBRIC.map(
    (criterion) => `| ${criterion.id} | ${WEIGHTS[criterion.id].toFixed(2)} | ${criterion.five} |`,
  );
  return ["| Criterion | Weight | A 5 |", "| --- | --- | --- |", ...rows].join("\n");
}

// ── Calibration ──────────────────────────────────────────────────────────────

export interface LabelledCase {
  id: string;
  promptId: string;
  answer: string;
  /** The hand label: would a careful reader accept this verdict? */
  accept: boolean;
  /** Why, in the labeller's words — this is what the failure modes are written from. */
  why: string;
}

export interface Calibration {
  n: number;
  agreement: number;
  kappa: number;
  /** Four cells of the accept/reject table, judge right or wrong. */
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  disagreements: { id: string; label: boolean; judge: boolean; why: string; score: number }[];
}

/** Cohen's κ for two raters on one binary question. */
export function cohenKappa(label: boolean[], judge: boolean[]): number {
  if (label.length === 0 || label.length !== judge.length) return 0;
  const n = label.length;
  const observed = label.filter((value, i) => value === judge[i]).length / n;
  const yesLabel = label.filter(Boolean).length / n;
  const yesJudge = judge.filter(Boolean).length / n;
  const expected = yesLabel * yesJudge + (1 - yesLabel) * (1 - yesJudge);
  if (expected === 1) return observed === 1 ? 1 : 0;
  return Math.round(((observed - expected) / (1 - expected)) * 1000) / 1000;
}

/**
 * A judge that agrees with people no better than chance is not a judge.
 *
 * Below this κ the calibration reports `trusted: false` and the generated document says so in the first
 * line instead of the last: the numbers are still published, they just do not get to be called quality.
 */
export const MIN_USEFUL_KAPPA = 0.4;

/** κ at or above this would be strong enough to gate a release on, and no judge here claims it. */
export const MAX_TRUSTED_KAPPA = 0.7;

export function judgeCalibration(cases: LabelledCase[], prompts: GoldenPrompt[]): Calibration {
  const byId = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  const disagreements: Calibration["disagreements"] = [];
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;

  for (const item of cases) {
    const prompt = byId.get(item.promptId);
    if (!prompt)
      throw new Error(`labelled case ${item.id} names an unknown prompt ${item.promptId}`);
    const score = scoreAnswer(item.answer, prompt);
    if (score.accept && item.accept) truePositive += 1;
    else if (score.accept && !item.accept) falsePositive += 1;
    else if (!score.accept && !item.accept) trueNegative += 1;
    else falseNegative += 1;
    if (score.accept !== item.accept) {
      disagreements.push({
        id: item.id,
        label: item.accept,
        judge: score.accept,
        why: item.why,
        score: score.total,
      });
    }
  }

  const labels = cases.map((item) => item.accept);
  const judgements = cases.map((item) => {
    const prompt = byId.get(item.promptId);
    if (!prompt)
      throw new Error(`labelled case ${item.id} names an unknown prompt ${item.promptId}`);
    return scoreAnswer(item.answer, prompt).accept;
  });

  const agreement =
    cases.length === 0
      ? 0
      : Math.round((labels.filter((v, i) => v === judgements[i]).length / cases.length) * 1000) /
        1000;

  return {
    n: cases.length,
    agreement,
    kappa: cohenKappa(labels, judgements),
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
    disagreements,
  };
}

export interface JudgeVerdict {
  trusted: boolean;
  kappa: number;
  reason: string;
}

/** The shipping rule, applied to a measured κ rather than to a wish. */
export function judgeIsTrusted(kappa: number): JudgeVerdict {
  if (kappa >= MAX_TRUSTED_KAPPA) {
    return {
      trusted: true,
      kappa,
      reason: `κ ${kappa.toFixed(2)} — strong agreement on this label set; a release gate would still want a second annotator's labels`,
    };
  }
  if (kappa >= MIN_USEFUL_KAPPA) {
    return {
      trusted: true,
      kappa,
      reason: `κ ${kappa.toFixed(2)} — usable for ranking and regression, not for a release gate`,
    };
  }
  return {
    trusted: false,
    kappa,
    reason: `κ ${kappa.toFixed(2)} — below ${MIN_USEFUL_KAPPA}; this judge must not be quoted as a quality metric`,
  };
}
