// SPDX-License-Identifier: Apache-2.0
/**
 * smart-reader — Relevance-guided chunked navigation for large files.
 *
 * Splits content into overlapping chunks, scores them by query relevance,
 * and returns the best-matching sections with surrounding context.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Chunk {
  index: number;
  start: number;
  end: number;
  content: string;
  score: number;
  lineStart: number;
  lineEnd: number;
}

export interface ReadResult {
  chunks: Chunk[];
  totalChunks: number;
  totalLines: number;
  query: string;
  durationMs: number;
}

export interface SmartReaderOptions {
  /** Max characters per chunk. Default: 1500 */
  chunkSize?: number;
  /** Overlap between adjacent chunks in chars. Default: 200 */
  overlap?: number;
  /** How many top chunks to return. Default: 5 */
  topK?: number;
  /** Minimum relevance score (0-1) to include. Default: 0 */
  scoreThreshold?: number;
}

// ── Tokenisation helpers ───────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function buildQueryTermSet(query: string): Set<string> {
  return new Set(tokenize(query));
}

/** Simple TF-IDF-inspired term overlap score [0, 1]. */
function scoreChunk(chunkTokens: string[], queryTerms: Set<string>): number {
  if (queryTerms.size === 0 || chunkTokens.length === 0) return 0;
  const termFreq = new Map<string, number>();
  for (const tok of chunkTokens) {
    if (queryTerms.has(tok)) {
      termFreq.set(tok, (termFreq.get(tok) ?? 0) + 1);
    }
  }
  // score = (unique query terms hit / total query terms) weighted by frequency
  let score = 0;
  for (const [, freq] of termFreq) {
    score += 1 + Math.log(freq);
  }
  const maxPossible = queryTerms.size * (1 + Math.log(chunkTokens.length));
  return Math.min(1, score / maxPossible);
}

// ── Core chunking ─────────────────────────────────────────────────────────────

function makeChunks(
  content: string,
  chunkSize: number,
  overlap: number,
): Array<{ start: number; end: number; text: string }> {
  const chunks: Array<{ start: number; end: number; text: string }> = [];
  let pos = 0;
  while (pos < content.length) {
    const end = Math.min(pos + chunkSize, content.length);
    chunks.push({ start: pos, end, text: content.slice(pos, end) });
    if (end >= content.length) break;
    pos += chunkSize - overlap;
  }
  return chunks;
}

function countNewlines(str: string, upTo: number): number {
  let count = 0;
  for (let i = 0; i < upTo && i < str.length; i++) {
    if (str[i] === "\n") count++;
  }
  return count;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Read the most relevant portions of `content` given a natural-language `query`.
 */
export function smartRead(
  content: string,
  query: string,
  opts: SmartReaderOptions = {},
): ReadResult {
  const t0 = Date.now();
  const {
    chunkSize = 1500,
    overlap = 200,
    topK = 5,
    scoreThreshold = 0,
  } = opts;

  const totalLines = content.split("\n").length;
  const queryTerms = buildQueryTermSet(query);
  const rawChunks = makeChunks(content, chunkSize, overlap);

  const chunks: Chunk[] = rawChunks.map((raw, idx) => {
    const tokens = tokenize(raw.text);
    const score = scoreChunk(tokens, queryTerms);
    const lineStart = countNewlines(content, raw.start) + 1;
    const lineEnd = lineStart + raw.text.split("\n").length - 1;
    return {
      index: idx,
      start: raw.start,
      end: raw.end,
      content: raw.text,
      score,
      lineStart,
      lineEnd,
    };
  });

  const filtered = chunks
    .filter((c) => c.score >= scoreThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .sort((a, b) => a.start - b.start); // restore document order

  return {
    chunks: filtered,
    totalChunks: rawChunks.length,
    totalLines,
    query,
    durationMs: Date.now() - t0,
  };
}

/**
 * Retrieve a specific chunk by its line range (1-indexed, inclusive).
 */
export function readLines(
  content: string,
  fromLine: number,
  toLine: number,
): string {
  const lines = content.split("\n");
  const start = Math.max(0, fromLine - 1);
  const end = Math.min(lines.length, toLine);
  return lines.slice(start, end).join("\n");
}

/**
 * Estimate how many chunks a document will produce.
 */
export function estimateChunks(
  contentLength: number,
  chunkSize = 1500,
  overlap = 200,
): number {
  if (contentLength <= 0) return 0;
  if (contentLength <= chunkSize) return 1;
  const step = chunkSize - overlap;
  return Math.ceil((contentLength - overlap) / step);
}
