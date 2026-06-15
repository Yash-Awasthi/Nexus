// SPDX-License-Identifier: Apache-2.0

// ── Document types ────────────────────────────────────────────────────────────

export interface IDocument {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

/** Search result interface definition. */
export interface SearchResult {
  id: string;
  score: number;
  text: string;
  metadata?: Record<string, unknown>;
}

/** Search opts interface definition. */
export interface SearchOpts {
  /** Number of results to return (default: 10). */
  k?: number;
  /** Minimum score threshold; results below this are excluded. */
  minScore?: number;
}

// ── IFullTextIndex ────────────────────────────────────────────────────────────

export interface IFullTextIndex {
  index(doc: IDocument): void;
  remove(id: string): boolean;
  search(query: string, opts?: SearchOpts): SearchResult[];
  size(): number;
}

// ── Text tokenizer ────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// ── BM25Index ─────────────────────────────────────────────────────────────────

interface BM25DocEntry {
  doc: IDocument;
  termFreqs: Map<string, number>;
  length: number;
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** Bm25 index. */
export class BM25Index implements IFullTextIndex {
  private readonly _docs = new Map<string, BM25DocEntry>();
  /** doc frequency: term → number of docs containing it */
  private readonly _df = new Map<string, number>();
  private _totalLength = 0;

  index(doc: IDocument): void {
    // Remove previous entry if re-indexing same id
    if (this._docs.has(doc.id)) this.remove(doc.id);

    const tokens = tokenize(doc.text);
    const termFreqs = new Map<string, number>();

    for (const tok of tokens) {
      termFreqs.set(tok, (termFreqs.get(tok) ?? 0) + 1);
    }

    // Update document frequencies
    for (const term of termFreqs.keys()) {
      this._df.set(term, (this._df.get(term) ?? 0) + 1);
    }

    this._totalLength += tokens.length;
    this._docs.set(doc.id, { doc, termFreqs, length: tokens.length });
  }

  remove(id: string): boolean {
    const entry = this._docs.get(id);
    if (!entry) return false;

    // Update document frequencies
    for (const term of entry.termFreqs.keys()) {
      const df = (this._df.get(term) ?? 0) - 1;
      if (df <= 0) this._df.delete(term);
      else this._df.set(term, df);
    }

    this._totalLength -= entry.length;
    this._docs.delete(id);
    return true;
  }

  search(query: string, opts: SearchOpts = {}): SearchResult[] {
    const k = opts.k ?? 10;
    const minScore = opts.minScore ?? 0;
    const queryTerms = tokenize(query);
    if (!queryTerms.length || !this._docs.size) return [];

    const N = this._docs.size;
    const avgdl = this._totalLength / N;

    const scored: { id: string; score: number }[] = [];

    for (const [id, entry] of this._docs) {
      let score = 0;
      for (const term of queryTerms) {
        const tf = entry.termFreqs.get(term) ?? 0;
        if (tf === 0) continue;
        const df = this._df.get(term) ?? 0;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        const norm =
          (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * entry.length) / avgdl));
        score += idf * norm;
      }
      if (score > minScore) scored.push({ id, score });
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, k).map(({ id, score }) => {
      const entry = this._docs.get(id)!;
      return { id, score, text: entry.doc.text, metadata: entry.doc.metadata };
    });
  }

  size(): number {
    return this._docs.size;
  }
}

// ── Vector store ──────────────────────────────────────────────────────────────

export interface VectorSearchResult {
  id: string;
  score: number;
}

/** I vector store interface definition. */
export interface IVectorStore {
  add(id: string, vector: number[]): void;
  remove(id: string): boolean;
  search(query: number[], k: number): VectorSearchResult[];
  size(): number;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** In memory vector store. */
export class InMemoryVectorStore implements IVectorStore {
  private readonly _store = new Map<string, number[]>();

  add(id: string, vector: number[]): void {
    this._store.set(id, vector);
  }

  remove(id: string): boolean {
    return this._store.delete(id);
  }

