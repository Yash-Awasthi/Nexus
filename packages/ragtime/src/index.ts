// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/ragtime — Memory-specific RAG retrieval.
 *
 * Different from general pgvector similarity search: tuned for agent memory
 * with recency weighting, importance scoring, and multi-stage
 * retrieve-then-rerank.
 *
 * Architecture
 * ────────────
 *   RagtimeRetriever    — two-stage pipeline: recall pool → rerank.
 *   RagtimeConfig       — scoring weights (α relevance, β importance, γ recency).
 *   compositeScore()    — pure scoring function.
 *   IMemoryStore        — minimal injectable store interface (structurally
 *                         compatible with @nexus/memory).
 *   InMemoryStore       — test/dev in-process store with cosine similarity.
 *
 * Scoring formula
 * ───────────────
 *   composite = α × relevance + β × importance + γ × recency_decay
 *
 *   recency_decay = exp(-λ × age_hours)   where λ = recencyDecayRate
 *
 * Two-stage pipeline
 * ──────────────────
 *   Stage 1 — Recall:  fetch poolSize entries from the vector store by cosine
 *              similarity.  Cheap; gets a broad candidate set.
 *   Stage 2 — Rerank:  apply composite score (relevance + importance + recency)
 *              and return the top finalK.  More expensive but precise.
 *
 * Usage
 * ─────
 * ```ts
 * const retriever = new RagtimeRetriever({ store, embedder });
 * const results = await retriever.retrieve("explain monads", 5);
 * ```
 */

// ── Memory entry types ────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  text: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  createdAt: number; // Unix epoch seconds
  expiresAt?: number;
  /** Caller-assigned importance score 0–1. */
  importance?: number;
}

/** Memory search result interface definition. */
export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number; // cosine similarity 0–1
}

/** Memory filter interface definition. */
export interface MemoryFilter {
  metadata?: Record<string, unknown>;
  excludeExpired?: boolean;
}

// ── Injectable store ──────────────────────────────────────────────────────────

export interface IMemoryStore {
  search(
    queryEmbedding: number[],
    limit: number,
    filter?: MemoryFilter,
  ): Promise<MemorySearchResult[]>;
  save(entry: MemoryEntry): Promise<MemoryEntry>;
  delete(id: string): Promise<void>;
  list(filter?: MemoryFilter): Promise<MemoryEntry[]>;
}

// ── Embedder ──────────────────────────────────────────────────────────────────

export interface IEmbedder {
  embed(text: string): Promise<number[]>;
  readonly dimensions: number;
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

function magnitude(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

/** Cosine similarity. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  return Math.max(0, Math.min(1, dotProduct(a, b) / (magA * magB)));
}

// ── In-memory store for tests ─────────────────────────────────────────────────

export class InMemoryRagtimeStore implements IMemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();

  async save(entry: MemoryEntry): Promise<MemoryEntry> {
    this.entries.set(entry.id, entry);
    return entry;
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async list(filter?: MemoryFilter): Promise<MemoryEntry[]> {
    const now = Math.floor(Date.now() / 1000);
    return Array.from(this.entries.values()).filter((e) => {
      if (filter?.excludeExpired !== false && e.expiresAt !== undefined && e.expiresAt < now)
        return false;
      if (filter?.metadata) {
        for (const [k, v] of Object.entries(filter.metadata)) {
          if (e.metadata[k] !== v) return false;
        }
      }
      return true;
    });
  }

  async search(
    queryEmbedding: number[],
    limit: number,
    filter?: MemoryFilter,
  ): Promise<MemorySearchResult[]> {
    const entries = await this.list(filter);
    const scored = entries.map((entry) => ({
      entry,
      score: cosineSimilarity(queryEmbedding, entry.embedding),
    }));
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

// ── Deterministic embedder for tests ─────────────────────────────────────────

export class FixedRagtimeEmbedder implements IEmbedder {
  readonly dimensions = 32;

  async embed(text: string): Promise<number[]> {
    const vec = new Array<number>(this.dimensions).fill(0);
    for (let i = 0; i < text.length; i++) {
      const idx = text.charCodeAt(i) % this.dimensions;
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
    const mag = magnitude(vec);
    return mag > 0 ? vec.map((v) => v / mag) : vec;
  }
}

// ── Ragtime config ────────────────────────────────────────────────────────────

export interface RagtimeConfig {
  /** Stage 1 recall pool size (default: 20). */
  poolSize?: number;
  /** Stage 2 final result count (default: 5). */
  finalK?: number;
  /** Weight for relevance (cosine similarity) in composite score (default: 0.5). */
  relevanceWeight?: number;
  /** Weight for importance metadata field (default: 0.3). */
  importanceWeight?: number;
  /** Weight for recency decay (default: 0.2). */
  recencyWeight?: number;
  /** Recency decay rate λ — higher = faster decay (default: 0.05 per hour). */
  recencyDecayRate?: number;
  /** Injectable now() for testability. */
  now?: () => number;
}

// ── Composite scoring ─────────────────────────────────────────────────────────

export interface CompositeScored {
  entry: MemoryEntry;
  relevance: number;
  importance: number;
  recencyDecay: number;
  composite: number;
}

/**
 * Pure composite scoring function.
 * @param relevance   Cosine similarity 0–1.
 * @param importance  Entry importance metadata 0–1 (default 0.5 if missing).
 * @param ageSeconds  Age of the entry in seconds.
 * @param config      Weight / decay config.
 */
export function compositeScore(
  relevance: number,
  importance: number,
  ageSeconds: number,
  config: Required<Omit<RagtimeConfig, "poolSize" | "finalK" | "now">>,
): number {
  const ageHours = ageSeconds / 3600;
  const recency = Math.exp(-config.recencyDecayRate * ageHours);
  return (
    config.relevanceWeight * relevance +
    config.importanceWeight * importance +
    config.recencyWeight * recency
  );
}

// ── Ragtime result ────────────────────────────────────────────────────────────

export interface RagtimeResult {
  entry: MemoryEntry;
  relevance: number;
  importance: number;
  recencyDecay: number;
  composite: number;
}

// ── RagtimeRetriever ──────────────────────────────────────────────────────────

export class RagtimeRetriever {
  private readonly store: IMemoryStore;
  private readonly embedder: IEmbedder;
  private readonly poolSize: number;
  private readonly finalK: number;
  private readonly relevanceWeight: number;
  private readonly importanceWeight: number;
  private readonly recencyWeight: number;
  private readonly recencyDecayRate: number;
  private readonly now: () => number;

