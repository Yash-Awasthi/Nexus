// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/context-pruner — Active token budget management for agent pipelines.
 *
 * Prevents silent context overflow by truncating message history before
 * it reaches the LLM's context window limit.
 *
 * IContextPruner       — core interface.
 * ITokenizer           — injectable tokenizer (count tokens per string).
 * NaiveTokenizer       — ~4 chars/token heuristic (no deps, fast).
 * WordTokenizer        — whitespace split (better for estimates).
 *
 * Three pruning strategies:
 *
 * SlidingWindowPruner  — always keeps the system message (if any) plus the
 *                        N most recent messages that fit within the budget.
 *
 * TFIDFPruner          — scores each non-system message by TF relevance to
 *                        the latest user message; keeps highest-scoring
 *                        messages that fit the budget, plus always retains
 *                        system + last user message.
 *
 * ImportanceWeightedPruner — assigns weights by role (system > user > assistant)
 *                        and recency; keeps highest-weighted messages.
 *
 * PrunerChain          — tries pruners in order; returns first result that
 *                        satisfies the budget.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { randomUUID } from "node:crypto";

// ── Error ──────────────────────────────────────────────────────────────────────

export class PrunerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PrunerError";
  }
}

// ── Message type ──────────────────────────────────────────────────────────────

export type MessageRole = "system" | "user" | "assistant" | "tool";

/** Message interface definition. */
export interface Message {
  role: MessageRole;
  content: string;
  /** Optional stable identifier for tracking across prune operations. */
  id?: string;
}

// ── PruneResult ───────────────────────────────────────────────────────────────

export interface PruneResult {
  /** The pruned message list ready to send to the LLM. */
  messages: Message[];
  /** Total messages before pruning. */
  originalCount: number;
  /** Number of messages removed. */
  prunedCount: number;
  /** Estimated token count of the pruned result. */
  estimatedTokens: number;
  /** Which strategy produced this result. */
  strategy: string;
}

// ── IContextPruner ────────────────────────────────────────────────────────────

export interface PruneOptions {
  /** Reserve this many tokens for the model's response. Default: 0 */
  reserveTokens?: number;
}

/** I context pruner interface definition. */
export interface IContextPruner {
  /**
   * Prune `messages` to fit within `maxTokens`.
   * Always preserves the system message (first message if role === "system").
   */
  prune(messages: Message[], maxTokens: number, opts?: PruneOptions): Promise<PruneResult>;

  /** Estimate tokens for a message array without pruning. */
  estimate(messages: Message[]): number;
}

// ── Tokenizer ─────────────────────────────────────────────────────────────────

export interface ITokenizer {
  count(text: string): number;
}

/**
 * Naive tokenizer: approximately 4 characters per token.
 * Suitable for quick estimates without any external dependency.
 */
