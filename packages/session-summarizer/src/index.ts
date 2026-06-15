// SPDX-License-Identifier: Apache-2.0

// ── Types ─────────────────────────────────────────────────────────────────────

export type MessageRole = "system" | "user" | "assistant" | "tool";

/** Message interface definition. */
export interface Message {
  role: MessageRole;
  content: string;
  id?: string;
}

// ── Tokenizer (injectable, minimal subset) ────────────────────────────────────

export interface ITokenizer {
  count(text: string): number;
}

/** Naive tokenizer. */
export class NaiveTokenizer implements ITokenizer {
  count(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// ── LLM types (injectable) ────────────────────────────────────────────────────

export interface LLMRequest {
  model: string;
  messages: Message[];
  maxTokens?: number;
  [key: string]: unknown;
}

/** Llm response interface definition. */
export interface LLMResponse {
  id: string;
  model: string;
  content: string;
  provider: string;
  latencyMs?: number;
}

/** Llm provider interface definition. */
export interface LLMProvider {
  name: string;
  models: string[];
  complete(req: LLMRequest): Promise<LLMResponse>;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface SummaryOpts {
  /** Max tokens the summary response should use (hint passed to LLM). */
  maxSummaryTokens?: number;
  /** Number of most-recent messages to keep verbatim after summarizing. Default: 4. */
  keepRecentCount?: number;
  /**
   * Override the summarization instruction injected as a user turn.
   * Use {count} as a placeholder for the message count being summarized.
   */
  summaryInstruction?: string;
  /** Model to use (defaults to first model in provider.models). */
  model?: string;
}

/** Compress result interface definition. */
export interface CompressResult {
  messages: Message[];
  summary: string;
  originalCount: number;
  /** Number of messages kept verbatim (system + recent tail). */
  keptCount: number;
  /** Number of messages replaced by the summary. */
  summarizedCount: number;
}

const DEFAULT_INSTRUCTION =
  "Summarize the preceding {count} conversation messages into a concise paragraph. " +
  "Preserve key facts, decisions, and context. Be brief.";

// ── Interface ─────────────────────────────────────────────────────────────────

export interface ISessionSummarizer {
  summarize(messages: Message[], opts?: SummaryOpts): Promise<string>;
  compress(messages: Message[], opts?: SummaryOpts): Promise<CompressResult>;
  shouldCompress(messages: Message[], tokenBudget: number): boolean;
}

// ── LLMSessionSummarizer ──────────────────────────────────────────────────────

export class LLMSessionSummarizer implements ISessionSummarizer {
  private readonly tokenizer: ITokenizer;

  constructor(
    private readonly provider: LLMProvider,
    tokenizer?: ITokenizer,
  ) {
    this.tokenizer = tokenizer ?? new NaiveTokenizer();
  }

  private _estimateTokens(messages: Message[]): number {
    return messages.reduce((sum, m) => sum + this.tokenizer.count(m.content), 0);
  }

  shouldCompress(messages: Message[], tokenBudget: number): boolean {
    return this._estimateTokens(messages) > tokenBudget;
  }

  async summarize(messages: Message[], opts: SummaryOpts = {}): Promise<string> {
    const model = opts.model ?? this.provider.models[0] ?? "gpt-4o";
    const instruction = (opts.summaryInstruction ?? DEFAULT_INSTRUCTION).replace(
      "{count}",
      String(messages.length),
    );

    const req: LLMRequest = {
      model,
      messages: [
        ...messages,
        { role: "user", content: instruction },
      ],
      ...(opts.maxSummaryTokens !== undefined ? { maxTokens: opts.maxSummaryTokens } : {}),
    };

    const res = await this.provider.complete(req);
    return res.content.trim();
  }

  async compress(messages: Message[], opts: SummaryOpts = {}): Promise<CompressResult> {
    const keepRecent = opts.keepRecentCount ?? 4;

    // Separate system message, body, and recent tail
    const systemMessages = messages.filter((m) => m.role === "system");
    const nonSystem = messages.filter((m) => m.role !== "system");

    // If there's not enough to summarize, return as-is
    if (nonSystem.length <= keepRecent) {
      return {
        messages,
        summary: "",
        originalCount: messages.length,
        keptCount: messages.length,
        summarizedCount: 0,
      };
    }

    const toSummarize = nonSystem.slice(0, nonSystem.length - keepRecent);
    const recentTail = nonSystem.slice(nonSystem.length - keepRecent);

    const summary = await this.summarize(toSummarize, opts);

    const summaryMessage: Message = {
      role: "assistant",
      content: `[Summary of earlier conversation]\n${summary}`,
    };

    return {
      messages: [...systemMessages, summaryMessage, ...recentTail],
      summary,
      originalCount: messages.length,
      keptCount: systemMessages.length + recentTail.length,
      summarizedCount: toSummarize.length,
    };
  }
}

// ── FixedSummarizer (for testing) ─────────────────────────────────────────────

/** Always returns a fixed summary string. Useful for unit tests. */
export class FixedSummarizer implements ISessionSummarizer {
  constructor(
    private readonly fixedSummary = "Summary of prior conversation.",
    private readonly tokenizer: ITokenizer = new NaiveTokenizer(),
  ) {}

  async summarize(_messages: Message[], _opts?: SummaryOpts): Promise<string> {
    return this.fixedSummary;
  }

  async compress(messages: Message[], opts: SummaryOpts = {}): Promise<CompressResult> {
    const keepRecent = opts.keepRecentCount ?? 4;
    const systemMessages = messages.filter((m) => m.role === "system");
    const nonSystem = messages.filter((m) => m.role !== "system");

    if (nonSystem.length <= keepRecent) {
      return {
        messages,
        summary: "",
        originalCount: messages.length,
        keptCount: messages.length,
        summarizedCount: 0,
      };
    }

    const toSummarize = nonSystem.slice(0, nonSystem.length - keepRecent);
    const recentTail = nonSystem.slice(nonSystem.length - keepRecent);

    const summary = this.fixedSummary;
    const summaryMessage: Message = {
      role: "assistant",
      content: `[Summary of earlier conversation]\n${summary}`,
    };

    return {
      messages: [...systemMessages, summaryMessage, ...recentTail],
      summary,
      originalCount: messages.length,
      keptCount: systemMessages.length + recentTail.length,
      summarizedCount: toSummarize.length,
    };
  }

  shouldCompress(messages: Message[], tokenBudget: number): boolean {
    const total = messages.reduce((sum, m) => sum + this.tokenizer.count(m.content), 0);
    return total > tokenBudget;
  }
}

// ── SummarizerError ───────────────────────────────────────────────────────────

export class SummarizerError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "SummarizerError";
    this.code = code;
  }
}

// ── AutoCompressor ────────────────────────────────────────────────────────────

/**
 * Wraps an ISessionSummarizer with auto-trigger logic.
 * Automatically compresses when token usage exceeds `triggerBudget`.
 */
export class AutoCompressor {
  constructor(
    private readonly summarizer: ISessionSummarizer,
    private readonly triggerBudget: number,
  ) {}

  /**
   * Return messages, compressing if needed.
   * @param messages  Full message history.
   * @param opts      Options forwarded to compress().
   */
  async maybeCompress(messages: Message[], opts?: SummaryOpts): Promise<CompressResult> {
    if (!this.summarizer.shouldCompress(messages, this.triggerBudget)) {
      return {
        messages,
        summary: "",
        originalCount: messages.length,
        keptCount: messages.length,
        summarizedCount: 0,
      };
    }
    return this.summarizer.compress(messages, opts);
  }
}
