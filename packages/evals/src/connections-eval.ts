// SPDX-License-Identifier: Apache-2.0
/**
 * Connections benchmark scoring — ported from the Extended NYT Connections
 * benchmark (inspiration/Nexus/nyt-connections, functions/eval.py).
 *
 * A puzzle has 4 actual groups of 4 words. A model proposes 4 groups. Each
 * actual group that matches any proposed group (case-insensitive set equality)
 * counts, and a puzzle with `g` exact groups scores:
 *   • linear:     g/4
 *   • quadratic-v1 (headline): (g/4)²  → 0, 6.25%, 25%, 56.25%, 100%
 * The leaderboard score is the mean per-puzzle value.
 *
 * `normalizeWord` applies the same answer-cleaning the original eval applies
 * (strip comments/notes, numbering, quotes, parentheticals, colon/dash text).
 */

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Normalize a single predicted word the way the original eval does:
 * strip "// comment", " - note", numbering ("1. "), quotes, <eos>,
 * parenthetical text, and keep the most-plausible segment after colons/dots.
 */
export function normalizeWord(raw: string): string {
  let w = raw.trim();
  w = w.split("//")[0]!.trim();
  w = w.split(" - ")[0]!.trim();
  w = w.replace(/^(\d+\.\s*)+/, "");
  w = w.replace(/<eos>/gi, "").trim();
  w = w.replace(/^['"`]+|['"`]+$/g, "").trim();
  w = w.split("(")[0]!.trim();
  if (w.includes(":")) {
    // Keep the colon-separated part with the most commas (likely the words).
    w = w
      .split(":")
      .sort((a, b) => b.split(",").length - a.split(",").length)[0]!
      .trim();
  }
  if (w.includes(".")) {
    // Keep everything after the first period (handles "1. word").
    const idx = w.indexOf(".");
    if (idx !== -1 && idx < w.length - 1) w = w.slice(idx + 1).trim();
  }
  w = w.split(" - ")[0]!.trim();
  return w;
}

/**
 * Parse a model answer (free text) into up to 4 predicted groups of words.
 * A group is a non-empty line whose words are comma-separated; each group is
 * truncated to its first 4 words like the original eval.
 */
export function parseGroups(answer: string): string[][] {
  const groups: string[][] = [];
  for (const line of answer.split(/\r?\n/)) {
    const lineText = normalizeWord(line);
    if (!lineText) continue;
    const words = lineText
      .split(",")
      .map((x) => normalizeWord(x))
      .filter((w) => w.length > 0)
      .slice(0, 4);
    if (words.length > 0) groups.push(words);
    if (groups.length >= 4) break;
  }
  return groups;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function normalizeGroup(words: string[]): string[] {
  return words.map((w) => normalizeWord(w).toLowerCase()).filter((w) => w.length > 0);
}

function sameGroup(a: string[], b: string[]): boolean {
  const na = normalizeGroup(a);
  const nb = normalizeGroup(b);
  if (na.length === 0 || na.length !== nb.length) return false;
  const setB = new Set(nb);
  return na.every((w) => setB.has(w));
}

/**
 * Number of exact groups (0–4) in a puzzle, plus which actual groups matched.
 */
export function scoreConnectionsGroups(
  actual: string[][],
  predicted: string[][],
): { matched: number; total: number; matchedIndices: number[] } {
  const matchedIndices: number[] = [];
  actual.forEach((group, i) => {
    if (predicted.some((p) => sameGroup(group, p))) matchedIndices.push(i);
  });
  return { matched: matchedIndices.length, total: actual.length, matchedIndices };
}

/**
 * Linear Connections score: g/4 per puzzle (original eval.py semantics).
 */
export function scoreConnections(actual: string[][], predicted: string[][]): number {
  const { matched, total } = scoreConnectionsGroups(actual, predicted);
  return total > 0 ? matched / total : 0;
}

/**
 * Quadratic-v1 Connections score: (g/4)² per puzzle (benchmark headline).
 * 0, 1, 2, 3, 4 groups → 0%, 6.25%, 25%, 56.25%, 100%.
 */
export function scoreConnectionsQuadratic(actual: string[][], predicted: string[][]): number {
  const g = scoreConnections(actual, predicted);
  return g * g;
}

/**
 * Mean of per-puzzle scores (the benchmark leaderboard metric).
 */
export function connectionsMean(scores: number[]): number {
  if (scores.length === 0) return 0;
  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
}

/**
 * Run a full Connections benchmark over many puzzles.
 */
export function runConnectionsBenchmark(
  puzzles: Array<{ groups: string[][]; answer?: string }>,
  answers: string[],
  opts: { quadratic?: boolean } = {},
): {
  perPuzzle: number[];
  mean: number;
  exactPuzzles: number;
} {
  const perPuzzle: number[] = [];
  let exactPuzzles = 0;
  puzzles.forEach((puzzle, i) => {
    const predicted = puzzle.answer ? parseGroups(puzzle.answer) : parseGroups(answers[i] ?? "");
    const score = opts.quadratic === false
      ? scoreConnections(puzzle.groups, predicted)
      : scoreConnectionsQuadratic(puzzle.groups, predicted);
    perPuzzle.push(score);
    if (score === 1) exactPuzzles++;
  });
  return { perPuzzle, mean: connectionsMean(perPuzzle), exactPuzzles };
}