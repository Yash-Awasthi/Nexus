// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/nlp-utils — NLP utility layer.
 *
 * Pure-function NLP with zero external runtime dependencies.
 * LLM-backed operations (entity + relationship extraction) accept an injectable
 * NlpLlmClient — structurally compatible with @nexus/llm-utils LlmClient so
 * callers can pass one directly without a compile-time coupling.
 *
 * Chunking strategies exported here:
 *   chunkByFixed(text, opts?)      — sliding-window fixed-size chunks
 *   chunkBySentence(text, opts?)   — sentence-boundary grouping
 *   chunkByParagraph(text, opts?)  — double-newline paragraph grouping
 *   chunkByStrategy(text, strategy, opts?) — dispatcher
 *
 * Language + keyword:
 *   detectLanguage(text)               → LanguageResult
 *   extractKeywords(text, opts?)       → KeywordResult[]
 *
 * LLM-backed (injectable):
 *   extractEntities(text, llm?)        → Promise<Entity[]>
 *   extractRelationships(text, entities, llm?) → Promise<Relationship[]>
 *
 * Consumers:
 *   KG (gap 4)   — extractEntities, extractRelationships, chunkByStrategy
 *   Agents (9)   — extractKeywords for memory indexing before writes
 *   Gateway      — detectLanguage for locale-aware routing
 */

// ── Shared types ──────────────────────────────────────────────────────────────

export interface TextChunk {
  index: number;
  text: string;
  /** Estimated tokens — ceil(text.length / 4) */
  tokenEstimate: number;
}

export type ChunkStrategy = "fixed" | "sentence" | "paragraph";

export interface FixedChunkOptions {
  /** Max tokens per chunk. Default: 256 */
  maxTokens?: number;
  /** Overlap tokens between chunks. Default: 32 */
  overlapTokens?: number;
}

export interface SegmentChunkOptions {
  /** Max characters before a forced split within sentence/paragraph mode */
  maxCharsPerChunk?: number;
}

export type ChunkOptions = FixedChunkOptions & SegmentChunkOptions;

// ── Token estimation ──────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ── chunkByFixed — sliding-window fixed-size chunker ─────────────────────────

const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_OVERLAP_TOKENS = 32;

/**
 * Split text into overlapping fixed-size windows (4 chars/token heuristic).
 * Identical algorithm to @nexus/doc-pipeline's chunkText — exported here for
 * consumers that don't want to pull in the full doc pipeline.
 */
export function chunkByFixed(text: string, opts: FixedChunkOptions = {}): TextChunk[] {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapTokens = Math.min(opts.overlapTokens ?? DEFAULT_OVERLAP_TOKENS, maxTokens - 1);
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const stepChars = (maxTokens - overlapTokens) * CHARS_PER_TOKEN;

  if (text.length === 0) return [];

  const chunks: TextChunk[] = [];
  let start = 0;
  let index = 0;

  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    const slice = text.slice(start, end);
    chunks.push({ index, text: slice, tokenEstimate: estimateTokens(slice) });
    index++;
    if (end >= text.length) break;
    start += stepChars;
  }

  return chunks;
}

// ── chunkBySentence — sentence-boundary grouping ──────────────────────────────

const DEFAULT_SENTENCE_MAX_CHARS = 1000;

/**
 * Split text at sentence boundaries (`.`, `!`, `?`, `。`, `！`, `？`) and
 * group consecutive sentences into chunks up to `maxCharsPerChunk`.
 *
 * Uses a positive lookbehind on the punctuation so the terminator stays with
 * the sentence it belongs to.  A sentence that exceeds `maxCharsPerChunk`
 * on its own is emitted as a single oversized chunk rather than truncated.
 */
