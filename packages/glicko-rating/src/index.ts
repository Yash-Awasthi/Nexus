// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/glicko-rating — Glicko-2 rating system for model evaluation.
 *
 * Faithful port of the Glicko-2 rating system (Mark E. Glickman,
 * http://glicko.net/glicko/glicko2.pdf), as implemented by glicko2.ts:
 *   • Full volatility update via the Illinois algorithm (steps 5.1–5.5)
 *   • Rating-period semantics: v, Δ, pre-rating RD (φ*), then φ′ and μ′
 *   • Match history (wins / losses / draws / win rate) per player
 *
 * More advanced than ELO: tracks rating deviation (accuracy) and volatility
 * (consistency), providing richer insights into model performance.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface GlickoPlayer {
  id: string;
  name: string;
  rating: number;
  ratingDeviation: number;
  volatility: number;
  lastActive: number;
}

export interface MatchResult {
  winnerId: string;
  loserId?: string; // undefined for draw
  draw: boolean;
  timestamp: number;
}

export interface GlickoPlayerStats {
  id: string;
  name: string;
  rating: number;
  ratingDeviation: number;
  volatility: number;
  rank: number;
  matches: number;
  winRate: number;
  ratingConfidence: "low" | "medium" | "high";
}

// ── Constants ────────────────────────────────────────────────────────────────

const SCALING_FACTOR = 173.7178;
const DEFAULT_RATING = 1500;
const DEFAULT_RD = 350;
const DEFAULT_VOL = 0.06;
const DEFAULT_TAU = 0.5;

/** Internal per-player rating-period state, in Glicko-2 scale. */
interface PeriodState {
  /** Opponent μ (Glicko-2 rating) faced this period. */
  ranks: number[];
  /** Opponent φ (Glicko-2 RD) faced this period. */
  rds: number[];
  /** Outcome from this player's perspective: 1 win, 0.5 draw, 0 loss. */
  outcomes: number[];
}

// ── Glicko-2 math (paper steps) ──────────────────────────────────────────────

const g = (phi: number): number => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));

const expected = (mu: number, muOpp: number, phiOpp: number): number =>
  1 / (1 + Math.exp(-g(phiOpp) * (mu - muOpp)));

/**
 * The f(x) function used by the Illinois algorithm (paper step 5.2).
 */
function makef(
  delta: number,
  v: number,
  a: number,
  phi: number,
  tau: number,
): (x: number) => number {
  return (x: number): number =>
    (Math.exp(x) * (delta * delta - phi * phi - v - Math.exp(x))) /
      (2 * Math.pow(phi * phi + v + Math.exp(x), 2)) -
    (x - a) / (tau * tau);
}

/**
 * Step 5 — new volatility σ′ via the Illinois algorithm (paper steps 5.1–5.5).
 */
