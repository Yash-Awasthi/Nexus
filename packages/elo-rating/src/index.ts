// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/elo-rating — ELO rating system for model evaluation.
 *
 * Inspired by FastChat's Chatbot Arena ELO leaderboard.
 * Tracks and updates model ratings based on pairwise comparison results,
 * with category-specific scoring and confidence intervals.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface MatchResult {
  winnerId: string;
  loserId: string;
  draw: boolean;
  category?: string;
  timestamp: number;
}

export interface ModelRating {
  id: string;
  name: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  matches: number;
  categoryRatings: Map<string, number>;
  confidenceInterval: number;
  lastMatchAt: number;
}

export interface LeaderboardEntry {
  rank: number;
  modelId: string;
  modelName: string;
  rating: number;
  confidenceInterval: number;
  matches: number;
  winRate: number;
}

// ── ELO Calculator ───────────────────────────────────────────────────────────

export class EloCalculator {
  private models: Map<string, ModelRating> = new Map();
  private kFactor: number;
  private baseRating: number;

  constructor(options?: { kFactor?: number; baseRating?: number }) {
    this.kFactor = options?.kFactor ?? 32;
    this.baseRating = options?.baseRating ?? 1000;
  }

  /**
   * Register a model.
   */
  register(id: string, name: string): void {
    if (!this.models.has(id)) {
      this.models.set(id, {
        id,
        name,
        rating: this.baseRating,
        wins: 0,
        losses: 0,
        draws: 0,
        matches: 0,
        categoryRatings: new Map(),
        confidenceInterval: 0,
        lastMatchAt: 0,
      });
    }
  }

  /**
   * Record a match result and update ratings.
   */
  recordMatch(result: MatchResult): void {
    const winner = this.models.get(result.winnerId);
    const loser = this.models.get(result.loserId);
    if (!winner || !loser) return;

    // Expected scores
    const expectedWinner = this.expectedScore(winner.rating, loser.rating);
    const expectedLoser = this.expectedScore(loser.rating, winner.rating);

    if (result.draw) {
      // Draw: both get 0.5
      winner.rating += this.kFactor * (0.5 - expectedWinner);
      loser.rating += this.kFactor * (0.5 - expectedLoser);
      winner.draws++;
      loser.draws++;
    } else {
      // Win/loss
      winner.rating += this.kFactor * (1 - expectedWinner);
      loser.rating += this.kFactor * (0 - expectedLoser);
      winner.wins++;
      loser.losses++;
    }

    winner.matches++;
    loser.matches++;
    winner.lastMatchAt = result.timestamp;
    loser.lastMatchAt = result.timestamp;

    // Update confidence intervals
    winner.confidenceInterval = this.computeConfidenceInterval(winner);
    loser.confidenceInterval = this.computeConfidenceInterval(loser);

    // Update category ratings
    if (result.category) {
      this.updateCategoryRating(winner, result.category, result.draw ? 0.5 : 1);
      this.updateCategoryRating(loser, result.category, result.draw ? 0.5 : 0);
    }
  }

  /**
   * Get the leaderboard.
   */
  getLeaderboard(): LeaderboardEntry[] {
    const entries: LeaderboardEntry[] = [];
    let rank = 1;

    const sorted = Array.from(this.models.values()).sort((a, b) => b.rating - a.rating);

    for (const model of sorted) {
      entries.push({
        rank,
        modelId: model.id,
        modelName: model.name,
        rating: Math.round(model.rating),
        confidenceInterval: Math.round(model.confidenceInterval),
        matches: model.matches,
        winRate: model.matches > 0 ? model.wins / model.matches : 0,
      });
      rank++;
    }

    return entries;
  }

  /**
   * Get a model's rating.
   */
  getModel(id: string): ModelRating | undefined {
    return this.models.get(id);
  }

  /**
   * Get category-specific leaderboard.
   */
  getCategoryLeaderboard(category: string): LeaderboardEntry[] {
    const entries: LeaderboardEntry[] = [];
    let rank = 1;

    const sorted = Array.from(this.models.values())
      .filter((m) => m.categoryRatings.has(category))
      .sort((a, b) => (b.categoryRatings.get(category) ?? 0) - (a.categoryRatings.get(category) ?? 0));

    for (const model of sorted) {
      entries.push({
        rank,
        modelId: model.id,
        modelName: model.name,
        rating: Math.round(model.categoryRatings.get(category) ?? this.baseRating),
        confidenceInterval: Math.round(model.confidenceInterval),
        matches: model.matches,
        winRate: model.matches > 0 ? model.wins / model.matches : 0,
      });
      rank++;
    }

    return entries;
  }

  /**
   * Predict the outcome of a match between two models.
   */
  predict(winnerId: string, loserId: string): { winnerProb: number; loserProb: number } {
    const winner = this.models.get(winnerId);
    const loser = this.models.get(loserId);
    if (!winner || !loser) return { winnerProb: 0.5, loserProb: 0.5 };

    const winnerProb = this.expectedScore(winner.rating, loser.rating);
    return { winnerProb, loserProb: 1 - winnerProb };
  }

  /**
   * Export all ratings.
   */
  export(): ModelRating[] {
    return Array.from(this.models.values());
  }

  /**
   * Import ratings.
   */
  import(ratings: ModelRating[]): void {
    for (const rating of ratings) {
      this.models.set(rating.id, rating);
    }
  }

  // ── Private Helpers ────────────────────────────────────────────────────

  private expectedScore(ratingA: number, ratingB: number): number {
    return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  }

  private computeConfidenceInterval(model: ModelRating): number {
    if (model.matches === 0) return 400;
    // Approximate 95% confidence interval
    return 400 / Math.sqrt(model.matches);
  }

  private updateCategoryRating(model: ModelRating, category: string, score: number): void {
    const currentRating = model.categoryRatings.get(category) ?? this.baseRating;
    const categoryK = this.kFactor * 0.5; // Lower K for category ratings
    // Simple moving average for category ratings
    const newRating = currentRating + categoryK * (score - 0.5);
    model.categoryRatings.set(category, newRating);
  }
}

export default EloCalculator;
