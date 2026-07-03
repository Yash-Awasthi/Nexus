// SPDX-License-Identifier: Apache-2.0
// Ragtime — two-stage recall + composite rerank retrieval layer.
// Stage 1: embed query, pull poolSize candidates from backing store.
// Stage 2: composite score (α·relevance + β·importance + γ·recency_decay) → top finalK.

export interface IEmbedder {
  embed(text: string): Promise<number[]>;
}

export interface IMemoryEntry {
  id: string;
  content: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  createdAt?: Date | string | number;
  importance?: number;
}

export interface IMemoryStore {
  search(embedding: number[], k: number, filter?: Record<string, unknown>): Promise<IMemoryEntry[]>;
}

export interface RagtimeConfig {
  /** Candidate pool size for stage-1 cosine recall. Default: 20. */
  poolSize?: number;
  /** Maximum results returned after reranking. Default: 10. */
  finalK?: number;
  /** Weight of semantic relevance score [0,1]. Default: 0.6. */
  alpha?: number;
  /** Weight of importance score [0,1]. Default: 0.2. */
  beta?: number;
  /** Weight of recency decay [0,1]. Default: 0.2. */
  gamma?: number;
  /** Half-life in milliseconds for recency decay. Default: 7 days. */
  halfLifeMs?: number;
}

function cosineSim(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function recencyDecay(entry: IMemoryEntry, halfLifeMs: number): number {
  const ts = entry.createdAt;
  if (!ts) return 0.5;
  const t =
    ts instanceof Date
      ? ts.getTime()
      : typeof ts === "string"
        ? new Date(ts).getTime()
        : Number(ts);
  const ageMs = Date.now() - t;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

export class RagtimeRetriever {
  private store: IMemoryStore;
  private embedder: IEmbedder;
  private cfg: Required<RagtimeConfig>;

  constructor(opts: { store: IMemoryStore; embedder: IEmbedder; config?: RagtimeConfig }) {
    this.store = opts.store;
    this.embedder = opts.embedder;
    this.cfg = {
      poolSize: opts.config?.poolSize ?? 20,
      finalK: opts.config?.finalK ?? 10,
      alpha: opts.config?.alpha ?? 0.6,
      beta: opts.config?.beta ?? 0.2,
      gamma: opts.config?.gamma ?? 0.2,
      halfLifeMs: opts.config?.halfLifeMs ?? 7 * 24 * 60 * 60 * 1000,
    };
  }

  async retrieve(
    query: string,
    limit: number,
    filter?: Record<string, unknown>,
  ): Promise<IMemoryEntry[]> {
    // Stage 1: embed + cosine recall
    const queryEmbedding = await this.embedder.embed(query);
    const pool = await this.store.search(queryEmbedding, this.cfg.poolSize, filter);

    if (pool.length === 0) return [];

    // Stage 2: composite rerank
    const { alpha, beta, gamma, halfLifeMs, finalK } = this.cfg;
    const k = Math.min(limit, finalK);

    const scored = pool.map((entry) => {
      const relevance = entry.embedding
        ? (cosineSim(queryEmbedding, entry.embedding) + 1) / 2
        : 0.5;
      const importance = Math.max(0, Math.min(1, entry.importance ?? 0.5));
      const recency = recencyDecay(entry, halfLifeMs);
      const score = alpha * relevance + beta * importance + gamma * recency;
      return { entry, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map((s) => s.entry);
  }
}
