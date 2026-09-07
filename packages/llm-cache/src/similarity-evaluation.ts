/**
 * Cache Similarity Evaluation — multiple strategies for semantic cache matching.
 * Extracted from: inspiration/Nexus/GPTCache/
 *
 * Extends Nexus's existing LLM cache with pluggable similarity evaluation strategies:
 * - CosineDistanceEvaluation: Embedding cosine similarity
 * - SearchDistanceEvaluation: Vector store distance-based matching
 * - KReciprocalEvaluation: Mutual nearest-neighbor reranking
 * - TimeDecayEvaluation: Time-weighted similarity with exponential decay
 *
 * These strategies replace the simple threshold check in SemanticCachingLLMProvider
 * with more sophisticated matching that reduces false positives.
 */

import type { EmbedFn } from "@nexus/llm-cache";

// ===== Interfaces =====

export interface CacheEvaluationResult {
  /** Similarity score (higher = more similar, range depends on strategy) */
  score: number;
  /** Whether the cache entry is considered a hit */
  hit: boolean;
  /** Strategy-specific metadata */
  metadata?: Record<string, unknown>;
}

export interface CacheEntry {
  id: string;
  embedding: number[];
  text: string;
  model: string;
  response: unknown;
  createdAt: Date;
  accessCount: number;
  lastAccessedAt: Date;
}

export interface SimilarityEvaluator {
  /** Evaluate similarity between a query and a cache entry */
  evaluate(queryEmbedding: number[], entry: CacheEntry): CacheEvaluationResult;
  /** Strategy name for logging */
  readonly name: string;
}

// ===== Cosine Distance =====

/**
 * Cosine similarity evaluation — the default for embedding-based cache matching.
 */
export class CosineDistanceEvaluation implements SimilarityEvaluator {
  readonly name = "cosine";

  constructor(private threshold: number = 0.95) {}

  evaluate(queryEmbedding: number[], entry: CacheEntry): CacheEvaluationResult {
    const score = cosineSimilarity(queryEmbedding, entry.embedding);
    return {
      score,
      hit: score >= this.threshold,
      metadata: { threshold: this.threshold },
    };
  }
}

// ===== Search Distance =====

/**
 * Search distance evaluation — maps vector store distance to similarity score.
 * Distance is normalized to [0, 1] where 1 = most similar.
 */
export class SearchDistanceEvaluation implements SimilarityEvaluator {
  readonly name = "search_distance";

  constructor(
    private maxDistance: number = 4.0,
    private threshold: number = 0.6
  ) {}

  evaluate(queryEmbedding: number[], entry: CacheEntry): CacheEvaluationResult {
    const distance = euclideanDistance(queryEmbedding, entry.embedding);
    // Normalize: lower distance = higher similarity
    const score = 1 - Math.min(distance / this.maxDistance, 1);
    return {
      score,
      hit: score >= this.threshold,
      metadata: { distance, maxDistance: this.maxDistance },
    };
  }
}

// ===== K-Reciprocal =====

/**
 * K-Reciprocal evaluation — reranks candidates using mutual nearest-neighbor.
 * A query and entry are only considered similar if each is in the other's top-K
 * nearest neighbors. This reduces false positives from asymmetric similarities.
 */
export class KReciprocalEvaluation implements SimilarityEvaluator {
  readonly name = "k_reciprocal";

  constructor(
    private entries: CacheEntry[],
    private topK: number = 5,
    private threshold: number = 0.6
  ) {}

  evaluate(queryEmbedding: number[], entry: CacheEntry): CacheEvaluationResult {
    // Compute distances to all entries
    const distances = this.entries.map((e) => ({
      id: e.id,
      distance: euclideanDistance(queryEmbedding, e.embedding),
    }));

    // Check if query is in entry's top-K
    const entryDistances = this.entries.map((e) => ({
      id: e.id,
      distance: euclideanDistance(entry.embedding, e.embedding),
    }));

    entryDistances.sort((a, b) => a.distance - b.distance);
    const entryTopK = entryDistances.slice(0, this.topK).map((e) => e.id);

    // Check if query's entry is in the query's top-K
    distances.sort((a, b) => a.distance - b.distance);
    const queryTopK = distances.slice(0, this.topK).map((d) => d.id);

    // K-reciprocal: entry must be in query's top-K AND query must be in entry's top-K
    const isReciprocal = queryTopK.includes(entry.id) && entryTopK.includes(entry.id);

    // Use cosine similarity for final score
    const score = cosineSimilarity(queryEmbedding, entry.embedding);

    return {
      score: isReciprocal ? score : 0,
      hit: isReciprocal && score >= this.threshold,
      metadata: { isReciprocal, topK: this.topK },
    };
  }
}

// ===== Time Decay =====

/**
 * Time-decay evaluation — recent cache entries are preferred.
 * Older entries get exponentially downweighted.
 */
export class TimeDecayEvaluation implements SimilarityEvaluator {
  readonly name = "time_decay";

  constructor(
    private cosineThreshold: number = 0.95,
    private halfLifeMs: number = 3600_000, // 1 hour
    private timeWeight: number = 0.3
  ) {}

  evaluate(queryEmbedding: number[], entry: CacheEntry): CacheEvaluationResult {
    const cosScore = cosineSimilarity(queryEmbedding, entry.embedding);

    // Time decay: exponential decay based on age
    const ageMs = Date.now() - entry.createdAt.getTime();
    const timeFactor = Math.pow(0.5, ageMs / this.halfLifeMs);

    // Combined score: cosine * (1 - timeWeight) + timeFactor * timeWeight
    const score =
      cosScore * (1 - this.timeWeight) + timeFactor * this.timeWeight;

    return {
      score,
      hit: cosScore >= this.cosineThreshold, // Cosine still gates the hit
      metadata: { cosScore, timeFactor, ageMs },
    };
  }
}

// ===== Utilities =====

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function euclideanDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return Math.sqrt(sum);
}
