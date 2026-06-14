// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/best-of-n — Best-of-N generation.
 *
 * Generates N completions for the same prompt, scores each one, and returns
 * the best.  Applied to both "thinker" and "editor" roles — any single-shot
 * LLM call can be upgraded to best-of-N with no interface change.
 *
 * Architecture
 * ────────────
 *   BestOfNGenerator   — stateless; injectable LLM client + scorer.
 *   BonScorer          — (text, prompt) → number  (injectable scoring function)
 *   BonLlmClient       — minimal injectable LLM interface.
 *   defaultScorer      — length + structure + relevance (no LLM required).
 *   llmJudgeScorer     — use a separate LLM to judge quality (optional).
 *
 * Usage
 * ─────
 * ```ts
 * const gen = new BestOfNGenerator({ llm, n: 5 });
 * const { best, all } = await gen.generate({
 *   prompt: "Refactor this function to be more readable",
 *   role: "editor",
 * });
 * ```
 */

// ── Injectable LLM client ─────────────────────────────────────────────────────

export interface BonMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface BonLlmResponse {
  content: string;
  model: string;
  /** Duration of this specific call in ms */
  durationMs?: number;
}

export interface BonLlmClient {
  complete(messages: BonMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<BonLlmResponse>;
}

// ── Scorer ────────────────────────────────────────────────────────────────────

export type BonScorer = (content: string, prompt: string) => number | Promise<number>;

// ── Individual candidate ──────────────────────────────────────────────────────

export interface BonCandidate {
  index: number;
  content: string;
  model: string;
  score: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface BonResult {
  /** The highest-scoring candidate. */
  best: BonCandidate;
  /** All N candidates (sorted best-first). */
  all: BonCandidate[];
  /** n attempted, n_succeeded succeeded, best_score. */
  stats: {
    n: number;
    succeeded: number;
    bestScore: number;
    avgScore: number;
    durationMs: number;
  };
}

// ── Default scorer (pure, no I/O) ────────────────────────────────────────────

const HEADER_RE = /^#{1,3}\s/gm;
const LIST_RE = /^[\s]*[-*•]\s/gm;
const CODE_RE = /```/g;
const HEDGE_RE = /I cannot|I can't|I'm unable|I apologize|As an AI/i;

/**
 * Default scoring: length + structure + anti-hedge + relevance.
 * Returns 0–100.
 */
export function defaultScorer(content: string, prompt: string): number {
  if (!content || content.length < 5) return 0;
  let score = Math.min(content.length / 30, 30);
  const headers = (content.match(HEADER_RE) ?? []).length;
  const lists = (content.match(LIST_RE) ?? []).length;
  const codeBlocks = (content.match(CODE_RE) ?? []).length / 2;
  score += Math.min(headers * 3 + lists * 2 + codeBlocks * 5, 25);
  score += HEDGE_RE.test(content) ? 0 : 20;
  const words = prompt.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const lower = content.toLowerCase();
  const matched = words.filter((w) => lower.includes(w));
  score += words.length > 0 ? (matched.length / words.length) * 25 : 12.5;
  return Math.round(Math.min(score, 100));
}

// ── Generator config ──────────────────────────────────────────────────────────

export interface BestOfNConfig {
  llm: BonLlmClient;
  n?: number;
  scorer?: BonScorer;
  /** Temperature to use for generation (default: 0.8 — variety needed) */
  temperature?: number;
  maxTokens?: number;
  /** Role label for metrics / logging */
  role?: "thinker" | "editor" | string;
}

export interface GenerateRequest {
  prompt: string;
  /** Optional system prompt prepended to all N calls. */
  systemPrompt?: string;
  /** Per-call temperature override (default: from config) */
  temperature?: number;
  maxTokens?: number;
}

// ── BestOfNGenerator ──────────────────────────────────────────────────────────

export class BestOfNGenerator {
  private readonly llm: BonLlmClient;
  private readonly n: number;
  private readonly scorer: BonScorer;
  private readonly temperature: number;
  private readonly maxTokens: number;
  readonly role: string;

  constructor(config: BestOfNConfig) {
    this.llm = config.llm;
    this.n = Math.max(1, config.n ?? 3);
    this.scorer = config.scorer ?? defaultScorer;
    this.temperature = config.temperature ?? 0.8;
    this.maxTokens = config.maxTokens ?? 2048;
    this.role = config.role ?? "thinker";
  }

  async generate(req: GenerateRequest): Promise<BonResult> {
    const t0 = Date.now();
    const messages: BonMessage[] = [];

    if (req.systemPrompt) {
      messages.push({ role: "system", content: req.systemPrompt });
    }
    messages.push({ role: "user", content: req.prompt });

    const temperature = req.temperature ?? this.temperature;
    const maxTokens = req.maxTokens ?? this.maxTokens;

    // Fire all N completions in parallel
    const pending = Array.from({ length: this.n }, (_, i) =>
      this._attempt(i, messages, temperature, maxTokens, req.prompt),
    );

    const candidates = await Promise.all(pending);
    const succeeded = candidates.filter((c) => c.success);

    if (succeeded.length === 0) {
      throw new Error(`All ${this.n} BestOfN attempts failed`);
    }

    const sorted = [...succeeded].sort((a, b) => b.score - a.score);
    const best = sorted[0]!;

    return {
      best,
      all: sorted,
      stats: {
        n: this.n,
        succeeded: succeeded.length,
        bestScore: best.score,
        avgScore: succeeded.reduce((s, c) => s + c.score, 0) / succeeded.length,
        durationMs: Date.now() - t0,
      },
    };
  }

  private async _attempt(
    index: number,
    messages: BonMessage[],
    temperature: number,
    maxTokens: number,
    prompt: string,
  ): Promise<BonCandidate> {
    const t0 = Date.now();
    try {
      const res = await this.llm.complete(messages, { temperature, maxTokens });
      const score = await Promise.resolve(this.scorer(res.content, prompt));
      return {
        index,
        content: res.content,
        model: res.model,
        score,
        durationMs: res.durationMs ?? (Date.now() - t0),
        success: true,
      };
    } catch (err) {
      return {
        index,
        content: "",
        model: "unknown",
        score: 0,
        durationMs: Date.now() - t0,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ── Null LLM for tests ────────────────────────────────────────────────────────

export interface NullLlmOptions {
  responses?: string[];
  model?: string;
  error?: string;
}

/**
 * Deterministic stub LLM for testing.
 * Cycles through provided responses (or returns empty string).
 */
export class NullBonLlmClient implements BonLlmClient {
  private readonly responses: string[];
  private readonly model: string;
  private readonly errorMsg: string | undefined;
  private callCount = 0;

  constructor(opts: NullLlmOptions = {}) {
    this.responses = opts.responses ?? ["null response"];
    this.model = opts.model ?? "null-model";
    this.errorMsg = opts.error;
  }

  async complete(_messages: BonMessage[]): Promise<BonLlmResponse> {
    if (this.errorMsg) throw new Error(this.errorMsg);
    const content = this.responses[this.callCount % this.responses.length] ?? "";
    this.callCount++;
    return { content, model: this.model, durationMs: 1 };
  }
}
