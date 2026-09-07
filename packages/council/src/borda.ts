// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/council — Borda-tallied peer rankings (llm-council-app v2 parity).
 *
 * llm-council-app v2 upgrades the council's review round from "each advisor
 * names a single strongest response" to **full anonymous rankings**: every
 * advisor orders ALL responses from strongest to weakest, and the council
 * tallies the rankings with the Borda count so the aggregate reflects every
 * advisor's whole preference order — not just the top pick. The chairman then
 * sees the per-letter standings and whether the consensus is strong or
 * fragmented before synthesising.
 *
 * This module is the pure core (parsing + tallying); `DeliberativeCouncil`
 * exposes it as the `rankedReview` phase, reusing the same seeded letter
 * anonymisation as the peer-review phase.
 *
 * Scoring: with N responses, a letter receives N−1 points for being ranked
 * first, N−2 for second, … 0 for last — the classic Borda count over full
 * rankings.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** One advisor's complete ranking of the anonymised responses. */
export interface BordaRanking {
  /** Advisor name that produced this ranking. */
  reviewer: string;
  /** Letters from strongest to weakest, e.g. ["B", "A", "D", "C", "E"]. */
  order: string[];
  /** Raw text the ranking was parsed from (inspectability). */
  raw: string;
}

/** Per-letter Borda tally. */
export interface BordaTally {
  /** Letter the tally covers. */
  letter: string;
  /** Total Borda points across all rankings. */
  points: number;
  /** How many reviewers ranked this letter first. */
  firstPlaceVotes: number;
  /** Mean position across rankings that included the letter (1 = best). */
  meanPosition: number;
}

/** Result of tallying a council's rankings. */
export interface BordaResult {
  /** Standings ordered by points descending (ties broken by first-place votes, then mean position). */
  standings: BordaTally[];
  /** Winner letter (standings[0].letter) for convenience. */
  winner: string;
  /**
   * `consensus` when the top two are separated by a clear margin (≥ 10% of the
   * maximum possible points), `fragmented` otherwise — v2's chairman-seating
   * distinction between a clear winner and a split council.
   */
  strength: "consensus" | "fragmented";
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const LETTER_RE = /\b([A-H])\b/g;

/**
 * Extract the strongest→weakest letter order from one advisor's review text.
 * Tolerates numbered lines ("1. B — …"), comma lists ("B, A, D"), and arrow
 * chains ("B > A > D"); extra prose is ignored. Missing letters truncate the
 * ranking (partial rankings still contribute their top choices).
 */
export function parseBordaRanking(reviewer: string, text: string, expectedLetters: number): BordaRanking {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(LETTER_RE)) {
    const letter = m[1]!;
    if (!seen.has(letter)) {
      seen.add(letter);
      order.push(letter);
    }
  }
  return {
    reviewer,
    order: order.slice(0, expectedLetters),
    raw: text,
  };
}

// ── Tallying ─────────────────────────────────────────────────────────────────

/** Maximum Borda points a single letter can earn (all first places). */
export function maxBordaPoints(rankings: readonly BordaRanking[]): number {
  const n = Math.max(0, ...rankings.map((r) => r.order.length));
  return rankings.length * Math.max(0, n - 1);
}

/**
 * Tally Borda points across rankings. With N ranked responses, position p
 * (1-based) earns N−p points. Standings sort by points, then first-place
 * votes, then mean position. `strength` is `consensus` when the top two
 * stand separated by ≥10% of the maximum possible points.
 */
export function tallyBorda(rankings: readonly BordaRanking[]): BordaResult {
  const points = new Map<string, number>();
  const firsts = new Map<string, number>();
  const positionSum = new Map<string, number>();
  const appearances = new Map<string, number>();

  for (const r of rankings) {
    const n = r.order.length;
    r.order.forEach((letter, idx) => {
      const pos = idx + 1;
      points.set(letter, (points.get(letter) ?? 0) + (n - pos));
      if (pos === 1) firsts.set(letter, (firsts.get(letter) ?? 0) + 1);
      positionSum.set(letter, (positionSum.get(letter) ?? 0) + pos);
      appearances.set(letter, (appearances.get(letter) ?? 0) + 1);
    });
  }

  const standings: BordaTally[] = [...points.entries()]
    .map(([letter, pts]) => ({
      letter,
      points: pts,
      firstPlaceVotes: firsts.get(letter) ?? 0,
      meanPosition: (positionSum.get(letter) ?? 0) / (appearances.get(letter) || 1),
    }))
    .sort((a, b) =>
      b.points - a.points ||
      b.firstPlaceVotes - a.firstPlaceVotes ||
      a.meanPosition - b.meanPosition ||
      a.letter.localeCompare(b.letter),
    );

  const maxPts = maxBordaPoints(rankings);
  const gap = standings.length >= 2 ? standings[0]!.points - standings[1]!.points : maxPts;
  return {
    standings,
    winner: standings[0]?.letter ?? "",
    strength: maxPts > 0 && gap >= 0.1 * maxPts ? "consensus" : "fragmented",
  };
}

/** Render the tally for inclusion in a chairman prompt (de-anonymised outside). */
export function formatBordaStandings(tally: BordaResult): string {
  return tally.standings
    .map(
      (s, i) =>
        `${i + 1}. Response ${s.letter} — ${s.points} pts (${s.firstPlaceVotes} first-place, avg rank ${s.meanPosition.toFixed(2)})`,
    )
    .join("\n");
}