function newVolatility(v: number, delta: number, vol: number, phi: number, tau: number): number {
  // 5.1
  let a = Math.log(vol * vol);
  const f = makef(delta, v, a, phi, tau);
  const epsilon = 0.0000001;

  // 5.2
  let b: number;
  let k: number;
  if (delta * delta > phi * phi + v) {
    b = Math.log(delta * delta - phi * phi - v);
  } else {
    k = 1;
    while (f(a - k * tau) < 0) {
      k = k + 1;
    }
    b = a - k * tau;
  }

  // 5.3
  let fA = f(a);
  let fB = f(b);

  // 5.4
  let c: number;
  let fC: number;
  while (Math.abs(b - a) > epsilon) {
    c = a + ((a - b) * fA) / (fB - fA);
    fC = f(c);
    if (fC * fB < 0) {
      a = b;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    b = c;
    fB = fC;
  }

  // 5.5
  return Math.exp(a / 2);
}

// ── Glicko-2 System ──────────────────────────────────────────────────────────

export class Glicko2System {
  private players: Map<string, GlickoPlayer> = new Map();
  /** Pending results for the current rating period (cleared after apply). */
  private period: Map<string, PeriodState> = new Map();
  /** Cumulative per-player outcomes across all rating periods. */
  private history: Map<string, number[]> = new Map();
  private tau: number;
  private defaultRating: number;
  private defaultRD: number;
  private defaultVol: number;

  constructor(settings?: { tau?: number; rating?: number; rd?: number; vol?: number }) {
    this.tau = settings?.tau ?? DEFAULT_TAU;
    this.defaultRating = settings?.rating ?? DEFAULT_RATING;
    this.defaultRD = settings?.rd ?? DEFAULT_RD;
    this.defaultVol = settings?.vol ?? DEFAULT_VOL;
  }

  /**
   * Create a new player.
   */
  makePlayer(id: string, name: string, rating?: number, rd?: number, vol?: number): GlickoPlayer {
    const player: GlickoPlayer = {
      id,
      name,
      rating: rating ?? this.defaultRating,
      ratingDeviation: rd ?? this.defaultRD,
      volatility: vol ?? this.defaultVol,
      lastActive: Date.now(),
    };
    this.players.set(id, player);
    return player;
  }

  /**
   * Get a player by ID.
   */
  getPlayer(id: string): GlickoPlayer | undefined {
    return this.players.get(id);
  }

  /**
   * Whether the player has recorded match history.
   */
  hasPlayed(id: string): boolean {
    return (this.history.get(id)?.length ?? 0) > 0;
  }

  /**
   * Record a single match and apply the Glicko-2 update immediately
   * (each call is treated as its own rating period).
   */
  recordMatch(result: MatchResult): void {
    const winner = this.players.get(result.winnerId);
    const loser = result.loserId ? this.players.get(result.loserId) : undefined;
    if (!winner) return;

    if (result.draw) {
      if (!loser) return;
      this.registerResult(winner, loser, 0.5);
      this.registerResult(loser, winner, 0.5);
      winner.lastActive = result.timestamp;
      loser.lastActive = result.timestamp;
      this.applyUpdate(winner);
      this.applyUpdate(loser);
      this.period.delete(winner.id);
      this.period.delete(loser.id);
      return;
    }

    if (!loser) return;
    this.registerResult(winner, loser, 1);
    this.registerResult(loser, winner, 0);
    winner.lastActive = result.timestamp;
    loser.lastActive = result.timestamp;
    this.applyUpdate(winner);
    this.applyUpdate(loser);
    this.period.delete(winner.id);
    this.period.delete(loser.id);
  }

  /**
   * Batch update over a rating period: clears previous-period results, records
   * all matches, then calculates new ratings once for every player involved.
   * Mirrors glicko2.ts `updateRatings()` — the faithful rating-period semantics.
   */
  updateRatings(matches: MatchResult[]): void {
    this.period.clear();
    // Note: `history` is deliberately NOT cleared — matches/wins/winRate are
    // cumulative across rating periods; only the pending period state resets.
    for (const result of matches) {
      const winner = this.players.get(result.winnerId);
      if (!winner) continue;
      const loser = result.loserId ? this.players.get(result.loserId) : undefined;
      if (result.draw) {
        if (!loser) continue;
        this.registerResult(winner, loser, 0.5);
        this.registerResult(loser, winner, 0.5);
        winner.lastActive = result.timestamp;
        loser.lastActive = result.timestamp;
      } else {
        if (!loser) continue;
        this.registerResult(winner, loser, 1);
        this.registerResult(loser, winner, 0);
        winner.lastActive = result.timestamp;
        loser.lastActive = result.timestamp;
      }
    }
    for (const id of this.period.keys()) {
      const player = this.players.get(id);
      if (player) this.applyUpdate(player);
    }
  }

  /**
   * Get all players ranked by rating.
   */
  getLeaderboard(): GlickoPlayerStats[] {
    const stats: GlickoPlayerStats[] = [];
    let rank = 1;

    const sorted = Array.from(this.players.values()).sort((a, b) => b.rating - a.rating);

    for (const player of sorted) {
      const { matches, wins } = this.matchHistory(player.id);
      stats.push({
        id: player.id,
        name: player.name,
        rating: Math.round(player.rating),
        ratingDeviation: Math.round(player.ratingDeviation),
        volatility: parseFloat(player.volatility.toFixed(4)),
        rank,
        matches,
        winRate: matches > 0 ? wins / matches : 0,
        ratingConfidence: this.getConfidence(player.ratingDeviation),
      });
      rank++;
    }

    return stats;
  }

  /**
   * Predict the outcome of a match.
   */
  predict(winnerId: string, loserId: string): { winnerProb: number; loserProb: number } {
    const winner = this.players.get(winnerId);
    const loser = this.players.get(loserId);
    if (!winner || !loser) return { winnerProb: 0.5, loserProb: 0.5 };

    const winnerProb = expected(
      this.toMu(winner.rating),
      this.toMu(loser.rating),
      this.toPhi(loser.ratingDeviation),
    );
    return { winnerProb, loserProb: 1 - winnerProb };
  }

  /**
   * Export all players.
   */
  export(): GlickoPlayer[] {
    return Array.from(this.players.values());
  }

  /**
   * Import players.
   */
  import(players: GlickoPlayer[]): void {
    for (const player of players) {
      this.players.set(player.id, player);
    }
  }

  // ── Rating-period bookkeeping ──────────────────────────────────────────────

  private registerResult(player: GlickoPlayer, opponent: GlickoPlayer, outcome: number): void {
    const state = this.period.get(player.id) ?? { ranks: [], rds: [], outcomes: [] };
    state.ranks.push(this.toMu(opponent.rating));
    state.rds.push(this.toPhi(opponent.ratingDeviation));
    state.outcomes.push(outcome);
    this.period.set(player.id, state);
    const h = this.history.get(player.id) ?? [];
    h.push(outcome);
    this.history.set(player.id, h);
  }

  /**
   * Apply the paper's steps 3–7 for one player over its pending period results.
   */
  private applyUpdate(player: GlickoPlayer): void {
    const state = this.period.get(player.id);
    const mu = this.toMu(player.rating);
    let phi = this.toPhi(player.ratingDeviation);
    let sigma = player.volatility;

    // Inactivity decay before the period (no matches played → RD still grows).
    const elapsedPeriods = state
      ? 1
      : Math.max(1, Math.floor((Date.now() - player.lastActive) / (30 * 24 * 60 * 60 * 1000)));

    if (!state || state.outcomes.length === 0) {
      // Step 6 only: φ* = sqrt(φ² + σ²·t)
      player.ratingDeviation = Math.min(
        DEFAULT_RD,
        this.fromPhi(Math.sqrt(phi * phi + elapsedPeriods * sigma * sigma)),
      );
      return;
    }

    // Step 3 — estimated variance v.
    let varianceSum = 0;
    let deltaSum = 0;
    for (let i = 0; i < state.outcomes.length; i++) {
      const gPhiJ = g(state.rds[i]!);
      const e = expected(mu, state.ranks[i]!, state.rds[i]!);
      varianceSum += gPhiJ * gPhiJ * e * (1 - e);
      deltaSum += gPhiJ * (state.outcomes[i]! - e);
    }
    const v = 1 / varianceSum;

    // Step 4 — Δ.
    const delta = v * deltaSum;

    // Step 5 — new volatility σ′ (Illinois algorithm).
    sigma = newVolatility(v, delta, sigma, phi, this.tau);

    // Step 6 — pre-rating RD: φ* = sqrt(φ² + σ′²).
    phi = Math.sqrt(phi * phi + sigma * sigma);

    // Step 7 — new RD φ′ and rating μ′.
    const newPhi = 1 / Math.sqrt(1 / (phi * phi) + 1 / v);
    const newMu = mu + newPhi * newPhi * deltaSum;

    player.rating = this.fromMu(newMu);
    player.ratingDeviation = this.fromPhi(newPhi);
    player.volatility = sigma;
  }

  private matchHistory(id: string): {
    matches: number;
    wins: number;
    draws: number;
    losses: number;
  } {
    const outcomes = this.history.get(id) ?? [];
    let wins = 0;
    let draws = 0;
    let losses = 0;
    for (const o of outcomes) {
      if (o === 1) wins++;
      else if (o === 0.5) draws++;
      else losses++;
    }
    return { matches: outcomes.length, wins, draws, losses };
  }

  private getConfidence(rd: number): "low" | "medium" | "high" {
    if (rd > 100) return "low";
    if (rd > 50) return "medium";
    return "high";
  }

  // ── Scale conversions (paper §3.1) ─────────────────────────────────────────
  // μ = (r − 1500)/173.7178 but φ = RD/173.7178 (no base shift on RD).

  private toMu(rating: number): number {
    return (rating - this.defaultRating) / SCALING_FACTOR;
  }

  private fromMu(mu: number): number {
    return mu * SCALING_FACTOR + this.defaultRating;
  }

  private toPhi(rd: number): number {
    return rd / SCALING_FACTOR;
  }

  private fromPhi(phi: number): number {
    return phi * SCALING_FACTOR;
  }
}

export default Glicko2System;