export function chunkBySentence(text: string, opts: SegmentChunkOptions = {}): TextChunk[] {
  if (text.trim().length === 0) return [];

  const maxChars = opts.maxCharsPerChunk ?? DEFAULT_SENTENCE_MAX_CHARS;

  // Split on end-of-sentence punctuation followed by whitespace
  const sentences = text
    .split(/(?<=[.!?。！？])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Edge: no sentence boundaries found — return full text as one chunk
  if (sentences.length === 0) {
    const t = text.trim();
    return [{ index: 0, text: t, tokenEstimate: estimateTokens(t) }];
  }

  const chunks: TextChunk[] = [];
  let buffer = "";
  let idx = 0;

  for (const sentence of sentences) {
    const candidate = buffer ? `${buffer} ${sentence}` : sentence;
    if (buffer && candidate.length > maxChars) {
      chunks.push({ index: idx++, text: buffer, tokenEstimate: estimateTokens(buffer) });
      buffer = sentence;
    } else {
      buffer = candidate;
    }
  }

  if (buffer) {
    chunks.push({ index: idx, text: buffer, tokenEstimate: estimateTokens(buffer) });
  }

  return chunks;
}

// ── chunkByParagraph — double-newline paragraph grouping ─────────────────────

const DEFAULT_PARA_MAX_CHARS = 2000;

/**
 * Split text on blank lines (`\n\n` or `\r\n\r\n`) and group consecutive
 * paragraphs into chunks up to `maxCharsPerChunk`.
 */
export function chunkByParagraph(text: string, opts: SegmentChunkOptions = {}): TextChunk[] {
  if (text.trim().length === 0) return [];

  const maxChars = opts.maxCharsPerChunk ?? DEFAULT_PARA_MAX_CHARS;

  const paragraphs = text
    .split(/\r?\n\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    const t = text.trim();
    return [{ index: 0, text: t, tokenEstimate: estimateTokens(t) }];
  }

  const chunks: TextChunk[] = [];
  let buffer = "";
  let idx = 0;

  for (const para of paragraphs) {
    const candidate = buffer ? `${buffer}\n\n${para}` : para;
    if (buffer && candidate.length > maxChars) {
      chunks.push({ index: idx++, text: buffer, tokenEstimate: estimateTokens(buffer) });
      buffer = para;
    } else {
      buffer = candidate;
    }
  }

  if (buffer) {
    chunks.push({ index: idx, text: buffer, tokenEstimate: estimateTokens(buffer) });
  }

  return chunks;
}

// ── chunkByStrategy — dispatcher ──────────────────────────────────────────────

/**
 * Dispatch to the right chunker based on `strategy`.
 * `opts` is passed to the selected chunker — keys not applicable to the
 * strategy are ignored.
 */
export function chunkByStrategy(
  text: string,
  strategy: ChunkStrategy,
  opts: ChunkOptions = {},
): TextChunk[] {
  switch (strategy) {
    case "fixed":
      return chunkByFixed(text, opts);
    case "sentence":
      return chunkBySentence(text, opts);
    case "paragraph":
      return chunkByParagraph(text, opts);
  }
}

// ── Language detection ────────────────────────────────────────────────────────

export type NlpScript =
  | "latin"
  | "cjk"
  | "hiragana"
  | "katakana"
  | "hangul"
  | "arabic"
  | "cyrillic"
  | "hebrew"
  | "thai"
  | "devanagari"
  | "unknown";

export interface LanguageResult {
  /** ISO 639-1 code or "unknown" */
  language: string;
  /** Dominant Unicode script detected */
  script: NlpScript;
  /** Confidence in [0, 1] */
  confidence: number;
}

// Map script ranges for non-Latin scripts (ordered by specificity)
const NONLATIN_SCRIPTS: ReadonlyArray<{ script: NlpScript; re: RegExp; lang: string }> = [
  { script: "hiragana", re: /[\u3040-\u309F]/g, lang: "ja" },
  { script: "katakana", re: /[\u30A0-\u30FF]/g, lang: "ja" },
  { script: "hangul", re: /[\uAC00-\uD7AF\u1100-\u11FF]/g, lang: "ko" },
  { script: "arabic", re: /[\u0600-\u06FF\u0750-\u077F]/g, lang: "ar" },
  { script: "hebrew", re: /[\u0590-\u05FF\uFB1D-\uFB4F]/g, lang: "he" },
  { script: "cyrillic", re: /[\u0400-\u04FF]/g, lang: "ru" },
  { script: "thai", re: /[\u0E00-\u0E7F]/g, lang: "th" },
  { script: "devanagari", re: /[\u0900-\u097F]/g, lang: "hi" },
  { script: "cjk", re: /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g, lang: "zh" },
];

// Common word fingerprints for Latin-script languages
const LATIN_LANG_WORDS: ReadonlyArray<{ lang: string; words: ReadonlySet<string> }> = [
  { lang: "en", words: new Set(["the","is","are","and","of","to","in","that","it","was","for","not","with","he","she","they","have","had","this","at","but","be"]) },
  { lang: "es", words: new Set(["el","la","los","las","de","que","y","en","un","una","no","se","al","del","por","como","más","son","hay","todo"]) },
  { lang: "fr", words: new Set(["le","la","les","de","et","un","une","du","au","je","il","est","pas","pour","en","qui","ne","sur","avec","ou"]) },
  { lang: "de", words: new Set(["der","die","das","und","ist","zu","in","ein","eine","nicht","den","für","sich","mit","an","von","auch","es","auf","dem"]) },
  { lang: "pt", words: new Set(["os","as","uma","do","da","em","com","não","para","por","ser","uma","mas","seus","sua","são","tem","foi","nos","nas"]) },
  { lang: "it", words: new Set(["gli","una","che","non","per","con","del","della","dei","si","ci","più","sono","una","sul","nella","dello","alle","questo"]) },
];

/**
 * Lightweight language detection based on Unicode script analysis and word
 * fingerprinting for Latin-script languages.
 *
 * Returns `{ language: "unknown", script: "unknown", confidence: 0 }` for
 * empty or whitespace-only input.
 *
 * Accuracy is best for clear single-language text.  Mixed scripts or very
 * short strings will have lower confidence.
 */
export function detectLanguage(text: string): LanguageResult {
  const stripped = text.replace(/\s/g, "");
  if (stripped.length === 0) {
    return { language: "unknown", script: "unknown", confidence: 0 };
  }

  // Count non-Latin script characters
  let bestScript: NlpScript = "latin";
  let bestCount = 0;
  let bestLang = "";

  for (const entry of NONLATIN_SCRIPTS) {
    // Reset lastIndex before each exec (global regex)
    const matches = stripped.match(new RegExp(entry.re.source, "g"));
    const count = matches?.length ?? 0;
    if (count > bestCount) {
      bestCount = count;
      bestScript = entry.script;
      bestLang = entry.lang;
    }
  }

  const dominantRatio = bestCount / stripped.length;

  if (dominantRatio >= 0.15) {
    return {
      language: bestLang,
      script: bestScript,
      confidence: Math.min(1, dominantRatio * 2),
    };
  }

  // Latin-script — use word fingerprinting
  return detectLatinLanguage(text);
}

function detectLatinLanguage(text: string): LanguageResult {
  const words = text.toLowerCase().match(/[a-zà-öø-ÿ]+/g) ?? [];
  if (words.length === 0) {
    return { language: "unknown", script: "latin", confidence: 0 };
  }

  const wordSet = new Set(words);
  let topLang = "en";
  let topScore = 0;

  for (const { lang, words: fingerprint } of LATIN_LANG_WORDS) {
    let hits = 0;
    for (const w of wordSet) {
      if (fingerprint.has(w)) hits++;
    }
    const score = hits / Math.max(wordSet.size, 1);
    if (score > topScore) {
      topScore = score;
      topLang = lang;
    }
  }

  return {
    language: topLang,
    script: "latin",
    // confidence proportional to word hit rate, min 0.3 for any Latin text
    confidence: Math.min(1, Math.max(0.3, topScore * 3)),
  };
}

// ── Keyword extraction ────────────────────────────────────────────────────────

export interface KeywordResult {
  keyword: string;
  /** TF-based score normalised to [0, 1] */
  score: number;
  /** Raw frequency count in the document */
  frequency: number;
}

export interface KeywordOptions {
  /** How many top keywords to return. Default: 10. */
  topK?: number;
  /** Minimum character length for a keyword to be considered. Default: 3. */
  minLength?: number;
}

// Compact English stopword set (top 70 most common)
const STOPWORDS = new Set([
  "a","about","above","after","all","also","an","and","any","are","as","at",
  "be","been","being","but","by","can","do","each","for","from","get","go",
  "had","has","have","he","her","him","his","how","i","if","in","into","is",
  "it","its","just","me","more","my","no","not","now","of","on","or","our",
  "out","over","own","said","she","so","some","such","than","that","the",
  "their","them","then","there","these","they","this","through","to","too",
  "up","us","was","we","were","what","when","which","who","will","with",
  "would","you","your","could","should","may","might","must","shall","did",
]);

/**
 * Extract keywords from `text` using term-frequency scoring.
 *
 * Algorithm:
 *  1. Tokenise to lowercase words (≥ `minLength` chars, no stopwords).
 *  2. Count frequencies.
 *  3. Score = freq / totalWords, normalised to [0, 1] across all candidates.
 *  4. Return top `topK` by score.
 *
 * Returns `[]` for empty or whitespace-only input.
 */
export function extractKeywords(text: string, opts: KeywordOptions = {}): KeywordResult[] {
  const topK = opts.topK ?? 10;
  const minLength = opts.minLength ?? 3;

  if (text.trim().length === 0) return [];

  const tokens = (text.toLowerCase().match(/[a-z][a-z'-]*[a-z]|[a-z]{2,}/g) ?? []).filter(
    (w) => w.length >= minLength && !STOPWORDS.has(w),
  );

  if (tokens.length === 0) return [];

  const freq = new Map<string, number>();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }

  const totalTokens = tokens.length;
  const maxFreq = Math.max(...Array.from(freq.values()));

  const candidates: KeywordResult[] = Array.from(freq.entries()).map(([keyword, count]) => ({
    keyword,
    frequency: count,
    score: count / totalTokens / (maxFreq / totalTokens), // normalised TF
  }));

  candidates.sort((a, b) => b.score - a.score || b.frequency - a.frequency);

  return candidates.slice(0, topK);
}

// ── Entity extraction (LLM-backed) ────────────────────────────────────────────

export type EntityType = "PERSON" | "ORG" | "LOCATION" | "DATE" | "PRODUCT" | "EVENT" | "OTHER";

export interface Entity {
  text: string;
  type: EntityType;
  confidence: number;
}

/** Minimal LLM call interface — structurally compatible with @nexus/llm-utils LlmClient */
export type NlpLlmClient = (
  messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>,
  opts?: { temperature?: number; maxTokens?: number },
) => Promise<{ content: string; model: string }>;

/** Null LLM client — always returns an empty JSON array */
export const nullNlpLlmClient: NlpLlmClient = async () => ({
  content: "[]",
  model: "null",
});

const VALID_ENTITY_TYPES = new Set<EntityType>([
  "PERSON","ORG","LOCATION","DATE","PRODUCT","EVENT","OTHER",
]);

function isEntityType(v: unknown): v is EntityType {
  return typeof v === "string" && VALID_ENTITY_TYPES.has(v as EntityType);
}

function parseJsonArray<T>(content: string): T[] {
  let cleaned = content.trim();
  // Strip markdown fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .trim();
  }
  // Find the first '[' in case the model added preamble
  const start = cleaned.indexOf("[");
  if (start !== -1) cleaned = cleaned.slice(start);
  try {
    const parsed: unknown = JSON.parse(cleaned);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

const ENTITY_SYSTEM_PROMPT =
  `You are a named-entity recognition (NER) system. Extract all named entities from the user's text.\n` +
  `Return a JSON array — no markdown, no commentary — in this exact shape:\n` +
  `[{"text":"entity","type":"PERSON|ORG|LOCATION|DATE|PRODUCT|EVENT|OTHER","confidence":0.0-1.0}]`;

/**
 * Extract named entities from `text` using a cheap fast LLM.
 *
 * Returns `[]` immediately for blank input without calling the LLM.
 *
 * Entity types: PERSON, ORG, LOCATION, DATE, PRODUCT, EVENT, OTHER.
 * Entities with an unrecognised type are re-classified as OTHER.
 *
 * @param llm  Injectable client. Defaults to nullNlpLlmClient (test stub).
 *             Pass a @nexus/llm-utils LlmClient in production.
 */
export async function extractEntities(
  text: string,
  llm: NlpLlmClient = nullNlpLlmClient,
): Promise<Entity[]> {
  if (text.trim().length === 0) return [];

  const response = await llm(
    [
      { role: "system", content: ENTITY_SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    { temperature: 0.0, maxTokens: 512 },
  );

  const raw = parseJsonArray<{ text: unknown; type: unknown; confidence: unknown }>(
    response.content,
  );

  return raw
    .filter((e) => typeof e?.text === "string" && e.text.length > 0)
    .map((e) => ({
      text: e.text as string,
      type: isEntityType(e.type) ? e.type : "OTHER",
      confidence: typeof e.confidence === "number" ? Math.min(1, Math.max(0, e.confidence)) : 0.5,
    }));
}

// ── Relationship extraction (LLM-backed) ──────────────────────────────────────

export interface Relationship {
  /** Subject entity text */
  subject: string;
  /** Predicate / relation label (e.g. "works at", "founded", "located in") */
  predicate: string;
  /** Object entity text */
  object: string;
  /** Model confidence in [0, 1] */
  confidence: number;
}

const RELATIONSHIP_SYSTEM_PROMPT =
  `You are a relationship extraction system. Given text and a list of entities, ` +
  `identify subject-predicate-object triples between those entities.\n` +
  `Return a JSON array — no markdown, no commentary:\n` +
  `[{"subject":"...","predicate":"...","object":"...","confidence":0.0-1.0}]`;

/**
 * Extract subject-predicate-object relationship triples from `text`.
 *
 * The `entities` list is provided as context so the model grounds its output.
 * Returns `[]` immediately when `text` is blank or `entities` is empty.
 *
 * @param llm  Injectable client (same contract as extractEntities).
 */
export async function extractRelationships(
  text: string,
  entities: readonly Entity[],
  llm: NlpLlmClient = nullNlpLlmClient,
): Promise<Relationship[]> {
  if (text.trim().length === 0 || entities.length === 0) return [];

  const entityList = entities.map((e) => `${e.text} (${e.type})`).join(", ");
  const userMessage =
    `Entities: ${entityList}\n\nText:\n${text}`;

  const response = await llm(
    [
      { role: "system", content: RELATIONSHIP_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    { temperature: 0.0, maxTokens: 512 },
  );

  const raw = parseJsonArray<{
    subject: unknown;
    predicate: unknown;
    object: unknown;
    confidence: unknown;
  }>(response.content);

  return raw
    .filter(
      (r) =>
        typeof r?.subject === "string" &&
        typeof r?.predicate === "string" &&
        typeof r?.object === "string",
    )
    .map((r) => ({
      subject: r.subject as string,
      predicate: r.predicate as string,
      object: r.object as string,
      confidence: typeof r.confidence === "number" ? Math.min(1, Math.max(0, r.confidence)) : 0.5,
    }));
}

// ── Constants re-export ───────────────────────────────────────────────────────

export { CHARS_PER_TOKEN, DEFAULT_MAX_TOKENS, DEFAULT_OVERLAP_TOKENS, STOPWORDS };
