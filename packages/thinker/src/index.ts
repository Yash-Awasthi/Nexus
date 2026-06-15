// SPDX-License-Identifier: Apache-2.0
/**
 * thinker — Deliberative slow-reasoning agent for the Nexus platform.
 *
 * Features:
 *   • ThinkStep      — a single reasoning step with scratchpad + conclusion
 *   • ThinkChain     — ordered chain of steps with evidence tracking
 *   • Thinker        — orchestrates multi-step reasoning (injectable LLM call)
 *   • BestOfN        — runs N reasoning chains and picks the most confident
 *   • ReasoningCache — deduplicate identical prompts within a session
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type StepStatus = "pending" | "running" | "done" | "error";

/** Think step interface definition. */
export interface ThinkStep {
  index: number;
  prompt: string;
  scratchpad: string;
  conclusion: string;
  confidence: number; // 0-1
  status: StepStatus;
  durationMs: number;
  tokens: number;
}

/** Think chain interface definition. */
export interface ThinkChain {
  id: string;
  query: string;
  steps: ThinkStep[];
  finalAnswer: string;
  totalConfidence: number; // mean of step confidences
  totalTokens: number;
  durationMs: number;
  model: string;
}

/** Thinker options interface definition. */
export interface ThinkerOptions {
  model?: string;
  maxSteps?: number;
  minConfidence?: number;
  /** Injected LLM call — returns { scratchpad, conclusion, confidence, tokens } */
  llmCall?: LlmCallFn;
}

/** Llm call fn type alias. */
export type LlmCallFn = (
  prompt: string,
  model: string,
) => Promise<{ scratchpad: string; conclusion: string; confidence: number; tokens: number }>;

// ── Default mock LLM ──────────────────────────────────────────────────────────

const DEFAULT_LLM: LlmCallFn = async (prompt, _model) => ({
  scratchpad: `Thinking about: ${prompt.slice(0, 50)}`,
  conclusion: `Concluded from: ${prompt.slice(0, 30)}`,
  confidence: 0.75,
  tokens: Math.ceil(prompt.length / 4),
});

// ── ID util ───────────────────────────────────────────────────────────────────

let _seq = 0;
function uid(prefix: string) { return `${prefix}-${Date.now()}-${++_seq}`; }

// ── ThinkChain builder ────────────────────────────────────────────────────────

export class ThinkChainBuilder {
  private steps: ThinkStep[] = [];
  private startMs = Date.now();

  constructor(readonly id: string, readonly query: string, readonly model: string) {}

  addStep(step: Omit<ThinkStep, "index">): this {
    this.steps.push({ index: this.steps.length, ...step });
    return this;
  }

  build(): ThinkChain {
    const totalTokens = this.steps.reduce((s, t) => s + t.tokens, 0);
    const totalConfidence = this.steps.length
      ? this.steps.reduce((s, t) => s + t.confidence, 0) / this.steps.length
      : 0;
    const last = this.steps[this.steps.length - 1];
    return {
      id: this.id,
      query: this.query,
      steps: this.steps,
      finalAnswer: last?.conclusion ?? "",
      totalConfidence,
      totalTokens,
      durationMs: Date.now() - this.startMs,
      model: this.model,
    };
  }
}

// ── Thinker ───────────────────────────────────────────────────────────────────

export class Thinker {
  private model: string;
  private maxSteps: number;
  private minConfidence: number;
  private llmCall: LlmCallFn;

  constructor(opts: ThinkerOptions = {}) {
    this.model = opts.model ?? "gpt-4o";
    this.maxSteps = opts.maxSteps ?? 3;
    this.minConfidence = opts.minConfidence ?? 0.5;
    this.llmCall = opts.llmCall ?? DEFAULT_LLM;
  }

  async think(query: string, context?: string): Promise<ThinkChain> {
    const chain = new ThinkChainBuilder(uid("chain"), query, this.model);
    const base = context ? `Context:\n${context}\n\nQuestion: ${query}` : query;

    for (let i = 0; i < this.maxSteps; i++) {
      const previousConclusions = chain["steps"]
        .map((s, idx) => `Step ${idx + 1}: ${s.conclusion}`)
        .join("\n");

      const prompt = i === 0
        ? `Reason step by step to answer: ${base}`
        : `Previous steps:\n${previousConclusions}\n\nContinue reasoning: ${query}`;

      const t0 = Date.now();
      const result = await this.llmCall(prompt, this.model);
      chain.addStep({
        prompt,
        scratchpad: result.scratchpad,
        conclusion: result.conclusion,
        confidence: result.confidence,
        status: "done",
        durationMs: Date.now() - t0,
        tokens: result.tokens,
      });

      if (result.confidence >= this.minConfidence && i >= 1) break;
    }

    return chain.build();
  }
}

// ── BestOfN ───────────────────────────────────────────────────────────────────

export interface BestOfNOptions {
  n?: number;
  model?: string;
  llmCall?: LlmCallFn;
}

/** Best of n. */
export class BestOfN {
  private n: number;
  private thinker: Thinker;

  constructor(opts: BestOfNOptions = {}) {
    this.n = opts.n ?? 3;
    this.thinker = new Thinker({ model: opts.model, llmCall: opts.llmCall });
  }

  async run(query: string, context?: string): Promise<{ best: ThinkChain; all: ThinkChain[] }> {
    const all = await Promise.all(
      Array.from({ length: this.n }, () => this.thinker.think(query, context)),
    );
    const best = all.reduce((a, b) => (b.totalConfidence > a.totalConfidence ? b : a));
    return { best, all };
  }
}

// ── ReasoningCache ────────────────────────────────────────────────────────────

export class ReasoningCache {
  private cache = new Map<string, ThinkChain>();

  set(query: string, chain: ThinkChain): void {
    this.cache.set(query, chain);
  }

  get(query: string): ThinkChain | undefined {
    return this.cache.get(query);
  }

  has(query: string): boolean {
    return this.cache.has(query);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

// ── ThinkingSession — cached + orchestrated reasoning ─────────────────────────

export class ThinkingSession {
  private cache = new ReasoningCache();
  private thinker: Thinker;

  constructor(opts: ThinkerOptions = {}) {
    this.thinker = new Thinker(opts);
  }

  async ask(query: string, context?: string, forceRefresh = false): Promise<ThinkChain> {
    const cacheKey = `${query}::${context ?? ""}`;
    if (!forceRefresh && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }
    const chain = await this.thinker.think(query, context);
    this.cache.set(cacheKey, chain);
    return chain;
  }

  cacheSize(): number { return this.cache.size(); }

  clearCache(): void { this.cache.clear(); }
}
