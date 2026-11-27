// SPDX-License-Identifier: Apache-2.0
/**
 * Two council runs, side by side.
 *
 * The question a saved comparison answers is "did that change help?", and the honest answer
 * is a set of measurements rather than a verdict: what each run concluded, what it cost, how
 * long it took, and who said how much. Two things this file deliberately does *not* do:
 *
 *  - it does not ask a model which verdict is better. A judge that has not been calibrated
 *    against human labels is an opinion with a token bill, and `plan.md` says not to ship one
 *    above its proven agreement.
 *  - it does not call a lexical overlap a similarity score in the abstract. `verdict.overlap`
 *    is the Jaccard index of the two verdicts' word sets — reproducible, explainable, and
 *    blind to negation ("ship it" and "do not ship it" overlap on two of three words). The
 *    terms it names are the evidence, and a reader can check them in one glance.
 *
 * Everything here is a pure function of two finished runs, so the arithmetic is testable
 * without a server, a model, or a clock.
 */

export interface RunEntry {
  line: number;
  at: string;
  author: string;
  kind: "contribution" | "digest";
  text: string;
}

/** The shape a comparison reads. A `DiscussionRecord` from `routes/discussion.ts` fits it. */
export interface RunSide {
  id: string;
  topic: string;
  digest: string;
  settled: boolean;
  reason: string;
  participants: string[];
  contributions: number;
  totalTokens: number;
  startedAt: string;
  finishedAt?: string;
  entries: RunEntry[];
}

export interface SideMetrics {
  id: string;
  topic: string;
  settled: boolean;
  reason: string;
  /** Milliseconds from start to finish; `null` when the run never finished. */
  wallMs: number | null;
  contributions: number;
  totalTokens: number;
  /** Tokens per contribution — the number that makes two runs of different length comparable. */
  tokensPerContribution: number | null;
  /** Contributions per minute of wall time; `null` when wall time is unusable. */
  contributionsPerMinute: number | null;
  participants: { label: string; entries: number; characters: number }[];
}

export interface ComparisonDiff {
  topic: { same: boolean; left: string; right: string };
  verdict: {
    identical: boolean;
    /** Jaccard index of the two word sets, 0…1. Equal empty verdicts count as 1. */
    overlap: number;
    /** Terms only the left run used, most frequent first. */
    onlyLeft: string[];
    /** Terms only the right run used, most frequent first. */
    onlyRight: string[];
    shared: string[];
  };
  cost: {
    leftTokens: number;
    rightTokens: number;
    delta: number;
    /** Right ÷ left; `null` when the left run recorded no tokens. */
    ratio: number | null;
  };
  latency: {
    leftMs: number | null;
    rightMs: number | null;
    /** Right − left, in milliseconds; `null` when either side has no wall time. */
    deltaMs: number | null;
  };
  authors: { label: string; leftEntries: number; rightEntries: number }[];
  outcome: { sameSettled: boolean; sameReason: boolean };
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "had",
  "has",
  "have",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "was",
  "were",
  "which",
  "with",
  "we",
  "you",
  "our",
  "i",
  "will",
  "would",
  "can",
  "should",
  "not",
  "no",
  "so",
  "than",
  "too",
  "also",
  "any",
]);

/** Words worth comparing: lowercased, letters and digits, stop words removed. */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

function counts(words: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const word of words) out.set(word, (out.get(word) ?? 0) + 1);
  return out;
}

