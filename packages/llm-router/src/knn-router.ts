// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/knn-router — K-Nearest Neighbors based LLM routing.
 *
 * Inspired by LLMRouter's KNNRouter. Embeds each query into a feature
 * vector, computes cosine similarity against pre-profiled model embeddings,
 * and routes to the most similar (best-performing) model.
 *
 * Usage
 * ─────
 * ```ts
 * const router = new KNNRouter({
 *   k: 3,
 *   models: [
 *     { alias: "claude-opus", embedding: [0.9, 0.1, 0.3, 0.8], avgScore: 0.92 },
 *     { alias: "gpt-4o",     embedding: [0.8, 0.2, 0.4, 0.7], avgScore: 0.90 },
 *     { alias: "llama-70b",  embedding: [0.3, 0.7, 0.6, 0.2], avgScore: 0.75 },
 *   ],
 * });
 * const route = router.route("Explain quantum entanglement in detail");
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface KNNModelProfile {
  alias: string;
  embedding: number[];
  avgScore: number;
  category?: string;
}

export interface KNNRouteResult {
  chosenAlias: string;
  score: number;
  neighbors: { alias: string; similarity: number; avgScore: number }[];
}

export interface KNNRouterConfig {
  k?: number;
  models: KNNModelProfile[];
  /** Optional: custom embedding function. Default: TF-IDF-like word hashing. */
  embed?: (text: string) => number[];
}

// ── Default embedding: lightweight TF-IDF-style word hashing ─�───────────────

function defaultEmbed(text: string): number[] {
  const dim = 128;
  const vec = new Array<number>(dim).fill(0);
  const words = text.toLowerCase().split(/\s+/);
  for (const word of words) {
    // Simple hash: distribute word into dim buckets
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
    }
    const idx = Math.abs(hash) % dim;
    vec[idx] = (vec[idx] ?? 0) + 1;
  }
  // L2 normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] = (vec[i] ?? 0) / norm;
  }
  return vec;
}

// ── Cosine similarity ────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

// ── KNN Router ───────────────────────────────────────────────────────────────

export class KNNRouter {
  private readonly k: number;
  private readonly models: KNNModelProfile[];
  private readonly embed: (text: string) => number[];

  constructor(config: KNNRouterConfig) {
    this.k = config.k ?? 3;
    this.models = config.models;
    this.embed = config.embed ?? defaultEmbed;
  }

  /**
   * Route a query to the best model using KNN on embeddings.
   * Finds the k nearest model profiles by cosine similarity,
   * then picks the one with the highest avgScore among neighbors.
   */
  route(query: string): KNNRouteResult {
    const queryEmb = this.embed(query);

    // Compute similarities to all models
    const scored = this.models.map((m) => ({
      alias: m.alias,
      similarity: cosineSimilarity(queryEmb, m.embedding),
      avgScore: m.avgScore,
    }));

    // Sort by similarity descending
    scored.sort((a, b) => b.similarity - a.similarity);

    // Take top-k neighbors
    const neighbors = scored.slice(0, this.k);

    // Among neighbors, pick the one with highest avgScore (best model that's similar)
    const best = neighbors.reduce((a, b) => (a.avgScore >= b.avgScore ? a : b));

    return {
      chosenAlias: best.alias,
      score: best.avgScore,
      neighbors,
    };
  }

  /**
   * Route using pure similarity (ignore avgScore).
   * Good when model profiles are not available.
   */
  routeBySimilarity(query: string): KNNRouteResult {
    const queryEmb = this.embed(query);

    const scored = this.models.map((m) => ({
      alias: m.alias,
      similarity: cosineSimilarity(queryEmb, m.embedding),
      avgScore: m.avgScore,
    }));

    scored.sort((a, b) => b.similarity - a.similarity);
    const neighbors = scored.slice(0, this.k);
    const best = neighbors[0]!;

    return {
      chosenAlias: best.alias,
      score: best.similarity,
      neighbors,
    };
  }

  /** Add a new model profile. */
  addModel(profile: KNNModelProfile): void {
    this.models.push(profile);
  }

  /** Get all registered model profiles. */
  getModels(): KNNModelProfile[] {
    return [...this.models];
  }
}

export default KNNRouter;
