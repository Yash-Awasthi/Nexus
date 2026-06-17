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

// ─────────────────────────────────────────────────────────────────────────────
// ADDITIONS — from infiniflow/ragflow (rag/nlp/search.py + rag/flow/chunker/ +
//   rag/advanced_rag/tree_structured_query_decomposition_retrieval.py)
//
// Fills the gap between "@nexus/doc-pipeline documents ingested" and
// "@nexus/ragtime high-precision retrieval". ragflow covers:
//   1. Chunking strategy taxonomy
//   2. Typed RetrievalResult with document-level aggregation
//   3. Citation insertion into LLM output
//   4. Hybrid token + vector similarity
//   5. Multi-source retrieval (kb + kg + web) with deduplication
//   6. Tree-structured query decomposition for multi-hop questions
// ─────────────────────────────────────────────────────────────────────────────

// ── Chunking strategy taxonomy (ragflow flow/chunker patterns) ────────────────
//
// Ref: ragflow/rag/flow/chunker/token_chunker.py TokenChunkerParam.delimiter_mode
//   + ragflow/rag/flow/chunker/title_chunker/title_chunker.py

/**
 * How text is divided into retrieval chunks.
 * Determines chunk boundary detection strategy.
 */
export type ChunkingStrategy =
  | "token"        // Fixed token count windows (default 512 tokens)
  | "delimiter"    // Split on sentence/paragraph delimiters
  | "paragraph"    // Paragraph boundaries (double newlines)
  | "title"        // Document section headings (H1/H2/H3 boundaries)
  | "one"          // Entire document as a single chunk (for short docs)
  | "code"         // Code block boundaries (function/class level)
  | "qa";          // Q&A pair extraction (question → answer chunks)

/** Configuration for a chunking pass */
export interface ChunkingConfig {
  strategy: ChunkingStrategy;
  /** Target chunk size in tokens (default: 512) */
  chunkTokenSize?: number;
  /** Overlap between adjacent chunks as fraction of chunkTokenSize (default: 0) */
  overlapFraction?: number;
  /** Delimiters to split on when strategy="delimiter" */
  delimiters?: string[];
  /** Whether to include table context in surrounding chunks */
  tableContextSize?: number;
}