/** Jaccard over word *sets*: shared ÷ all. 1 when both are empty — two silent runs agree. */
export function jaccard(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function wallMsOf(run: RunSide): number | null {
  if (!run.finishedAt) return null;
  const start = Date.parse(run.startedAt);
  const end = Date.parse(run.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function metrics(run: RunSide): SideMetrics {
  const wallMs = wallMsOf(run);
  const authors = new Map<string, { entries: number; characters: number }>();
  for (const entry of run.entries) {
    if (entry.kind !== "contribution") continue;
    const current = authors.get(entry.author) ?? { entries: 0, characters: 0 };
    current.entries += 1;
    current.characters += entry.text.length;
    authors.set(entry.author, current);
  }
  return {
    id: run.id,
    topic: run.topic,
    settled: run.settled,
    reason: run.reason,
    wallMs,
    contributions: run.contributions,
    totalTokens: run.totalTokens,
    tokensPerContribution:
      run.contributions > 0 ? Math.round(run.totalTokens / run.contributions) : null,
    contributionsPerMinute:
      wallMs && wallMs > 0 ? Math.round((run.contributions / wallMs) * 60_000) : null,
    participants: [...authors.entries()]
      .map(([label, value]) => ({ label, ...value }))
      .sort((a, b) => b.entries - a.entries || a.label.localeCompare(b.label)),
  };
}

/** The one-sided numbers, for a page that shows a run by itself. */
export { metrics as sideMetrics };

/**
 * Compare two finished runs.
 *
 * Both sides are read, never mutated; the order matters only in that "left" is the baseline
 * and deltas point from left to right.
 */
export function compareRuns(left: RunSide, right: RunSide): ComparisonDiff {
  const leftTerms = terms(left.digest);
  const rightTerms = terms(right.digest);
  const leftCounts = counts(leftTerms);
  const rightCounts = counts(rightTerms);

  const onlyLeft = [...leftCounts.entries()]
    .filter(([word]) => !rightCounts.has(word))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([word]) => word);
  const onlyRight = [...rightCounts.entries()]
    .filter(([word]) => !leftCounts.has(word))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([word]) => word);
  const shared = [...leftCounts.keys()].filter((word) => rightCounts.has(word)).sort();

  const leftMetrics = metrics(left);
  const rightMetrics = metrics(right);
  const byLabel = new Map<string, { label: string; leftEntries: number; rightEntries: number }>();
  for (const label of new Set([...left.participants, ...right.participants])) {
    byLabel.set(label, {
      label,
      leftEntries: leftMetrics.participants.find((p) => p.label === label)?.entries ?? 0,
      rightEntries: rightMetrics.participants.find((p) => p.label === label)?.entries ?? 0,
    });
  }

  return {
    topic: { same: left.topic === right.topic, left: left.topic, right: right.topic },
    verdict: {
      identical: left.digest.trim() === right.digest.trim(),
      overlap: Number(jaccard(leftTerms, rightTerms).toFixed(3)),
      onlyLeft,
      onlyRight,
      shared,
    },
    cost: {
      leftTokens: left.totalTokens,
      rightTokens: right.totalTokens,
      delta: right.totalTokens - left.totalTokens,
      ratio:
        left.totalTokens > 0 ? Number((right.totalTokens / left.totalTokens).toFixed(2)) : null,
    },
    latency: {
      leftMs: leftMetrics.wallMs,
      rightMs: rightMetrics.wallMs,
      deltaMs:
        leftMetrics.wallMs !== null && rightMetrics.wallMs !== null
          ? rightMetrics.wallMs - leftMetrics.wallMs
          : null,
    },
    authors: [...byLabel.values()].sort(
      (a, b) =>
        b.leftEntries + b.rightEntries - (a.leftEntries + a.rightEntries) ||
        a.label.localeCompare(b.label),
    ),
    outcome: {
      sameSettled: left.settled === right.settled,
      sameReason: left.reason === right.reason,
    },
  };
}

/** One line a list can show without loading either run. */
export function summarise(left: RunSide, right: RunSide): string {
  const diff = compareRuns(left, right);
  const cost =
    diff.cost.delta === 0
      ? "same cost"
      : `${diff.cost.delta > 0 ? "+" : ""}${diff.cost.delta} tokens`;
  const time =
    diff.latency.deltaMs === null
      ? "unknown time"
      : diff.latency.deltaMs === 0
        ? "same time"
        : `${diff.latency.deltaMs > 0 ? "+" : ""}${Math.round(diff.latency.deltaMs / 1000)}s`;
  const verdict = diff.verdict.identical
    ? "identical verdict"
    : `verdict overlap ${Math.round(diff.verdict.overlap * 100)}%`;
  return `${verdict}, ${cost}, ${time}`;
}