  search(query: number[], k: number): VectorSearchResult[] {
    const scored: VectorSearchResult[] = [];
    for (const [id, vec] of this._store) {
      scored.push({ id, score: cosineSimilarity(query, vec) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  size(): number {
    return this._store.size;
  }
}

// ── Reciprocal Rank Fusion ────────────────────────────────────────────────────

export type RankedList = readonly { id: string; score?: number }[];

/**
 * Reciprocal Rank Fusion (RRF) — combines multiple ranked lists.
 * @param lists  Each list is a ranked sequence of results (best first).
 * @param k      Ranking constant (default: 60). Higher = less sensitivity to top ranks.
 * @returns Merged list sorted by RRF score descending.
 */
export function reciprocalRankFusion(
  lists: RankedList[],
  k = 60,
): { id: string; score: number }[] {
  const scores = new Map<string, number>();

  for (const list of lists) {
    list.forEach((item, rank) => {
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + rank + 1));
    });
  }

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

// ── Embedder (injectable) ─────────────────────────────────────────────────────

export type EmbedFn = (text: string) => number[];

/** Null embedder — all texts map to the zero vector. For testing without a real model. */
export const nullEmbed: EmbedFn = () => [];

/** Simple hash-based deterministic embedder for tests. Not for production. */
export function hashEmbed(dims = 8): EmbedFn {
  return (text: string): number[] => {
    const vec = new Array<number>(dims).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % dims]! += text.charCodeAt(i);
    }
    // L2 normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return norm === 0 ? vec : vec.map((v) => v / norm);
  };
}

// ── HybridSearchEngine ────────────────────────────────────────────────────────

export interface HybridSearchOpts extends SearchOpts {
  /** Weight for BM25 results (0–1, default: 0.5). Combined with rrfK. */
  alpha?: number;
  /** RRF k constant (default: 60). */
  rrfK?: number;
}

/** Hybrid search engine. */
export class HybridSearchEngine {
  private readonly _docs = new Map<string, IDocument>();

  constructor(
    private readonly bm25: IFullTextIndex,
    private readonly vectors: IVectorStore,
    private readonly embed: EmbedFn,
  ) {}

  addDocument(doc: IDocument, vector?: number[]): void {
    this._docs.set(doc.id, doc);
    this.bm25.index(doc);
    const vec = vector ?? this.embed(doc.text);
    if (vec.length > 0) this.vectors.add(doc.id, vec);
  }

  removeDocument(id: string): boolean {
    if (!this._docs.has(id)) return false;
    this._docs.delete(id);
    this.bm25.remove(id);
    this.vectors.remove(id);
    return true;
  }

  /** Full-text (BM25) search only. */
  searchFTS(query: string, opts: SearchOpts = {}): SearchResult[] {
    return this.bm25.search(query, opts);
  }

  /** Vector similarity search only. */
  searchVector(query: string, opts: SearchOpts = {}): SearchResult[] {
    const k = opts.k ?? 10;
    const qvec = this.embed(query);
    if (!qvec.length) return [];
    return this.vectors.search(qvec, k).map(({ id, score }) => {
      const doc = this._docs.get(id);
      return { id, score, text: doc?.text ?? "", metadata: doc?.metadata };
    });
  }

  /** Hybrid search: BM25 + vector, fused with RRF. */
  search(query: string, opts: HybridSearchOpts = {}): SearchResult[] {
    const k = opts.k ?? 10;
    const rrfK = opts.rrfK ?? 60;

    const ftsList = this.bm25.search(query, { k: k * 3 });
    const qvec = this.embed(query);
    const vecList = qvec.length ? this.vectors.search(qvec, k * 3) : [];

    const fused = reciprocalRankFusion([ftsList, vecList], rrfK);

    return fused.slice(0, k).map(({ id, score }) => {
      const doc = this._docs.get(id);
      return { id, score, text: doc?.text ?? "", metadata: doc?.metadata };
    });
  }

  docCount(): number {
    return this._docs.size;
  }
}

// ── SearchError ───────────────────────────────────────────────────────────────

export class SearchError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "SearchError";
    this.code = code;
  }
}
