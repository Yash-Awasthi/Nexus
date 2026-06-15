// SPDX-License-Identifier: Apache-2.0
/**
 * rlhf-pipeline — Feedback collection and preference-data pipeline for RLHF.
 *
 * Provides:
 *   • FeedbackStore     — collect and query human feedback on model responses
 *   • PreferencePair    — structure for comparison-based preference data
 *   • PipelineExporter  — export collected data to JSONL training format
 *   • RewardSignal      — aggregate feedback into reward signals per session
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type FeedbackRating = "thumbs_up" | "thumbs_down" | "neutral";
/** Feedback source type alias. */
export type FeedbackSource = "ui" | "api" | "automated";

/** Feedback entry interface definition. */
export interface FeedbackEntry {
  id: string;
  sessionId: string;
  messageId: string;
  promptText: string;
  responseText: string;
  model: string;
  rating: FeedbackRating;
  /** Free-form human comment */
  comment?: string;
  source: FeedbackSource;
  userId?: string;
  createdAt: string;
}

/** Preference pair interface definition. */
export interface PreferencePair {
  id: string;
  promptText: string;
  chosen: string;
  rejected: string;
  model?: string;
  sessionId?: string;
  createdAt: string;
}

/** Reward signal interface definition. */
export interface RewardSignal {
  sessionId: string;
  totalFeedback: number;
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;
  rewardScore: number; // (positive - negative) / total ∈ [-1, 1]
}

/** Feedback filter interface definition. */
export interface FeedbackFilter {
  sessionId?: string;
  rating?: FeedbackRating;
  model?: string;
  userId?: string;
  source?: FeedbackSource;
}

// ── ID generation ─────────────────────────────────────────────────────────────

let _counter = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++_counter}`;
}

// ── FeedbackStore ─────────────────────────────────────────────────────────────

export class FeedbackStore {
  private entries = new Map<string, FeedbackEntry>();
  private pairs = new Map<string, PreferencePair>();

  // ── Feedback ───────────────────────────────────────────────────────────────

  addFeedback(data: Omit<FeedbackEntry, "id" | "createdAt">): FeedbackEntry {
    const entry: FeedbackEntry = {
      ...data,
      id: uid("fb"),
      createdAt: new Date().toISOString(),
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  getFeedback(id: string): FeedbackEntry | undefined {
    return this.entries.get(id);
  }

  queryFeedback(filter: FeedbackFilter = {}): FeedbackEntry[] {
    let results = [...this.entries.values()];
    if (filter.sessionId) results = results.filter((e) => e.sessionId === filter.sessionId);
    if (filter.rating) results = results.filter((e) => e.rating === filter.rating);
    if (filter.model) results = results.filter((e) => e.model === filter.model);
    if (filter.userId) results = results.filter((e) => e.userId === filter.userId);
    if (filter.source) results = results.filter((e) => e.source === filter.source);
    return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  deleteFeedback(id: string): boolean {
    return this.entries.delete(id);
  }

  feedbackCount(): number {
    return this.entries.size;
  }

  // ── Preference pairs ───────────────────────────────────────────────────────

  addPreferencePair(data: Omit<PreferencePair, "id" | "createdAt">): PreferencePair {
    const pair: PreferencePair = {
      ...data,
      id: uid("pp"),
      createdAt: new Date().toISOString(),
    };
    this.pairs.set(pair.id, pair);
    return pair;
  }

  getPreferencePair(id: string): PreferencePair | undefined {
    return this.pairs.get(id);
  }

  listPreferencePairs(): PreferencePair[] {
    return [...this.pairs.values()];
  }

  pairCount(): number {
    return this.pairs.size;
  }

  // ── Generate preference pairs from thumbs up/down feedback ────────────────

  /**
   * Auto-generate preference pairs by pairing thumbs_up responses against
   * thumbs_down responses on the same promptText.
   */
  generatePreferencePairs(): PreferencePair[] {
    const byPrompt = new Map<string, { pos: FeedbackEntry[]; neg: FeedbackEntry[] }>();

    for (const entry of this.entries.values()) {
      const existing = byPrompt.get(entry.promptText) ?? { pos: [], neg: [] };
      if (entry.rating === "thumbs_up") existing.pos.push(entry);
      if (entry.rating === "thumbs_down") existing.neg.push(entry);
      byPrompt.set(entry.promptText, existing);
    }

    const generated: PreferencePair[] = [];
    for (const [prompt, { pos, neg }] of byPrompt) {
      for (const p of pos) {
        for (const n of neg) {
          const pair = this.addPreferencePair({
            promptText: prompt,
            chosen: p.responseText,
            rejected: n.responseText,
            model: p.model,
            sessionId: p.sessionId,
          });
          generated.push(pair);
        }
      }
    }
    return generated;
  }

  // ── Reward signal ──────────────────────────────────────────────────────────

  computeRewardSignal(sessionId: string): RewardSignal {
    const entries = this.queryFeedback({ sessionId });
    const positiveCount = entries.filter((e) => e.rating === "thumbs_up").length;
    const negativeCount = entries.filter((e) => e.rating === "thumbs_down").length;
    const neutralCount = entries.filter((e) => e.rating === "neutral").length;
    const total = entries.length;
    const rewardScore = total === 0 ? 0 : (positiveCount - negativeCount) / total;
    return {
      sessionId,
      totalFeedback: total,
      positiveCount,
      negativeCount,
      neutralCount,
      rewardScore,
    };
  }
}

// ── PipelineExporter ──────────────────────────────────────────────────────────

export class PipelineExporter {
  constructor(private store: FeedbackStore) {}

  /**
   * Export preference pairs as JSONL (one JSON object per line).
   * Each line: { "prompt": "...", "chosen": "...", "rejected": "..." }
   */
  toJSONL(): string {
    return this.store
      .listPreferencePairs()
      .map((p) => JSON.stringify({ prompt: p.promptText, chosen: p.chosen, rejected: p.rejected }))
      .join("\n");
  }

  /**
   * Export raw feedback as JSONL.
   */
  feedbackToJSONL(filter: FeedbackFilter = {}): string {
    return this.store
      .queryFeedback(filter)
      .map((e) => JSON.stringify(e))
      .join("\n");
  }

  /**
   * Summary stats for reporting.
   */
  stats(): {
    totalFeedback: number;
    totalPairs: number;
    ratingBreakdown: Record<FeedbackRating, number>;
  } {
    const all = this.store.queryFeedback();
    const ratingBreakdown: Record<FeedbackRating, number> = {
      thumbs_up: 0,
      thumbs_down: 0,
      neutral: 0,
    };
    for (const e of all) {
      ratingBreakdown[e.rating]++;
    }
    return {
      totalFeedback: this.store.feedbackCount(),
      totalPairs: this.store.pairCount(),
      ratingBreakdown,
    };
  }
}
