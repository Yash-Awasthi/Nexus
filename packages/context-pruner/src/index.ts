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

// ── LlmCompactor ─────────────────────────────────────────────────────────────
//
// LLM-based lossless compaction. Instead of dropping old messages (permanent
// information loss), calls a fast LLM to summarise accumulated tool results
// into a structured 9-section summary. The summary replaces raw results in
// subsequent prompts while preserving all key data.
//
// Contrast with IContextPruner strategies above (destructive, no LLM call):
//   SlidingWindowPruner / TFIDFPruner / ImportanceWeightedPruner all drop msgs.
//   LlmCompactor summarises them — use when data fidelity matters.

/** Stop attempting compaction after this many consecutive failures. */
export const MAX_CONSECUTIVE_COMPACTION_FAILURES = 3;

/** Skip compaction when fewer tool results than this are present. */
export const MIN_TOOL_RESULTS_FOR_COMPACTION = 3;

// ── Prompt builders ───────────────────────────────────────────────────────────

const _NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use any tool calls. You already have all the context you need below.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

const _ANALYSIS_INSTRUCTION = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically review each tool call and its results. For each, thoroughly identify:
   - What data was requested and why
   - Key data points, numbers, and findings returned
   - Any errors, empty results, or unexpected responses
   - How this data relates to the user's original query
2. Double-check for numerical accuracy and completeness, addressing each required element thoroughly.`;

const _BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the research session below. This summary must preserve all important data, findings, and numerical results so that work can continue without losing context.

${_ANALYSIS_INSTRUCTION}

Your summary should include the following sections:

1. Original Query and Intent: The user's exact request and what they are trying to learn or accomplish.
2. Key Concepts: Important tickers, companies, sectors, financial metrics, or technical concepts involved.
3. Data Retrieved: For each tool call, summarize the tool name, arguments, and key results. Preserve important data points.
4. Errors and Retries: Any tool failures, empty results, or retried calls and their outcomes.
5. Analysis Progress: What has been analyzed so far, what conclusions or comparisons have been reached.
6. Numerical Data: ALL key numbers retrieved — prices, revenue figures, margins, ratios, growth rates, estimates, dates. This section is critical; do not omit any numbers that were returned by tools.
7. Pending Data Needs: What data has NOT yet been retrieved that would be needed to fully answer the query.
8. Current Work State: What was being worked on when this summary was requested.
9. Recommended Next Steps: What tool calls or analysis should happen next to complete the answer.

<example>
<analysis>
[Your thought process, ensuring all numerical data and findings are captured accurately]
</analysis>

<summary>
1. Original Query and Intent:
   [Detailed description of what the user asked]

2. Key Concepts:
   - [Ticker/concept 1]

3. Data Retrieved:
   - [tool_name(args)]: [Key findings and data points]

4. Errors and Retries:
   - [Error description and resolution, or "None"]

5. Analysis Progress:
   [What has been analyzed, comparisons made, conclusions reached]

6. Numerical Data:
   - [Ticker/metric]: [value] ([date/period])

7. Pending Data Needs:
   - [Data still needed]

8. Current Work State:
   [What was being worked on]

9. Recommended Next Steps:
   [Next actions to take]
</summary>
</example>

Please provide your summary based on the research session below, following this structure and ensuring precision and thoroughness — especially for numerical data.`;

const _NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — ' +
  'an <analysis> block followed by a <summary> block. ' +
  'Tool calls will be rejected and you will fail the task.';

/**
 * Build the prompt sent to the fast LLM for compaction.
 * @param query       Original user query driving the research session.
 * @param toolResults Formatted string of tool call results to summarise.
 */
export function buildCompactionPrompt(query: string, toolResults: string): string {
  return `${_NO_TOOLS_PREAMBLE}${_BASE_COMPACT_PROMPT}

Original query: ${query}

Data retrieved from tool calls:
${toolResults}${_NO_TOOLS_TRAILER}`;
}

/**
 * Strip the `<analysis>` scratchpad and clean up the `<summary>` section.
 * The analysis block improves summary quality but has no value once written.
 */
export function formatCompactSummary(rawSummary: string): string {
  let formatted = rawSummary;
  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/, '');
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    const content = summaryMatch[1] ?? '';
    formatted = formatted.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${content.trim()}`,
    );
  }
  formatted = formatted.replace(/\n\n+/g, '\n\n');
  return formatted.trim();
}

/**
 * Wrap a compaction summary in a continuation framing message.
 * Instructs the model to resume work without acknowledging the context break.
 */
export function buildCompactSummaryMessage(summary: string): string {
  const formatted = formatCompactSummary(summary);
  return `This session is being continued from a previous research session that ran out of context. The summary below covers the data retrieved and analysis performed so far.

