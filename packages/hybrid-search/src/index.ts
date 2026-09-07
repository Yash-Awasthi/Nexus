// SPDX-License-Identifier: Apache-2.0
import { whereMatches, whereDocumentMatches } from "@nexus/retrieval";
import type { WhereClause, WhereDocumentClause } from "@nexus/retrieval";
import type { Reranker } from "@nexus/reranker";

/**
 * @nexus/hybrid-search — Hybrid vector + BM25 search with RRF fusion.
 *
 * Run pgvector (dense) and BM25 (sparse) retrieval in parallel, merge ranked
 * lists via Reciprocal Rank Fusion (RRF), then optionally pass through a
 * cross-encoder reranker for final precision improvement.
 *
 * Architecture
 * ─────────────
 *   rrfFusion()         — core RRF merge: two ranked lists → one fused list
 *   HybridSearchEngine  — orchestrates vector search + BM25 + RRF + reranker
 *   VectorSearchAdapter — injectable interface for pgvector / embedding search
 *   BM25SearchAdapter   — injectable interface for BM25 full-text search
 *   InMemoryBM25        — pure-TS BM25 index for tests and offline mode
 *
 * RRF formula:  score(d) = Σ 1 / (k + rank(d))   where k=60 (standard)
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SearchHit {
  id: string;
  score: number;
  text?: string;
  metadata?: Record<string, unknown>;
}

/** Vector search adapter interface definition. */
export interface VectorSearchAdapter {
  search(query: string, limit: number): Promise<SearchHit[]>;
}

/** Bm25 search adapter interface definition. */
export interface BM25SearchAdapter {
  search(query: string, limit: number): Promise<SearchHit[]>;
}

/** Hybrid search options interface definition. */
export interface HybridSearchOptions {
  query: string;
  limit?: number;
  /**
   * Fusion strategy. "rrf" (default) fuses by reciprocal ranks; "alpha"
   * fuses by alpha-weighted max-normalized scores (Timescale pattern), where
   * `vectorWeight` is the dense-side alpha.
   */
  fusion?: "rrf" | "alpha";
  /** RRF k constant. Default 60. */
  k?: number;
  /** Weight for vector results in final fusion [0,1]. Default 0.5. */
  vectorWeight?: number;
  /** Weight for BM25 results. Default 0.5. */
  bm25Weight?: number;
  /**
   * Chroma/weaviate-grammar metadata filter (pass-50 @nexus/retrieval where
   * vocabulary: $eq/$ne/$gt/$gte/$lt/$lte/$in/$nin + $and/$or/$contains).
   * Applied to each leg's over-fetched candidates BEFORE fusion, mirroring
   * weaviate's hybrid single query where clause. A per-adapter index-level
   * filter would be more precise; engine-level candidate filtering is the
   * honest approximation over the fetchN over-fetch.
   */
  where?: WhereClause;
  /** Document-text filter ($contains/$not_contains) applied per leg pre-fusion. */
  whereDocument?: WhereDocumentClause;
  /**
   * Optional post-fusion rerank pass (the engine's doc comment advertises
   * RRF + reranker orchestration; this seam makes it real — pass any
   * @nexus/reranker implementation). When set, the fused candidate list is
   * reranked and cut to `limit`, mirroring weaviate's hybrid rerank tool.
   */
  reranker?: Reranker;
}

/** Hybrid search result interface definition. */
export interface HybridSearchResult {
  hits: SearchHit[];
  vectorHits: SearchHit[];
  bm25Hits: SearchHit[];
  durationMs: number;
}

// ── RRF ──────────────────────────────────────────────────────────────────────

/**
 * Reciprocal Rank Fusion.
 * Each ranked list contributes 1/(k + rank) to each document's score.
 * Optionally weight the two lists differently.
 */
export function rrfFusion(
  listA: SearchHit[],
  listB: SearchHit[],
  opts?: { k?: number; weightA?: number; weightB?: number },
): SearchHit[] {
  const k = opts?.k ?? 60;
  const wA = opts?.weightA ?? 0.5;
  const wB = opts?.weightB ?? 0.5;

  const scores = new Map<string, number>();

  listA.forEach((hit, i) => {
    scores.set(hit.id, (scores.get(hit.id) ?? 0) + wA * (1 / (k + i + 1)));
  });
  listB.forEach((hit, i) => {
    scores.set(hit.id, (scores.get(hit.id) ?? 0) + wB * (1 / (k + i + 1)));
  });

  // Merge metadata: prefer listA for same id
  const meta = new Map<string, SearchHit>();
  for (const h of [...listB, ...listA]) meta.set(h.id, h);

  return [...scores.entries()]
    .map(([id, score]) => ({ ...meta.get(id)!, id, score }))
    .sort((a, b) => b.score - a.score);
}

// ── Weighted-alpha fusion (Timescale weighted hybrid pattern) ────────────────
//
// pgvectorscale's documented hybrid search blends dense and sparse scores
// directly: each list's raw scores are max-normalized to [0, 1] and the final
// score is `alpha × dense + (1 - alpha) × sparse` per document. Unlike RRF
// (which throws away score magnitudes and keeps only reciprocal ranks), this
// keeps the actual similarity/BM25 scores so a document that strongly matches
// one side still competes. A document present in only one list contributes
// that side's normalized score only.

export interface WeightedAlphaOptions {
  /** Weight on the dense (vector) side in [0, 1]. Default 0.5. */
  alpha?: number;
  /**
   * Score normalization per list before blending. "max" (default) divides
   * each list by its own max score; "none" blends raw scores as-is.
   */
  normalize?: "max" | "none";
}

