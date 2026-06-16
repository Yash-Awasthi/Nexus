// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/reranker — Cross-encoder reranker for RAG precision improvement.
 *
 * Performs a reranking pass after initial vector + BM25 retrieval to dramatically
 * improve the final ranked list quality.
 *
 * Implementations
 * ───────────────
 *   BM25Reranker      — Pure BM25 scoring, zero deps, production-ready for text corpora
 *   FunctionReranker  — Inject any (query, doc) → score function
 *   NullReranker      — Pass-through (preserves original order), useful for testing
 *
 * Usage
 * ─────
 * ```ts
 * import { BM25Reranker } from "@nexus/reranker";
 * const reranker = new BM25Reranker();
 * const result = await reranker.rerank("authentication bug", documents, { topK: 5 });
 * ```
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RankedDocument {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/** Rerank options interface definition. */
export interface RerankOptions {
  /** Return only the top-K documents. Default: all. */
  topK?: number;
  /** Minimum score threshold — documents below are excluded. Default: 0. */
  scoreThreshold?: number;
}

/** Reranker result interface definition. */
export interface RerankerResult {
  documents: RankedDocument[];
  durationMs: number;
  rerankedAt: number;
}

/** Reranker interface definition. */
export interface Reranker {
  rerank(query: string, documents: RankedDocument[], opts?: RerankOptions): Promise<RerankerResult>;
}

// ── BM25 internals ────────────────────────────────────────────────────────────

const BM25_K1 = 1.5;
const BM25_B = 0.75;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function idf(term: string, corpus: string[][]): number {
  const df = corpus.filter((doc) => doc.includes(term)).length;
  return Math.log((corpus.length - df + 0.5) / (df + 0.5) + 1);
}

function bm25Score(
  queryTerms: string[],
  docTerms: string[],
  avgDocLen: number,
  corpus: string[][],
): number {
  const tf = new Map<string, number>();
  for (const t of docTerms) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  for (const term of new Set(queryTerms)) {
    const termTf = tf.get(term) ?? 0;
    if (termTf === 0) continue;
    const termIdf = idf(term, corpus);
    const num = termTf * (BM25_K1 + 1);
    const den = termTf + BM25_K1 * (1 - BM25_B + BM25_B * (docTerms.length / avgDocLen));
    score += termIdf * (num / den);
  }
  return score;
}

// ── BM25Reranker ──────────────────────────────────────────────────────────────

/** BM25-based cross-encoder reranker. Zero runtime dependencies. */
export class BM25Reranker implements Reranker {
  async rerank(
    query: string,
    documents: RankedDocument[],
    opts?: RerankOptions,
  ): Promise<RerankerResult> {
    const start = Date.now();
    const { topK, scoreThreshold = 0 } = opts ?? {};

    if (documents.length === 0) {
      return { documents: [], durationMs: 0, rerankedAt: start };
    }

    const queryTokens = tokenize(query);
    const docTokens = documents.map((d) => tokenize(d.text));
    const avgLen = docTokens.reduce((s, d) => s + d.length, 0) / docTokens.length;

    const rawScores = documents.map((doc, i) =>
      bm25Score(queryTokens, docTokens[i]!, avgLen, docTokens),
    );
    const maxScore = Math.max(...rawScores, 1e-9);

    let scored: RankedDocument[] = documents.map((doc, i) => ({
      ...doc,
      score: rawScores[i]! / maxScore,
    }));

    scored = scored.filter((d) => d.score >= scoreThreshold).sort((a, b) => b.score - a.score);

    if (topK !== undefined) scored = scored.slice(0, topK);

    return { documents: scored, durationMs: Date.now() - start, rerankedAt: start };
  }
}

// ── FunctionReranker ──────────────────────────────────────────────────────────

export type ScoringFn = (query: string, doc: string) => number;

/** Wraps any (query, doc) → number function as a Reranker. */
export class FunctionReranker implements Reranker {
  constructor(private readonly fn: ScoringFn) {}

  async rerank(
    query: string,
    documents: RankedDocument[],
    opts?: RerankOptions,
  ): Promise<RerankerResult> {
    const start = Date.now();
    const { topK, scoreThreshold = 0 } = opts ?? {};

    let scored: RankedDocument[] = documents
      .map((doc) => ({ ...doc, score: this.fn(query, doc.text) }))
      .filter((d) => d.score >= scoreThreshold)
      .sort((a, b) => b.score - a.score);

    if (topK !== undefined) scored = scored.slice(0, topK);

    return { documents: scored, durationMs: Date.now() - start, rerankedAt: start };
  }
}

// ── NullReranker ──────────────────────────────────────────────────────────────

/** Pass-through reranker — preserves original order. Useful as a no-op stub. */
export class NullReranker implements Reranker {
  async rerank(
    _query: string,
    documents: RankedDocument[],
    opts?: RerankOptions,
  ): Promise<RerankerResult> {
    const start = Date.now();
    const result = opts?.topK !== undefined ? documents.slice(0, opts.topK) : [...documents];
    return { documents: result, durationMs: 0, rerankedAt: start };
  }
}

// ── Pipeline helper ───────────────────────────────────────────────────────────

/**
 * Run a pipeline: initial results → reranker → topK.
 * Converts raw search results (id + score) into RankedDocument shape by looking
 * up text via the provided textFn.
 */
export async function rerankPipeline(
  query: string,
  initialResults: { id: string; score: number }[],
  textFn: (id: string) => string,
  reranker: Reranker,
  opts?: RerankOptions,
): Promise<RerankerResult> {
  const docs: RankedDocument[] = initialResults.map((r) => ({
    id: r.id,
    text: textFn(r.id),
    score: r.score,
  }));
  return reranker.rerank(query, docs, opts);
}
