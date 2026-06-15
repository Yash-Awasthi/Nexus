// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/doc-pipeline — Document processing pipeline.
 *
 * Stages:
 *  1. Extract  — convert raw document (PDF, HTML, Markdown, plain text) to a
 *                clean UTF-8 string using an injectable Extractor.
 *  2. Chunk    — split into overlapping fixed-size windows (default 256 tokens,
 *                32-token overlap, 4 chars/token heuristic).
 *  3. Embed    — obtain a vector embedding per chunk via an injectable Embedder.
 *  4. Store    — persist embedded chunks via an injectable ChunkStore.
 *
 * All external I/O dependencies (extractor, embedder, store) are injected so
 * the core pipeline achieves full unit-test coverage without real API calls.
 *
 * Built-in extractors handle "text", "markdown", and "html" formats.
 * PDF and DOCX require a caller-provided Extractor that wraps a real parser.
 *
 * Null implementations (nullExtractor, nullEmbedder, nullStore) are exported
 * for fast test setup and local development fallback.
 *
 * Task type: "doc.ingest"
 */

import { defineAdapter, type IExecutionContext } from "@nexus/plugin-sdk";

// ── Public types ───────────────────────────────────────────────────────────────

export type DocFormat = "text" | "markdown" | "html" | "pdf" | "docx";

/** Doc input interface definition. */
export interface DocInput {
  /** Document format — drives extractor selection */
  format: DocFormat;
  /** Raw document content as a string (base64 for binary formats if needed) */
  content: string;
  /** Optional human-readable source identifier (URL, filename, etc.) */
  source?: string;
  /** Arbitrary caller-supplied metadata persisted alongside chunks */
  metadata?: Record<string, unknown>;
}

/** Chunk options interface definition. */
export interface ChunkOptions {
  /**
   * Maximum tokens per chunk (estimated at 4 chars/token).
   * Default: 256 tokens (≈ 1 024 chars).
   */
  maxTokens?: number;
  /**
   * Token overlap between consecutive chunks for context continuity.
   * Default: 32 tokens (≈ 128 chars).
   */
  overlapTokens?: number;
}

/** Text chunk interface definition. */
export interface TextChunk {
  /** Zero-based chunk index within the document */
  index: number;
  /** The chunk text */
  text: string;
  /** Estimated token count (ceil(text.length / 4)) */
  tokenEstimate: number;
}

/** Embedding type alias. */
export type Embedding = number[];

/** Embedded chunk interface definition. */
export interface EmbeddedChunk extends TextChunk {
  embedding: Embedding;
}

/** Doc meta interface definition. */
export interface DocMeta {
  source?: string;
  format: DocFormat;
  totalChunks: number;
  processedAt: string;
  metadata?: Record<string, unknown>;
}

/** Store result interface definition. */
export interface StoreResult {
  /** IDs assigned to the stored chunks (one per chunk, in order) */
  ids: string[];
  /** Total chunks stored (may differ from ids.length if batching skips) */
  count: number;
}

/** Pipeline result interface definition. */
export interface PipelineResult {
  source?: string;
  format: DocFormat;
  /** Byte length of the extracted plain text */
  rawTextLength: number;
  /** Number of chunks produced by the chunker */
  chunks: number;
  /** Number of chunks that were embedded (same as chunks unless embedder skips) */
  embedded: number;
  /** Result returned by the store */
  storeResult: StoreResult;
  /** Wall-clock pipeline duration in milliseconds */
  durationMs: number;
}

// ── Injectable interfaces ──────────────────────────────────────────────────────

/**
 * Converts raw document content into a clean UTF-8 plain-text string.
 *
 * Implementations for PDF require a real parser (e.g. pdf-parse).
 * Built-in: "text", "markdown" (pass-through), "html" (tag stripping).
 */
export type Extractor = (format: DocFormat, content: string) => Promise<string>;

