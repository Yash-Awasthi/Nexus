// SPDX-License-Identifier: Apache-2.0
/**
 * ingest-intent — LLM-driven BM25 query distillation for oversized documents.
 *
 * Problem: Full document text fed to OpenSearch BM25 exceeds the 1024-clause
 * boolean limit, causing query parse errors.
 *
 * Solution: Use an LLM to distill the document intent into a compact query
 * string (≤ 200 terms), then use that for BM25 retrieval.
 *
 * Fails open: if the LLM call fails or returns unusable output, the distiller
 * returns null so the caller can fall back to a deterministic bounded-term
 * query strategy.
 *
 * Provides:
 *   • IntentDistillerOptions
 *   • DistillResult        — distilled query or null (fail-open)
 *   • IntentDistiller      — core distiller with inject/distill API
 *   • DocumentChunker      — cap input at 20K chars
 *   • TermNormalizer       — lowercase, dedup, stop-word removal
 *   • BoundedTermExtractor — deterministic fallback (no LLM)
 *   • MockLlmDistiller     — injectable test double
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DistillOptions {
  maxInputChars?: number;    // default 20_000
  maxOutputTerms?: number;   // default 200
  failOpen?: boolean;        // default true → return null on failure
}

/** Distill result interface definition. */
export interface DistillResult {
  query: string | null;       // null = fail-open
  termCount: number;
  inputChars: number;
  truncated: boolean;
  source: "llm" | "fallback" | "null";
}

/** Llm distill fn type alias. */
export type LlmDistillFn = (prompt: string) => Promise<string>;

// ── DocumentChunker ───────────────────────────────────────────────────────────

export class DocumentChunker {
  cap(text: string, maxChars: number): { text: string; truncated: boolean } {
    if (text.length <= maxChars) return { text, truncated: false };
    return { text: text.slice(0, maxChars), truncated: true };
  }
}

// ── TermNormalizer ────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by",
  "do", "for", "from", "has", "have", "he", "her", "his", "how", "i",
  "if", "in", "is", "it", "its", "of", "on", "or", "our", "she",
  "so", "some", "that", "the", "their", "there", "they", "this", "to",
  "was", "we", "were", "what", "when", "where", "which", "who", "will",
  "with", "you", "your",
]);

/** Term normalizer. */
export class TermNormalizer {
  normalize(text: string, maxTerms: number): string[] {
    const raw = text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

    // Dedup while preserving order
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const t of raw) {
      if (!seen.has(t)) { seen.add(t); unique.push(t); }
      if (unique.length >= maxTerms) break;
    }
    return unique;
  }
}

// ── BoundedTermExtractor — deterministic fallback ─────────────────────────────

export class BoundedTermExtractor {
  private normalizer = new TermNormalizer();

  extract(text: string, maxTerms = 200): DistillResult {
    const chunker = new DocumentChunker();
    const { text: capped, truncated } = chunker.cap(text, 20_000);
    const terms = this.normalizer.normalize(capped, maxTerms);
    return {
      query: terms.join(" ") || null,
      termCount: terms.length,
      inputChars: capped.length,
      truncated,
      source: "fallback",
    };
  }
}

// ── MockLlmDistiller ──────────────────────────────────────────────────────────

export class MockLlmDistiller {
  private response?: string;
  private throws?: string;
  readonly calls: string[] = [];

  setResponse(response: string): this {
    this.response = response;
    this.throws = undefined;
    return this;
  }

  setThrows(message: string): this {
    this.throws = message;
    this.response = undefined;
    return this;
  }

  asFn(): LlmDistillFn {
    return async (prompt: string) => {
      this.calls.push(prompt);
      if (this.throws) throw new Error(this.throws);
      return this.response ?? "";
    };
  }
}

// ── IntentDistiller ───────────────────────────────────────────────────────────

const DISTILL_PROMPT_TEMPLATE = (text: string, maxTerms: number) => `
You are a BM25 query distiller. Extract the most important search terms from the document below.
Output ONLY a space-separated list of terms, no punctuation, no explanations.
Maximum ${maxTerms} terms. Focus on nouns, entities, technical terms, and key concepts.

Document (first ${text.length} chars):
${text}

Terms:`.trim();

/** Intent distiller. */
export class IntentDistiller {
  private llm?: LlmDistillFn;
  private opts: Required<DistillOptions>;
  private chunker = new DocumentChunker();
  private normalizer = new TermNormalizer();
  private fallback = new BoundedTermExtractor();

  constructor(opts: DistillOptions = {}) {
    this.opts = {
      maxInputChars:  opts.maxInputChars  ?? 20_000,
      maxOutputTerms: opts.maxOutputTerms ?? 200,
      failOpen:       opts.failOpen       ?? true,
    };
  }

  inject(llm: LlmDistillFn): this {
    this.llm = llm;
    return this;
  }

  async distill(document: string): Promise<DistillResult> {
    const { text: capped, truncated } = this.chunker.cap(document, this.opts.maxInputChars);

    if (!this.llm) {
      // No LLM injected → deterministic fallback
      return this.fallback.extract(capped, this.opts.maxOutputTerms);
    }

    try {
      const prompt = DISTILL_PROMPT_TEMPLATE(capped, this.opts.maxOutputTerms);
      const raw = await this.llm(prompt);
      const terms = this.normalizer.normalize(raw, this.opts.maxOutputTerms);

      if (terms.length === 0) {
        // LLM returned nothing useful → fail open
        return this.opts.failOpen
          ? { query: null, termCount: 0, inputChars: capped.length, truncated, source: "null" }
          : this.fallback.extract(capped, this.opts.maxOutputTerms);
      }

      return {
        query: terms.join(" "),
        termCount: terms.length,
        inputChars: capped.length,
        truncated,
        source: "llm",
      };
    } catch {
      // LLM error → fail open
      return this.opts.failOpen
        ? { query: null, termCount: 0, inputChars: capped.length, truncated, source: "null" }
        : this.fallback.extract(capped, this.opts.maxOutputTerms);
    }
  }
}

// ── DistillPipeline ───────────────────────────────────────────────────────────

/**
 * Higher-order pipeline: try LLM, fall back to BoundedTermExtractor if null.
 */
export class DistillPipeline {
  private distiller: IntentDistiller;
  private fallback: BoundedTermExtractor;

  constructor(distiller: IntentDistiller) {
    this.distiller = distiller;
    this.fallback = new BoundedTermExtractor();
  }

  async run(document: string): Promise<DistillResult> {
    const result = await this.distiller.distill(document);
    if (result.query !== null) return result;
    // Null = fail-open → use deterministic fallback
    return this.fallback.extract(document);
  }
}