/** A text chunk with full source provenance */
export interface RagChunk {
  /** Unique chunk identifier (deterministic: sha256(docId + offset)) */
  id: string;
  /** Source document ID */
  docId: string;
  /** Source document name / title */
  docName?: string;
  /** Source URL or file path */
  docSource?: string;
  /** Chunk text content */
  text: string;
  /** Character offset within the source document */
  offset?: number;
  /** Page number (1-based) for PDF/document sources */
  page?: number;
  /** Section heading path (e.g. ["Introduction", "Background"]) */
  headingPath?: string[];
  /** Pre-computed embedding (may be populated lazily) */
  embedding?: number[];
  /** Chunk creation timestamp (unix ms) */
  createdAt?: number;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

// ── Document-level aggregation (ragflow doc_aggs pattern) ─────────────────────
//
// Ref: ragflow/rag/nlp/search.py Dealer.ranks() → ranks["doc_aggs"]
// Chunks retrieved from a query are grouped by source document so callers can
// surface "found in 3 documents" context and de-duplicate citations.

/** Document-level aggregate of retrieved chunks */
export interface DocAggregate {
  /** Source document ID */
  docId: string;
  /** Document name / title */
  docName?: string;
  /** Number of chunks retrieved from this document */
  chunkCount: number;
  /** Highest similarity score among chunks from this document */
  topScore: number;
}

/** Typed retrieval result from a RAG query */
export interface RetrievalResult {
  /** Total chunks available before top-K truncation */
  total: number;
  /** Retrieved and reranked chunks, sorted by score descending */
  chunks: Array<RagChunk & { score: number }>;
  /** Per-document chunk aggregates for citation context */
  docAggs: DocAggregate[];
}

/**
 * Build DocAggregate[] from a list of scored chunks.
 * Groups by docId, counts chunks, takes max score.
 *
 * Ref: ragflow/rag/nlp/search.py ranks["doc_aggs"] assembly
 */
export function buildDocAggregates(
  chunks: Array<RagChunk & { score: number }>,
): DocAggregate[] {
  const byDoc = new Map<string, DocAggregate>();

  for (const chunk of chunks) {
    const existing = byDoc.get(chunk.docId);
    if (existing) {
      existing.chunkCount++;
      if (chunk.score > existing.topScore) existing.topScore = chunk.score;
    } else {
      byDoc.set(chunk.docId, {
        docId: chunk.docId,
        docName: chunk.docName,
        chunkCount: 1,
        topScore: chunk.score,
      });
    }
  }

  return Array.from(byDoc.values()).sort((a, b) => b.topScore - a.topScore);
}

// ── Hybrid similarity (ragflow token + vector blend) ─────────────────────────
//
// Ref: ragflow/rag/nlp/search.py Dealer.rerank()
//   tkweight=0.3, vtweight=0.7
//   sim = tkweight × tokenSimilarity + vtweight × vectorCosineSim

/**
 * Compute hybrid similarity: token overlap (BM25-style Jaccard) + vector cosine.
 *
 * Both scores are [0, 1]. tokenWeight + vectorWeight should sum to 1.0.
 *
 * Ref: ragflow/rag/nlp/search.py hybrid_similarity (tkweight=0.3, vtweight=0.7)
 *
 * @param queryTokens   Lowercase tokenized query terms
 * @param chunkTokens   Lowercase tokenized chunk terms
 * @param queryVec      Query embedding vector
 * @param chunkVec      Chunk embedding vector
 * @param tokenWeight   Weight for token similarity (default: 0.3)
 * @param vectorWeight  Weight for vector cosine similarity (default: 0.7)
 */
export function hybridSimilarity(
  queryTokens: string[],
  chunkTokens: string[],
  queryVec: number[],
  chunkVec: number[],
  tokenWeight = 0.3,
  vectorWeight = 0.7,
): number {
  // Token overlap: Jaccard(queryTokens ∩ chunkTokens)
  const qSet = new Set(queryTokens);
  const cSet = new Set(chunkTokens);
  const intersection = new Set([...qSet].filter((t) => cSet.has(t)));
  const union = new Set([...qSet, ...cSet]);
  const tokenSim = union.size > 0 ? intersection.size / union.size : 0;

  // Vector cosine
  let dot = 0, magQ = 0, magC = 0;
  const len = Math.min(queryVec.length, chunkVec.length);
  for (let i = 0; i < len; i++) {
    dot += queryVec[i]! * chunkVec[i]!;
    magQ += queryVec[i]! * queryVec[i]!;
    magC += chunkVec[i]! * chunkVec[i]!;
  }
  const vecSim = (magQ > 0 && magC > 0) ? dot / (Math.sqrt(magQ) * Math.sqrt(magC)) : 0;

  return tokenWeight * tokenSim + vectorWeight * vecSim;
}

// ── Citation insertion (ragflow insert_citations pattern) ─────────────────────
//
// Ref: ragflow/rag/nlp/search.py Dealer.insert_citations()
//   Splits LLM answer text into sentences, embeds each sentence,
//   computes cosine similarity with retrieved chunk embeddings,
//   inserts [ID:X] citation markers at sentence boundaries.
//
// This TypeScript port uses an injectable embedder and the hybridSimilarity
// function above. No rag_tokenizer dep — uses simple whitespace tokenization.

/** A citation reference attached to a sentence in LLM output */
export interface Citation {
  /** Sentence index in the answer (0-based) */
  sentenceIndex: number;
  /** Chunk IDs that support this sentence */
  chunkIds: string[];
  /** Similarity score of the best-matching chunk */
  bestScore: number;
}

/** Result of insertCitations() */
export interface CitationResult {
  /** The answer text with [ID:chunkId] markers inserted after sentences */
  annotatedText: string;
  /** Structured citation list for programmatic use */
  citations: Citation[];
  /** Set of all cited chunk IDs */
  citedChunkIds: Set<string>;
}

/**
 * Insert citation markers into LLM-generated answer text.
 *
 * Algorithm:
 *   1. Split answer into sentences (period/question/exclamation boundaries)
 *   2. For each sentence: compute hybridSimilarity against each retrieved chunk
 *   3. Insert "[ID:chunkId]" markers after sentences that match (score ≥ threshold)
 *   4. Threshold starts at 0.63 and decays × 0.8 until at least one citation found
 *
 * Ref: ragflow/rag/nlp/search.py insert_citations() hybrid similarity + threshold decay
 *
 * @param answer      The LLM-generated answer text
 * @param chunks      Retrieved RagChunk records (must have `.text` and `.id`)
 * @param chunkEmbeddings  Pre-computed embeddings for each chunk (same order as chunks)
 * @param embedFn     Injectable embedder: (texts: string[]) → Promise<number[][]>
 * @param opts        Threshold and weight config
 */
export async function insertCitations(
  answer: string,
  chunks: RagChunk[],
  chunkEmbeddings: number[][],
  embedFn: (texts: string[]) => Promise<number[][]>,
  opts: {
    tokenWeight?: number;
    vectorWeight?: number;
    initialThreshold?: number;
    thresholdDecay?: number;
    maxCitationsPerSentence?: number;
  } = {},
): Promise<CitationResult> {
  if (!answer || chunks.length === 0 || chunkEmbeddings.length === 0) {
    return { annotatedText: answer, citations: [], citedChunkIds: new Set() };
  }

  const tokenWeight = opts.tokenWeight ?? 0.1;
  const vectorWeight = opts.vectorWeight ?? 0.9;
  const initialThreshold = opts.initialThreshold ?? 0.63;
  const thresholdDecay = opts.thresholdDecay ?? 0.8;
  const maxCitesPerSentence = opts.maxCitationsPerSentence ?? 4;

  // Split answer into sentences (simple boundary detection)
  const rawSentences = answer.split(/(?<=[.?!;\n])\s+/);
  const sentences = rawSentences.filter((s) => s.trim().length >= 5);

  if (sentences.length === 0) {
    return { annotatedText: answer, citations: [], citedChunkIds: new Set() };
  }

  // Embed all sentences at once
  let sentenceEmbeddings: number[][];
  try {
    sentenceEmbeddings = await embedFn(sentences);
  } catch {
    return { annotatedText: answer, citations: [], citedChunkIds: new Set() };
  }

  // Precompute chunk token sets
  const chunkTokenSets = chunks.map((c) =>
    new Set(c.text.toLowerCase().split(/\s+/).filter((t) => t.length > 1)),
  );

  // Find citations with threshold decay
  let threshold = initialThreshold;
  const citationMap = new Map<number, string[]>(); // sentenceIdx → chunkIds

  while (threshold > 0.3 && citationMap.size === 0) {
    for (let si = 0; si < sentences.length; si++) {
      const sentVec = sentenceEmbeddings[si];
      if (!sentVec) continue;

      const sentTokens = sentences[si]!.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
      const matchingChunks: Array<{ chunkId: string; score: number }> = [];

      for (let ci = 0; ci < chunks.length; ci++) {
        const chunkVec = chunkEmbeddings[ci];
        const chunkTokens = Array.from(chunkTokenSets[ci] ?? []);
        if (!chunkVec) continue;

        const score = hybridSimilarity(sentTokens, chunkTokens, sentVec, chunkVec, tokenWeight, vectorWeight);

        if (score >= threshold * 0.99) {
          matchingChunks.push({ chunkId: chunks[ci]!.id, score });
        }
      }

      if (matchingChunks.length > 0) {
        matchingChunks.sort((a, b) => b.score - a.score);
        citationMap.set(si, matchingChunks.slice(0, maxCitesPerSentence).map((m) => m.chunkId));
      }
    }
    threshold *= thresholdDecay;
  }

  // Build structured citations
  const citedChunkIds = new Set<string>();
  const citations: Citation[] = [];

  for (const [si, chunkIds] of citationMap) {
    for (const id of chunkIds) citedChunkIds.add(id);
    const bestScore = 0; // score already filtered above
    citations.push({ sentenceIndex: si, chunkIds, bestScore });
  }

  // Reassemble annotated text
  const parts: string[] = [];
  for (let si = 0; si < sentences.length; si++) {
    parts.push(sentences[si]!);
    const cites = citationMap.get(si);
    if (cites) {
      for (const id of cites) parts.push(` [ID:${id}]`);
    }
  }

  return {
    annotatedText: parts.join(" "),
    citations,
    citedChunkIds,
  };
}

// ── Multi-source retrieval (ragflow kb + kg + web pattern) ────────────────────
//
// Ref: ragflow/rag/advanced_rag/tree_structured_query_decomposition_retrieval.py
//   _retrieve_information() combines kb + kg + web retrieval sources

/** Where a retrieved chunk came from */
export type RetrievalSource = "knowledge_base" | "knowledge_graph" | "web";

/** A scored chunk with source label */
export interface ScoredChunk extends RagChunk {
  score: number;
  source: RetrievalSource;
}

/** Multi-source retriever function type — injectable, one per source */
export type SourceRetrieverFn = (
  query: string,
  limit: number,
) => Promise<ScoredChunk[]>;

/**
 * Retrieve from multiple sources concurrently and merge results.
 *
 * Runs all provided source retrievers in parallel (Promise.allSettled —
 * one failing source never blocks others). Deduplicates by chunk ID,
 * keeping the highest score per chunk. Returns sorted by score descending.
 *
 * Ref: ragflow TreeStructuredQueryDecompositionRetrieval._retrieve_information()
 *   kb_retrieve + kg_retrieve + web_retrieve parallel pattern
 *
 * @param query    Search query
 * @param sources  Map of source name → retriever function
 * @param limit    Max chunks per source (total limit = sources.size × limit)
 */
export async function multiSourceRetrieve(
  query: string,
  sources: Map<RetrievalSource, SourceRetrieverFn>,
  limit = 10,
): Promise<ScoredChunk[]> {
  const settled = await Promise.allSettled(
    Array.from(sources.entries()).map(([, fn]) => fn(query, limit)),
  );

  // Merge by chunk id, keep highest score
  const merged = new Map<string, ScoredChunk>();
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    for (const chunk of s.value) {
      const existing = merged.get(chunk.id);
      if (!existing || chunk.score > existing.score) {
        merged.set(chunk.id, chunk);
      }
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

// ── Tree-structured query decomposition (ragflow advanced RAG pattern) ────────
//
// Ref: ragflow/rag/advanced_rag/tree_structured_query_decomposition_retrieval.py
//   research() → _research() tree traversal with sufficiency check
//
// For multi-hop questions ("What are the implications of X for Y?"),
// a single retrieval pass returns poor results. Query decomposition breaks
// the question into sub-questions, retrieves for each, checks sufficiency,
// and merges results — up to `maxDepth` recursion.

/** Injectable sub-query generator: given a parent query → sub-queries */
export type QueryDecomposer = (query: string) => Promise<string[]>;

/** Injectable sufficiency checker: given retrieved chunks → is the answer sufficient? */
export type SufficiencyChecker = (
  query: string,
  chunks: ScoredChunk[],
) => Promise<boolean>;

/** No-op decomposer — returns the query unchanged (single-hop) */
export const nullQueryDecomposer: QueryDecomposer = async (q) => [q];

/** Always-sufficient checker — stops after first retrieval pass */
export const alwaysSufficientChecker: SufficiencyChecker = async () => true;

/** Options for tree-structured decomposition retrieval */
export interface DecompositionRetrievalOptions {
  /** Maximum decomposition depth (default: 3) */
  maxDepth?: number;
  /** Max chunks per sub-query (default: 10) */
  limitPerQuery?: number;
  /** LLM-based sufficiency check (default: alwaysSufficientChecker) */
  sufficiencyCheck?: SufficiencyChecker;
}

/**
 * Tree-structured query decomposition retrieval.
 *
 * Recursively decomposes a query into sub-questions, retrieves for each,
 * and merges results. Stops when: (a) sufficiency check passes, (b) maxDepth
 * reached, or (c) no new sub-queries generated.
 *
 * Ref: ragflow TreeStructuredQueryDecompositionRetrieval.research()
 *   depth-limited recursion with sufficiency_check + multi_queries_gen
 *
 * @param query      Root question
 * @param retriever  Function to retrieve chunks for a single query
 * @param decomposer Injectable query decomposer
 * @param opts       Depth and limit config
 */
export async function decompositionRetrieve(
  query: string,
  retriever: SourceRetrieverFn,
  decomposer: QueryDecomposer = nullQueryDecomposer,
  opts: DecompositionRetrievalOptions = {},
): Promise<RetrievalResult> {
  const maxDepth = opts.maxDepth ?? 3;
  const limitPerQuery = opts.limitPerQuery ?? 10;
  const sufficiencyCheck = opts.sufficiencyCheck ?? alwaysSufficientChecker;

  const allChunks = new Map<string, ScoredChunk>();

  async function recurse(q: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    const results = await retriever(q, limitPerQuery);

    // Merge: keep highest score per chunk id
    for (const chunk of results) {
      const existing = allChunks.get(chunk.id);
      if (!existing || chunk.score > existing.score) allChunks.set(chunk.id, chunk);
    }

    const collected = Array.from(allChunks.values());

    // Check sufficiency — stop if answer is complete
    const isSufficient = await sufficiencyCheck(q, collected);
    if (isSufficient) return;

    // Decompose into sub-queries and recurse (Promise.allSettled)
    const subQueries = await decomposer(q);
    const newQueries = subQueries.filter((sq) => sq !== q && sq.trim().length > 0);
    if (newQueries.length === 0) return;

    await Promise.allSettled(newQueries.map((sq) => recurse(sq, depth + 1)));
  }

  await recurse(query, 0);

  const sortedChunks = Array.from(allChunks.values()).sort((a, b) => b.score - a.score);
  const docAggs = buildDocAggregates(sortedChunks);

  return {
    total: sortedChunks.length,
    chunks: sortedChunks,
    docAggs,
  };
}

// ── Onyx Search Pipeline Patterns ────────────────────────────────────────────
// Extracted from: onyx-dot-app/onyx-foss backend/onyx/context/search/
// Covers: hybrid search with alpha gating, query expansion, ACL filters,
// recency bias, chunk accumulation with section-level buffers.

/** Primary search modality. */
export type SearchType = "keyword" | "semantic" | "internet";

/** Ranking profile selector for hybrid search (maps to Vespa ranking profile names). */
export type QueryType = "keyword" | "semantic";

/**
 * Recency bias applied to search ranking.
 * FAVOR_RECENT doubles the time-decay rate. AUTO infers from query intent.
 */
export type RecencyBiasSetting = "favor_recent" | "base_decay" | "no_decay" | "auto";

/** Dual-path query expansion result from an LLM pre-processing step. */
export interface QueryExpansions {
  /** Alternate keyword phrasings for BM25 retrieval. */
  keywordsExpansions?: string[];
  /** Semantically equivalent phrasings for embedding retrieval. */
  semanticExpansions?: string[];
}

/** Which expansion path to use when constructing the query fanout. */
export type QueryExpansionType = "keyword" | "semantic";

/** Tag filter attached to a search request. */
export interface SearchTag {
  tagKey: string;
  tagValue: string;
}

/** User-supplied pre-filter applied before vector retrieval. */
export interface SearchBaseFilters {
  /** Restrict to specific connector/source types (e.g. "web", "gmail", "github"). */
  sourceType?: string[];
  /** Restrict to named document sets. */
  documentSet?: string[];
  /** Exclude documents updated before this timestamp. */
  timeCutoff?: string;
  tags?: SearchTag[];
}

/**
 * ACL-augmented filters merged with user-supplied filters.
 * access_control_list encodes per-user and per-group permissions.
 * Set null to bypass ACL (system callers only).
 */
export interface SearchIndexFilters extends SearchBaseFilters {
  accessControlList: string[] | null;
  tenantId?: string;
  /** Scope to user files associated with a specific project. */
  projectIdFilter?: number;
  /** Scope to user files associated with a specific persona/assistant. */
  personaIdFilter?: number;
  /** Scope to document IDs explicitly attached to an assistant. */
  attachedDocumentIds?: string[];
  /** Scope to hierarchy node IDs (folders/spaces) attached to an assistant. */
  hierarchyNodeIds?: number[];
}

/**
 * Core search request parameters.
 * hybrid_alpha controls the keyword/semantic trade-off:
 *   ≤ 0.2 → QueryType.KEYWORD (BM25-dominant)
 *   > 0.2 → QueryType.SEMANTIC (embedding-dominant)
 */
export interface BasicChunkRequest {
  query: string;
  /** Hybrid alpha in [0, 1]. Default 0.5. Values ≤ 0.2 force keyword mode. */
  hybridAlpha?: number;
  /** Multiplier applied to time-decay score. Default 1.0. */
  recencyBiasMultiplier?: number;
  limit?: number;
}

/** Full search request with ACL-resolved index filters. */
export interface ChunkSearchRequest extends BasicChunkRequest {
  filters?: SearchBaseFilters;
  bypassAcl?: boolean;
}

/**
 * Resolve QueryType from hybrid alpha.
 * Mirrors Onyx: alpha ≤ 0.2 → keyword, else semantic.
 */
export function resolveQueryType(hybridAlpha?: number): QueryType {
  return (hybridAlpha ?? 0.5) <= 0.2 ? "keyword" : "semantic";
}

/** Cross-section text accumulator threaded through chunk builders. */
export interface AccumulatorState {
  /** Concatenated text from all sections accumulated so far. */
  text: string;
  /** Map of character offset → source URL for link attribution. */
  linkOffsets: Record<number, string>;
}

/** Creates an empty AccumulatorState. */
export function emptyAccumulator(): AccumulatorState {
  return { text: "", linkOffsets: {} };
}

/** Returns true if the accumulator has no meaningful content. */
export function isAccumulatorEmpty(acc: AccumulatorState): boolean {
  return !acc.text.trim();
}

/**
 * Section-local chunk content before document-scoped fields are attached.
 * The orchestrator upgrades these to full chunks via toDocAwareChunk().
 */
export interface ChunkPayload {
  text: string;
  /** Character offset → link URL map for inline source attribution. */
  links: Record<number, string>;
  /** True if this chunk is a continuation of the previous (oversize section split). */
  isContinuation?: boolean;
  /** Reference to an attached image (file ID). */
  imageFileId?: string | null;
}

/**
 * Merge a new section into an accumulator.
 * If the merged size exceeds `tokenLimit`, flushes the buffer and starts fresh.
 * Returns the updated accumulator and any flushed ChunkPayloads.
 *
 * @param acc - current accumulator state
 * @param sectionText - text of the incoming section
 * @param sectionLink - source URL for the incoming section
 * @param tokenLimit - max tokens per chunk (rough char estimate: tokens × 4)
 * @param sectionSeparator - separator injected between sections (default "\n\n")
 */
export function accumulateSection(
  acc: AccumulatorState,
  sectionText: string,
  sectionLink: string,
  tokenLimit: number,
  sectionSeparator = "\n\n",
): { accumulator: AccumulatorState; flushed: ChunkPayload[] } {
  const charLimit = tokenLimit * 4; // rough chars-per-token estimate
  const merged = acc.text ? acc.text + sectionSeparator + sectionText : sectionText;

  if (merged.length <= charLimit) {
    const offset = acc.text.length + (acc.text ? sectionSeparator.length : 0);
    return {
      accumulator: {
        text: merged,
        linkOffsets: { ...acc.linkOffsets, [offset]: sectionLink },
      },
      flushed: [],
    };
  }

  // Doesn't fit: flush current buffer and start fresh with this section
  const flushed: ChunkPayload[] = acc.text
    ? [{ text: acc.text, links: acc.linkOffsets }]
    : [];

  return {
    accumulator: { text: sectionText, linkOffsets: { 0: sectionLink } },
    flushed,
  };
}

/**
 * Flush the accumulator to a ChunkPayload (call at end of document).
 * Returns null if the accumulator is empty.
 */
export function flushAccumulator(acc: AccumulatorState): ChunkPayload | null {
  if (isAccumulatorEmpty(acc)) return null;
  return { text: acc.text, links: acc.linkOffsets };
}

/**
 * Combine multiple retrieval result sets, deduplicating by (documentId, chunkId).
 * When duplicates exist, keeps the entry with the highest score.
 * Mirrors Onyx's combine_retrieval_results() in search_runner.py.
 */
export function combineRetrievalResults<T extends { documentId: string; chunkId: number; score?: number }>(
  chunkSets: T[][],
): T[] {
  const unique = new Map<string, T>();
  for (const set of chunkSets) {
    for (const chunk of set) {
      const key = `${chunk.documentId}:${chunk.chunkId}`;
      const existing = unique.get(key);
      if (!existing || (chunk.score ?? 0) > (existing.score ?? 0)) {
        unique.set(key, chunk);
      }
    }
  }
  return Array.from(unique.values()).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