/**
 * Converts an array of text strings to dense vector embeddings.
 *
 * Texts are batched to allow efficient API calls.
 * Must return an array of the same length as `texts`.
 */
export type Embedder = (texts: string[]) => Promise<Embedding[]>;

/**
 * Persists embedded chunks alongside document metadata.
 */
export interface ChunkStore {
  save(chunks: EmbeddedChunk[], meta: DocMeta): Promise<StoreResult>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_OVERLAP_TOKENS = 32;

/**
 * Characters-per-token heuristic (same as context-pack estimator).
 * Matches cl100k_base approximate average for English prose.
 */
const CHARS_PER_TOKEN = 4;

export { DEFAULT_MAX_TOKENS, DEFAULT_OVERLAP_TOKENS, CHARS_PER_TOKEN };

// ── Token estimation ──────────────────────────────────────────────────────────

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ── HTML text extraction ───────────────────────────────────────────────────────

/**
 * Lightweight HTML → plain-text converter.
 * Does NOT require an external parser — suitable for well-formed snippets.
 *
 * Strategy:
 *  1. Remove <script> and <style> blocks entirely.
 *  2. Strip all remaining tags.
 *  3. Decode the five standard XML entities.
 *  4. Collapse runs of whitespace to single spaces.
 */
export function htmlToText(html: string): string {
  // Drop script / style content wholesale
  let text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/(script|style)>/gi, " ");
  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode XML entities
  text = text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&nbsp;/gi, " ");
  // Collapse whitespace
  return text.replace(/\s+/g, " ").trim();
}

// ── Built-in extractor ────────────────────────────────────────────────────────

/**
 * Default extractor.
 *
 * Handles: "text" and "markdown" (identity), "html" (tag stripping).
 * Throws a descriptive error for "pdf" and "docx" — callers must inject
 * an extractor backed by a real parser for those formats.
 */
export const defaultExtractor: Extractor = async (
  format: DocFormat,
  content: string,
): Promise<string> => {
  switch (format) {
    case "text":
    case "markdown":
      return content;

    case "html":
      return htmlToText(content);

    case "pdf":
      throw new Error(
        "PDF extraction requires an external Extractor. " +
          'Wrap a library such as "pdf-parse" and inject it via opts.extractor.',
      );

    case "docx":
      throw new Error(
        "DOCX extraction requires an external Extractor. " +
          'Wrap a library such as "mammoth" and inject it via opts.extractor.',
      );
  }
};

// ── Null implementations ───────────────────────────────────────────────────────

/**
 * Null extractor — returns content as-is regardless of format.
 * Useful for tests that supply pre-extracted plain text.
 */
export const nullExtractor: Extractor = async (
  _format: DocFormat,
  content: string,
): Promise<string> => content;

/**
 * Null embedder — returns a zero vector of dimension 4 for every text.
 * Useful for testing pipeline wiring without a real embedding API.
 */
export const nullEmbedder: Embedder = async (texts: string[]): Promise<Embedding[]> =>
  texts.map(() => [0, 0, 0, 0]);

/**
 * Null store — discards chunks and returns synthetic IDs.
 * Useful for testing pipeline wiring without a real vector database.
 */
export const nullStore: ChunkStore = {
  async save(chunks: EmbeddedChunk[], _meta: DocMeta): Promise<StoreResult> {
    return {
      ids: chunks.map((_, i) => `null-chunk-${i}`),
      count: chunks.length,
    };
  },
};

// ── Chunker ───────────────────────────────────────────────────────────────────

/**
 * Split text into overlapping fixed-size windows.
 *
 * Algorithm:
 *  - Advance a start pointer by (maxChars - overlapChars) per iteration.
 *  - Last chunk may be shorter than maxChars.
 *  - Returns [] for empty input.
 *
 * @param text  Plain-text document string to chunk.
 * @param opts  maxTokens / overlapTokens (see ChunkOptions).
 */