  constructor(opts: { store: IMemoryStore; embedder: IEmbedder; config?: RagtimeConfig }) {
    const c = opts.config ?? {};
    this.store = opts.store;
    this.embedder = opts.embedder;
    this.poolSize = c.poolSize ?? 20;
    this.finalK = c.finalK ?? 5;
    this.relevanceWeight = c.relevanceWeight ?? 0.5;
    this.importanceWeight = c.importanceWeight ?? 0.3;
    this.recencyWeight = c.recencyWeight ?? 0.2;
    this.recencyDecayRate = c.recencyDecayRate ?? 0.05;
    this.now = c.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Retrieve the top-K most relevant, important, and recent memories.
   *
   * Stage 1: Vector recall — fetch poolSize candidates by cosine similarity.
   * Stage 2: Rerank — apply composite score; return finalK.
   */
  async retrieve(query: string, k?: number, filter?: MemoryFilter): Promise<RagtimeResult[]> {
    const finalK = k ?? this.finalK;

    // Stage 1 — embed query and recall pool
    const queryVec = await this.embedder.embed(query);
    const pool = await this.store.search(queryVec, this.poolSize, filter);

    if (pool.length === 0) return [];

    const nowSeconds = this.now();
    const config = {
      relevanceWeight: this.relevanceWeight,
      importanceWeight: this.importanceWeight,
      recencyWeight: this.recencyWeight,
      recencyDecayRate: this.recencyDecayRate,
    };

    // Stage 2 — rerank by composite score
    const scored: RagtimeResult[] = pool.map(({ entry, score: relevance }) => {
      const importance =
        entry.importance ?? (entry.metadata["importance"] as number | undefined) ?? 0.5;
      const ageSeconds = Math.max(0, nowSeconds - entry.createdAt);
      const ageHours = ageSeconds / 3600;
      const recencyDecay = Math.exp(-config.recencyDecayRate * ageHours);
      const composite = compositeScore(relevance, importance, ageSeconds, config);
      return { entry, relevance, importance, recencyDecay, composite };
    });

    scored.sort((a, b) => b.composite - a.composite);
    return scored.slice(0, finalK);
  }

  /**
   * Retrieve with a pre-computed embedding (avoids re-embedding).
   */
  async retrieveByEmbedding(
    queryEmbedding: number[],
    k?: number,
    filter?: MemoryFilter,
  ): Promise<RagtimeResult[]> {
    const finalK = k ?? this.finalK;
    const pool = await this.store.search(queryEmbedding, this.poolSize, filter);
    if (pool.length === 0) return [];

    const nowSeconds = this.now();
    const config = {
      relevanceWeight: this.relevanceWeight,
      importanceWeight: this.importanceWeight,
      recencyWeight: this.recencyWeight,
      recencyDecayRate: this.recencyDecayRate,
    };

    const scored: RagtimeResult[] = pool.map(({ entry, score: relevance }) => {
      const importance =
        entry.importance ?? (entry.metadata["importance"] as number | undefined) ?? 0.5;
      const ageSeconds = Math.max(0, nowSeconds - entry.createdAt);
      const ageHours = ageSeconds / 3600;
      const recencyDecay = Math.exp(-config.recencyDecayRate * ageHours);
      const composite = compositeScore(relevance, importance, ageSeconds, config);
      return { entry, relevance, importance, recencyDecay, composite };
    });

    scored.sort((a, b) => b.composite - a.composite);
    return scored.slice(0, finalK);
  }
}