/**
 * Fuse a dense and a sparse result list by alpha-weighted normalized scores
 * (Timescale's weighted-hybrid pattern): `score = alpha × normDense +
 * (1 - alpha) × normSparse`. Sorted descending, metadata prefers the dense hit.
 */
export function weightedAlphaFusion(
  dense: SearchHit[],
  sparse: SearchHit[],
  opts: WeightedAlphaOptions = {},
): SearchHit[] {
  const alpha = opts.alpha ?? 0.5;
  const beta = 1 - alpha;
  const normalize = opts.normalize ?? "max";

  const norm = (list: SearchHit[]): Map<string, number> => {
    const scores = new Map(list.map((h) => [h.id, h.score]));
    if (normalize === "none" || scores.size === 0) return scores;
    const max = Math.max(...scores.values());
    if (max <= 0) return scores;
    for (const [id, s] of scores) scores.set(id, s / max);
    return scores;
  };

  const denseScores = norm(dense);
  const sparseScores = norm(sparse);
  const ids = new Set<string>([...denseScores.keys(), ...sparseScores.keys()]);
  const meta = new Map<string, SearchHit>();
  for (const h of [...sparse, ...dense]) meta.set(h.id, h);

  return [...ids]
    .map((id) => {
      const d = denseScores.get(id) ?? 0;
      const s = sparseScores.get(id) ?? 0;
      return { ...meta.get(id)!, id, score: alpha * d + beta * s };
    })
    .sort((a, b) => b.score - a.score);
}

// ── HybridSearchEngine ────────────────────────────────────────────────────────

export class HybridSearchEngine {
  constructor(
    private readonly vector: VectorSearchAdapter,
    private readonly bm25: BM25SearchAdapter,
  ) {}

  async search(opts: HybridSearchOptions): Promise<HybridSearchResult> {
    const { query, limit = 10, k = 60, vectorWeight = 0.5, bm25Weight = 0.5 } = opts;
    const fusion = opts.fusion ?? "rrf";
    const fetchN = limit * 3; // over-fetch before fusion
    const start = Date.now();

    const [vectorRaw, bm25Raw] = await Promise.all([
      this.vector.search(query, fetchN),
      this.bm25.search(query, fetchN),
    ]);

    const { where, whereDocument } = opts;
    const keep = (h: SearchHit): boolean =>
      (!where || whereMatches(h.metadata ?? {}, where)) &&
      (!whereDocument || whereDocumentMatches(h.text ?? "", whereDocument));
    const vectorHits = where || whereDocument ? vectorRaw.filter(keep) : vectorRaw;
    const bm25Hits = where || whereDocument ? bm25Raw.filter(keep) : bm25Raw;

    const fused =
      fusion === "alpha"
        ? weightedAlphaFusion(vectorHits, bm25Hits, { alpha: vectorWeight })
        : rrfFusion(vectorHits, bm25Hits, {
            k,
            weightA: vectorWeight,
            weightB: bm25Weight,
          });

    if (opts.reranker) {
      const ranked = fused.map((h) => ({ id: h.id, text: h.text ?? "", score: h.score, metadata: h.metadata }));
      const res = await opts.reranker.rerank(query, ranked, { topK: limit });
      return { hits: res.documents, vectorHits, bm25Hits, durationMs: Date.now() - start };
    }
    const hits = fused.slice(0, limit);

    return { hits, vectorHits, bm25Hits, durationMs: Date.now() - start };
  }
}

// ── InMemoryBM25 ──────────────────────────────────────────────────────────────

const K1 = 1.5;
const B = 0.75;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Bm25 document interface definition. */
export interface BM25Document {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

/** Pure-TS BM25 index implementing BM25SearchAdapter for tests and offline mode. */
export class InMemoryBM25 implements BM25SearchAdapter {
  private docs: BM25Document[] = [];
  private tokenized: string[][] = [];

  index(documents: BM25Document[]): void {
    this.docs = [...documents];
    this.tokenized = documents.map((d) => tokenize(d.text));
  }

  add(doc: BM25Document): void {
    this.docs.push(doc);
    this.tokenized.push(tokenize(doc.text));
  }

  async search(query: string, limit: number): Promise<SearchHit[]> {
    if (this.docs.length === 0) return [];
    const qTokens = tokenize(query);
    const avgLen = this.tokenized.reduce((s, t) => s + t.length, 0) / this.tokenized.length;

    const scored = this.docs.map((doc, i) => {
      const toks = this.tokenized[i]!;
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);

      let score = 0;
      for (const term of new Set(qTokens)) {
        const termTf = tf.get(term) ?? 0;
        if (termTf === 0) continue;
        const df = this.tokenized.filter((t) => t.includes(term)).length;
        const idf = Math.log((this.docs.length - df + 0.5) / (df + 0.5) + 1);
        const num = termTf * (K1 + 1);
        const den = termTf + K1 * (1 - B + B * (toks.length / avgLen));
        score += idf * (num / den);
      }
      return { id: doc.id, score, text: doc.text, metadata: doc.metadata };
    });

    const max = Math.max(...scored.map((s) => s.score), 1e-9);
    return scored
      .map((s) => ({ ...s, score: s.score / max }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

export { createHybridSearchMcpServer } from "./mcp-server.js";
export type { HybridSearchMcpServerOptions } from "./mcp-server.js";