export class NaiveTokenizer implements ITokenizer {
  count(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

/**
 * Word-based tokenizer: splits on whitespace.
 * Slightly more accurate for English text.
 */
export class WordTokenizer implements ITokenizer {
  count(text: string): number {
    return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function messageTokens(msg: Message, tok: ITokenizer): number {
  // Role overhead (~4 tokens) + content
  return 4 + tok.count(msg.content);
}

function totalTokens(msgs: Message[], tok: ITokenizer): number {
  return msgs.reduce((sum, m) => sum + messageTokens(m, tok), 0);
}

function extractSystem(messages: Message[]): { system: Message | undefined; rest: Message[] } {
  if (messages.length > 0 && messages[0]?.role === "system") {
    return { system: messages[0], rest: messages.slice(1) };
  }
  return { system: undefined, rest: messages };
}

function makeResult(
  messages: Message[],
  original: Message[],
  strategy: string,
  tok: ITokenizer,
): PruneResult {
  return {
    messages,
    originalCount: original.length,
    prunedCount: original.length - messages.length,
    estimatedTokens: totalTokens(messages, tok),
    strategy,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SlidingWindowPruner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keeps system message + the most recent messages that fit in the budget.
 * Simple, predictable, O(n).
 */
export class SlidingWindowPruner implements IContextPruner {
  constructor(private readonly tokenizer: ITokenizer = new NaiveTokenizer()) {}

  estimate(messages: Message[]): number {
    return totalTokens(messages, this.tokenizer);
  }

  async prune(
    messages: Message[],
    maxTokens: number,
    opts: PruneOptions = {},
  ): Promise<PruneResult> {
    const budget = maxTokens - (opts.reserveTokens ?? 0);
    const { system, rest } = extractSystem(messages);

    const systemTokens = system ? messageTokens(system, this.tokenizer) : 0;
    let remaining = budget - systemTokens;

    // Walk backwards from most recent, accumulating messages that fit
    const kept: Message[] = [];
    for (let i = rest.length - 1; i >= 0; i--) {
      const msg = rest[i]!;
      const cost = messageTokens(msg, this.tokenizer);
      if (remaining - cost >= 0) {
        kept.unshift(msg);
        remaining -= cost;
      }
      // Once we can't fit more, stop (sliding window semantics)
      else if (kept.length > 0) {
        break;
      }
    }

    const result = system ? [system, ...kept] : kept;
    return makeResult(result, messages, "sliding-window", this.tokenizer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TF-IDF Pruner
// ─────────────────────────────────────────────────────────────────────────────

/** Compute term frequency map for a string. */
function termFrequency(text: string): Map<string, number> {
  const words = text.toLowerCase().match(/\b\w+\b/g) ?? [];
  const tf = new Map<string, number>();
  for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
  // Normalise by document length
  for (const [k, v] of tf) tf.set(k, v / words.length);
  return tf;
}

/** Cosine-like similarity: dot product of TF vectors. */
function tfScore(query: Map<string, number>, doc: Map<string, number>): number {
  let score = 0;
  for (const [term, qFreq] of query) {
    const dFreq = doc.get(term) ?? 0;
    score += qFreq * dFreq;
  }
  return score;
}

/**
 * Scores messages by TF relevance to the latest user message.
 * Always retains system + latest user message.
 * Remaining budget filled by highest-scoring messages.
 */
export class TFIDFPruner implements IContextPruner {
  constructor(private readonly tokenizer: ITokenizer = new NaiveTokenizer()) {}

  estimate(messages: Message[]): number {
    return totalTokens(messages, this.tokenizer);
  }

  async prune(
    messages: Message[],
    maxTokens: number,
    opts: PruneOptions = {},
  ): Promise<PruneResult> {
    const budget = maxTokens - (opts.reserveTokens ?? 0);
    const { system, rest } = extractSystem(messages);

    if (rest.length === 0) {
      const result = system ? [system] : [];
      return makeResult(result, messages, "tfidf", this.tokenizer);
    }

    // Always keep the last user message as anchor
    const lastUserIdx = [...rest].reverse().findIndex((m) => m.role === "user");
    const anchorIdx = lastUserIdx >= 0 ? rest.length - 1 - lastUserIdx : rest.length - 1;
    const anchor = rest[anchorIdx]!;
    const anchorTF = termFrequency(anchor.content);

    const candidates = rest.filter((_, i) => i !== anchorIdx);

    // Score each candidate
    const scored = candidates.map((msg) => ({
      msg,
      score: tfScore(anchorTF, termFrequency(msg.content)),
    }));
    scored.sort((a, b) => b.score - a.score);

    const systemTokens = system ? messageTokens(system, this.tokenizer) : 0;
    const anchorTokens = messageTokens(anchor, this.tokenizer);
    let remaining = budget - systemTokens - anchorTokens;

    const kept: Message[] = [];
    for (const { msg } of scored) {
      const cost = messageTokens(msg, this.tokenizer);
      if (remaining - cost >= 0) {
        kept.push(msg);
        remaining -= cost;
      }
    }

    // Reconstruct original order
    const keptSet = new Set(kept);
    const ordered = rest.filter((m) => m === anchor || keptSet.has(m));
    const result = system ? [system, ...ordered] : ordered;
    return makeResult(result, messages, "tfidf", this.tokenizer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ImportanceWeightedPruner
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_WEIGHT: Record<MessageRole, number> = {
  system: 10,
  user: 3,
  assistant: 1,
  tool: 2,
};

/**
 * Assigns importance score = roleWeight * recencyFactor.
 * Recency factor: position / total (most recent = highest).
 * Always keeps system message; fills budget by highest importance.
 */
export class ImportanceWeightedPruner implements IContextPruner {
  constructor(private readonly tokenizer: ITokenizer = new NaiveTokenizer()) {}

  estimate(messages: Message[]): number {
    return totalTokens(messages, this.tokenizer);
  }

  async prune(
    messages: Message[],
    maxTokens: number,
    opts: PruneOptions = {},
  ): Promise<PruneResult> {
    const budget = maxTokens - (opts.reserveTokens ?? 0);
    const { system, rest } = extractSystem(messages);

    if (rest.length === 0) {
      const result = system ? [system] : [];
      return makeResult(result, messages, "importance-weighted", this.tokenizer);
    }

    const systemTokens = system ? messageTokens(system, this.tokenizer) : 0;
    let remaining = budget - systemTokens;

    // Score by role weight × recency (1-indexed position / total)
    const scored = rest.map((msg, i) => ({
      msg,
      idx: i,
      score: (ROLE_WEIGHT[msg.role] ?? 1) * ((i + 1) / rest.length),
    }));
    scored.sort((a, b) => b.score - a.score);

    const kept: { msg: Message; idx: number }[] = [];
    for (const item of scored) {
      const cost = messageTokens(item.msg, this.tokenizer);
      if (remaining - cost >= 0) {
        kept.push(item);
        remaining -= cost;
      }
    }

    // Restore original order
    kept.sort((a, b) => a.idx - b.idx);
    const ordered = kept.map((k) => k.msg);
    const result = system ? [system, ...ordered] : ordered;
    return makeResult(result, messages, "importance-weighted", this.tokenizer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PrunerChain
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tries each pruner in order; returns the first result whose estimatedTokens
 * is ≤ maxTokens. Falls back to the last pruner's result if none satisfy.
 */
export class PrunerChain implements IContextPruner {
  constructor(private readonly pruners: IContextPruner[]) {
    if (pruners.length === 0)
      throw new PrunerError("PrunerChain requires at least one pruner", "EMPTY_CHAIN");
  }

  estimate(messages: Message[]): number {
    return this.pruners[0]!.estimate(messages);
  }

  async prune(messages: Message[], maxTokens: number, opts?: PruneOptions): Promise<PruneResult> {
    let last: PruneResult | undefined;
    for (const pruner of this.pruners) {
      const result = await pruner.prune(messages, maxTokens, opts);
      last = result;
      if (result.estimatedTokens <= maxTokens) return result;
    }
    return last!;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BudgetGuard — pre-flight check before LLM calls
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wraps any LLM provider and automatically prunes context before each call.
 * Uses the pruner to ensure messages fit within the model's context window.
 */
export type MessageRole2 = "system" | "user" | "assistant";
/** Llm message interface definition. */
export interface LLMMessage {
  role: MessageRole2;
  content: string;
}
/** Llm request interface definition. */
export interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
}
/** Llm response interface definition. */
export interface LLMResponse {
  id: string;
  model: string;
  content: string;
  provider: string;
  latencyMs: number;
}
/** Llm provider interface definition. */
export interface LLMProvider {
  readonly name: string;
  readonly models: readonly string[];
  complete(request: LLMRequest): Promise<LLMResponse>;
}

/** Budget guard options interface definition. */
export interface BudgetGuardOptions {
  /** Context window size in tokens. Default: 4096 */
  contextWindowTokens?: number;
  /** Reserve for completion. Default: 512 */
  reserveCompletionTokens?: number;
}

/** Budget guard. */
export class BudgetGuard implements LLMProvider {
  readonly name: string;
  readonly models: readonly string[];

  constructor(
    private readonly inner: LLMProvider,
    private readonly pruner: IContextPruner,
    private readonly opts: BudgetGuardOptions = {},
  ) {
    this.name = `budget-guarded(${inner.name})`;
    this.models = inner.models;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const contextWindow = this.opts.contextWindowTokens ?? 4096;
    const reserveCompletion = this.opts.reserveCompletionTokens ?? 512;
    const maxContextTokens = contextWindow - reserveCompletion;

    const currentTokens = this.pruner.estimate(request.messages as Message[]);

    let messages = request.messages as Message[];
    if (currentTokens > maxContextTokens) {
      const result = await this.pruner.prune(messages, maxContextTokens);
      messages = result.messages;
    }

    return this.inner.complete({ ...request, messages: messages as LLMMessage[] });
  }

  get contextPruner(): IContextPruner {
    return this.pruner;
  }
}