export function chunkText(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapTokens = Math.min(opts.overlapTokens ?? DEFAULT_OVERLAP_TOKENS, maxTokens - 1);

  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;
  const stepChars = maxChars - overlapChars;

  if (text.length === 0) return [];

  const chunks: TextChunk[] = [];
  let start = 0;
  let index = 0;

  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    const chunkStr = text.slice(start, end);

    chunks.push({
      index,
      text: chunkStr,
      tokenEstimate: estimateTokens(chunkStr),
    });

    index++;
    if (end >= text.length) break;
    start += stepChars;
  }

  return chunks;
}

// ── Core pipeline ─────────────────────────────────────────────────────────────

export interface PipelineOptions {
  chunkOptions?: ChunkOptions;
  /** Override the text extractor (required for PDF/DOCX) */
  extractor?: Extractor;
  /** Override the embedding function */
  embedder?: Embedder;
  /** Override the chunk store */
  store?: ChunkStore;
}

/**
 * Run the full document processing pipeline.
 *
 * Stages: Extract → Chunk → Embed → Store.
 *
 * All stage implementations are injectable — pass custom `extractor`,
 * `embedder`, and `store` in `opts` for production use.  Defaults to
 * `defaultExtractor` (handles text/html/markdown), `nullEmbedder`, and
 * `nullStore` so the pipeline is usable for testing without any I/O.
 *
 * @param input   Document input (format + content + optional source/metadata).
 * @param opts    Stage overrides and chunker configuration.
 */
export async function runDocPipeline(
  input: DocInput,
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const start = Date.now();

  const extractor = opts.extractor ?? defaultExtractor;
  const embedder = opts.embedder ?? nullEmbedder;
  const store = opts.store ?? nullStore;

  // ── Stage 1: Extract ───────────────────────────────────────────────────────
  const rawText = await extractor(input.format, input.content);

  // ── Stage 2: Chunk ────────────────────────────────────────────────────────
  const chunks = chunkText(rawText, opts.chunkOptions);

  // ── Stage 3: Embed ────────────────────────────────────────────────────────
  const texts = chunks.map((c) => c.text);
  const embeddings = texts.length > 0 ? await embedder(texts) : [];

  const embeddedChunks: EmbeddedChunk[] = chunks.map((chunk, i) => ({
    ...chunk,
    embedding: embeddings[i] ?? [],
  }));

  // ── Stage 4: Store ────────────────────────────────────────────────────────
  const meta: DocMeta = {
    source: input.source,
    format: input.format,
    totalChunks: embeddedChunks.length,
    processedAt: new Date().toISOString(),
    metadata: input.metadata,
  };

  const storeResult = await store.save(embeddedChunks, meta);

  return {
    source: input.source,
    format: input.format,
    rawTextLength: rawText.length,
    chunks: chunks.length,
    embedded: embeddedChunks.length,
    storeResult,
    durationMs: Date.now() - start,
  };
}

// ── Adapter wiring ────────────────────────────────────────────────────────────

export interface DocIngestTask {
  taskType: "doc.ingest";
  /** Document format */
  format: DocFormat;
  /** Raw document content */
  content: string;
  /** Optional source label (URL, filename) */
  source?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
  /** Chunker configuration */
  chunkOptions?: ChunkOptions;
}

async function execute(task: DocIngestTask, ctx: IExecutionContext): Promise<PipelineResult> {
  ctx.logger.info("doc.ingest", {
    format: task.format,
    contentLength: task.content.length,
    source: task.source ?? null,
  });

  return runDocPipeline(
    {
      format: task.format,
      content: task.content,
      source: task.source,
      metadata: task.metadata,
    },
    { chunkOptions: task.chunkOptions },
  );
}

/** Doc pipeline adapter. */
export const docPipelineAdapter = defineAdapter<DocIngestTask, PipelineResult>({
  name: "nexus-adapter-doc-pipeline",
  version: "0.1.0",
  capabilities: ["storage.write", "storage.read"],
  taskTypes: ["doc.ingest"],
  execute,
});

export default docPipelineAdapter;