${formatted}

Continue working toward answering the query without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening. Pick up the research as if the break never happened.`;
}

// ── LlmCompactor types ────────────────────────────────────────────────────────

/** Injectable LLM caller — implement with any provider (Anthropic, OpenAI, etc.). */
export interface ILlmCaller {
  /**
   * Call the fast model and return the plain-text response.
   * @param prompt Full prompt string (no tools bound).
   * @param opts   Optional model override and abort signal.
   */
  call(
    prompt: string,
    opts?: { model?: string; signal?: AbortSignal },
  ): Promise<string>;
}

export interface LlmCompactParams {
  /** Original user query (injected into the compaction prompt). */
  query: string;
  /** Formatted tool results to be summarised. */
  toolResults: string;
  /** Model override (e.g. "claude-haiku-4-5"). */
  model?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

export interface LlmCompactResult {
  ok: true;
  /** Framed summary ready for injection into the conversation history. */
  summary: string;
  /** Raw LLM response (for debugging / logging). */
  rawSummary: string;
}

export interface LlmCompactError {
  ok: false;
  error: Error;
}

/**
 * LLM-based lossless context compaction.
 *
 * Calls an injected LLM to summarise accumulated tool results into a
 * structured 9-section summary rather than dropping messages. Use when
 * data fidelity matters more than speed.
 *
 * @example
 * ```ts
 * const caller: ILlmCaller = {
 *   async call(prompt, opts) {
 *     const resp = await anthropic.messages.create({
 *       model: opts?.model ?? 'claude-haiku-4-5',
 *       max_tokens: 4096,
 *       messages: [{ role: 'user', content: prompt }],
 *     });
 *     return resp.content[0].type === 'text' ? resp.content[0].text : '';
 *   },
 * };
 * const compactor = new LlmCompactor(caller);
 * const result = await compactor.compact({ query, toolResults });
 * if (result.ok) history.push({ role: 'user', content: result.summary });
 * else fallbackToPrune();
 * ```
 */
export class LlmCompactor {
  private _consecutiveFailures = 0;

  constructor(private readonly _caller: ILlmCaller) {}

  get consecutiveFailures(): number {
    return this._consecutiveFailures;
  }

  /** True when too many consecutive failures have occurred — skip compaction. */
  get isBlocked(): boolean {
    return this._consecutiveFailures >= MAX_CONSECUTIVE_COMPACTION_FAILURES;
  }

  /** Reset the consecutive failure counter after a successful non-compact turn. */
  resetFailures(): void {
    this._consecutiveFailures = 0;
  }

  async compact(params: LlmCompactParams): Promise<LlmCompactResult | LlmCompactError> {
    if (this.isBlocked) {
      return {
        ok: false,
        error: new PrunerError(
          `LlmCompactor blocked after ${MAX_CONSECUTIVE_COMPACTION_FAILURES} consecutive failures`,
          'COMPACTOR_BLOCKED',
        ),
      };
    }

    try {
      const prompt = buildCompactionPrompt(params.query, params.toolResults);
      const rawSummary = await this._caller.call(prompt, {
        model: params.model,
        signal: params.signal,
      });

      if (!rawSummary.trim()) {
        throw new PrunerError('Compaction returned empty response', 'EMPTY_RESPONSE');
      }

      this._consecutiveFailures = 0;
      return {
        ok: true,
        summary: buildCompactSummaryMessage(rawSummary),
        rawSummary,
      };
    } catch (err) {
      this._consecutiveFailures++;
      return {
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }
}

// ── MicroCompactor ────────────────────────────────────────────────────────────
//
// Per-turn lightweight trimming. Unlike LlmCompactor (which calls an LLM),
// MicroCompactor simply replaces old tool-result content with a cleared marker.
// Runs cheaply every turn to prevent gradual context bloat.
//
// Two triggers:
//   count — fires when compactable tool messages exceed COUNT_TRIGGER_THRESHOLD
//   token — fires when their estimated token total exceeds TOKEN_TRIGGER_THRESHOLD
//
// Usage: run MicroCompactor every turn for cheap incremental trimming;
//        run LlmCompactor at major thresholds for lossless deep compaction.

/** Marker text replacing cleared tool-result content. */
export const MC_CLEARED_MESSAGE = '[Old tool result content cleared]';

/** Fire when compactable tool messages exceed this count. */
export const COUNT_TRIGGER_THRESHOLD = 8;

/** Keep this many most-recent compactable tool messages when count trigger fires. */
export const COUNT_KEEP_RECENT = 4;

/** Fire when total compactable tool-message content exceeds this estimated token count. */
export const TOKEN_TRIGGER_THRESHOLD = 80_000;

/** Extended Message type with optional tool name for MicroCompactor routing. */
export interface ToolMessage extends Message {
  role: 'tool';
  /** Name of the tool that produced this result — used for compactability check. */
  toolName: string;
}

export interface MicroCompactResult {
  messages: Message[];
  /** Number of tool messages whose content was cleared. */
  cleared: number;
  /** Estimated tokens saved. */
  estimatedTokensSaved: number;
  /** Which trigger fired, or null if nothing was cleared. */
  trigger: 'count' | 'token' | null;
}

/**
 * Per-turn lightweight trimming of old tool-result content.
 *
 * @param messages         Current message history.
 * @param compactableTools Set of tool names whose results can be safely cleared
 *                         (read-only retrieval tools). Caller owns this set so
 *                         different agents can define different policies.
 *
 * Returns the original array reference if no changes are needed (zero-alloc
 * fast path). Returns a shallow-copied array with cleared messages if triggered.
 */
export function microCompact(
  messages: Message[],
  compactableTools: Set<string>,
): MicroCompactResult {
  // Collect indices of clearable tool messages with non-cleared content
  const compactableIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (
      msg.role === 'tool' &&
      compactableTools.has((msg as ToolMessage).toolName ?? '') &&
      msg.content !== MC_CLEARED_MESSAGE
    ) {
      compactableIndices.push(i);
    }
  }

  // Count-based trigger
  const countTriggered = compactableIndices.length > COUNT_TRIGGER_THRESHOLD;

  // Token-based trigger (catches few-but-large results)
  let totalTokens = 0;
  if (!countTriggered) {
    for (const idx of compactableIndices) {
      totalTokens += Math.ceil(messages[idx].content.length / 3.5);
    }
  }
  const tokenTriggered = !countTriggered && totalTokens > TOKEN_TRIGGER_THRESHOLD;

  if (!countTriggered && !tokenTriggered) {
    return { messages, cleared: 0, estimatedTokensSaved: 0, trigger: null };
  }

  // Keep most recent COUNT_KEEP_RECENT, clear the rest
  const keepSet = new Set(compactableIndices.slice(-COUNT_KEEP_RECENT));
  const clearIndices = compactableIndices.filter(i => !keepSet.has(i));

  if (clearIndices.length === 0) {
    return { messages, cleared: 0, estimatedTokensSaved: 0, trigger: null };
  }

  let tokensSaved = 0;
  const clearSet = new Set(clearIndices);

  const newMessages = messages.map((msg, i) => {
    if (clearSet.has(i)) {
      tokensSaved += Math.ceil(msg.content.length / 3.5);
      return { ...msg, content: MC_CLEARED_MESSAGE };
    }
    return msg;
  });

  return {
    messages: newMessages,
    cleared: clearIndices.length,
    estimatedTokensSaved: tokensSaved,
    trigger: countTriggered ? 'count' : 'token',
  };
}

// ── Compaction budget constants (from jcode-compaction-core) ──────────────────
//
// Production-tuned constants for token budget management, image cost estimation,
// and threshold-based compaction triggers. Extracted from jcode's compaction
// subsystem; complement the LlmCompactor + MicroCompactor above.
//
// Key insight: IMAGE_TOKEN_COST uses a flat per-image token budget (1,600) rather
// than estimating from base64 byte length. Using raw byte length massively
// overestimates real provider cost (images are tokenized by resolution, ~1-2k
// tokens regardless of base64 size), causing spurious triple compactions.

/** Default context token budget — matches Claude's actual context limit. */
export const DEFAULT_TOKEN_BUDGET = 200_000;

/** Trigger background compaction at this fraction of the token budget. */
export const COMPACTION_THRESHOLD = 0.80;

/**
 * If context exceeds this fraction when compaction starts, perform a
 * synchronous hard compact (drop old messages) so the next API call fits.
 */
export const CRITICAL_THRESHOLD = 0.95;

/** Minimum context usage fraction required for manual compaction. */
export const MANUAL_COMPACT_MIN_THRESHOLD = 0.10;

/** Keep this many recent turns verbatim (not summarised). */
export const RECENT_TURNS_TO_KEEP = 10;

/** Absolute minimum turns to keep during emergency compaction. */
export const MIN_TURNS_TO_KEEP = 2;

/** Max chars for a single tool result during emergency truncation. */
export const EMERGENCY_TOOL_RESULT_MAX_CHARS = 4_000;

/** Max chars for an inline image payload during emergency recovery. */
export const EMERGENCY_IMAGE_MAX_CHARS = 1_024;

/**
 * Max base64 char budget for all inline images before a 413 retry.
 * Anthropic rejects requests whose serialised body exceeds ~32 MB;
 * this targets a conservative budget well under the hard provider cap.
 */
export const PAYLOAD_IMAGE_CHAR_BUDGET = 12 * 1024 * 1024;

/** Approximate chars per token for text estimation. */
export const CHARS_PER_TOKEN = 4;

/**
 * Flat per-image token cost for budget accounting.
 *
 * Providers tokenise images by resolution (~1-2k tokens), NOT by base64 byte
 * length. Charging `base64.length / 4` overestimates by 10-100×, spuriously
 * tripping the compaction threshold and causing repeated back-to-back compactions
 * that can't reduce the estimate (images stay in the kept tail). Use this flat
 * budget instead.
 */
export const IMAGE_TOKEN_COST = 1_600;

/**
 * Fixed token overhead for system prompt + tool definitions.
 * Not counted in message content but does count toward the context limit.
 * Conservative estimate: ~8k system + ~10k for 50+ tool definitions.
 */
export const SYSTEM_OVERHEAD_TOKENS = 18_000;

/**
 * Natural-language compaction summary prompt (4-section format).
 * Alternative to the structured 9-section prompt in buildCompactionPrompt() —
 * use when a conversational summary is preferred over a research-report format.
 */
export const NATURAL_SUMMARY_PROMPT =
  `Summarize our conversation so you can continue this work later.\n\n` +
  `Write in natural language with these sections:\n` +
  `- **Context:** What we're working on and why (1-2 sentences)\n` +
  `- **What we did:** Key actions taken, files changed, problems solved\n` +
  `- **Current state:** What works, what's broken, what's next\n` +
  `- **User preferences:** Specific requirements or decisions they made\n\n` +
  `Be concise but preserve important details. You can search the full ` +
  `conversation later if you need exact error messages or code snippets.`;

/** Wrap a compaction summary in a standard markdown section header. */
export function compactedSummaryBlock(summary: string): string {
  return `## Previous Conversation Summary\n\n${summary}\n\n---\n\n`;
}

// ── Compaction telemetry types ────────────────────────────────────────────────

/** Point-in-time snapshot of compaction state for monitoring/UI. */
export interface CompactionStats {
  totalTurns: number;
  activeMessages: number;
  hasSummary: boolean;
  isCompacting: boolean;
  tokenEstimate: number;
  /** Tokens after applying IMAGE_TOKEN_COST flat cost for images. */
  effectiveTokens: number;
  /** Actual input tokens reported by provider on last call (if available). */
  observedInputTokens?: number;
  /** effectiveTokens / DEFAULT_TOKEN_BUDGET. */
  contextUsage: number;
}

/** Event emitted when compaction is applied. All fields optional for partial telemetry. */
export interface CompactionEvent {
  trigger: string;
  preTokens?: number;
  postTokens?: number;
  tokensSaved?: number;
  durationMs?: number;
  messagesDropped?: number;
  messagesCompacted?: number;
  summaryChars?: number;
  activeMessages?: number;
}

/** Result of an `ensureContextFits` check. */
export type CompactionAction =
  | { kind: "none" }
  | { kind: "background_started"; trigger: string }
  | { kind: "hard_compacted"; messagesDropped: number };

/** A completed LLM-generated summary covering turns up to a certain point. */
export interface CompactionSummary {
  text: string;
  /** Provider-encrypted content for stateless replay (e.g. OpenAI `store=false`). */
  encryptedContent?: string;
  /** Index of the last turn covered by this summary. */
  coversUpToTurn: number;
  /** How many turns were summarised. */
  originalTurnCount: number;
}
