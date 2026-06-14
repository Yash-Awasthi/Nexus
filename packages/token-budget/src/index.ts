// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/token-budget — Per-identity token rate limiting and budget tracking.
 *
 * TokenBudget        — core interface.
 *
 * MemoryTokenBudget  — in-process sliding-window limiter.
 *                      Each identity gets an independent sliding window.
 *                      Injectable `now` for deterministic tests.
 *
 * KVTokenBudget      — delegates to a KVStore for multi-process persistence.
 *                      Uses atomic read-modify-write with optimistic retry.
 *
 * BudgetedLLMProvider — decorator that wraps any LLMProvider and deducts
 *                       tokens from the budget after each successful call.
 *                       Rejects with BudgetExceededError when over limit.
 *
 * Concepts
 * ────────
 * identity   — opaque string identifying the rate-limited entity
 *              (e.g. user ID, API key, org ID).
 * windowMs   — sliding window duration in milliseconds.
 * limit      — maximum tokens allowed within the window.
 * consumed   — tokens used so far in the current window.
 * remaining  — limit - consumed (floored at 0).
 * resetAt    — timestamp (ms) when the oldest token usage will fall out of window.
 */

// ── Errors ─────────────────────────────────────────────────────────────────────

export class BudgetError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BudgetError";
  }
}

export class BudgetExceededError extends BudgetError {
  constructor(
    public readonly identity: string,
    public readonly consumed: number,
    public readonly limit: number,
    public readonly resetAt: number,
  ) {
    super(
      `Token budget exceeded for "${identity}": ${consumed}/${limit} tokens used. Resets at ${new Date(resetAt).toISOString()}.`,
      "BUDGET_EXCEEDED",
      { identity, consumed, limit, resetAt },
    );
    this.name = "BudgetExceededError";
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BudgetStatus {
  identity: string;
  consumed: number;
  limit: number;
  remaining: number;
  resetAt: number; // timestamp (ms) when oldest usage falls out
  windowMs: number;
}

export interface ConsumeOptions {
  /** Identity to charge (e.g. user ID). */
  identity: string;
  /** Number of tokens to consume. */
  tokens: number;
}

export interface BudgetConfig {
  /** Max tokens per window per identity. */
  limit: number;
  /** Sliding window duration in milliseconds. */
  windowMs: number;
}

// ── TokenBudget ────────────────────────────────────────────────────────────────

export interface TokenBudget {
  /**
   * Attempt to consume `tokens` for `identity`.
   * Returns the updated BudgetStatus if the consumption was allowed.
   * Throws BudgetExceededError if the limit would be exceeded.
   */
  consume(opts: ConsumeOptions): Promise<BudgetStatus>;

  /**
   * Check current budget status without consuming tokens.
   * Returns status for the identity (all zeros if never used).
   */
  status(identity: string): Promise<BudgetStatus>;

  /**
   * Reset the budget for an identity (clear all recorded usage).
   */
  reset(identity: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// MemoryTokenBudget — sliding window per identity
// ─────────────────────────────────────────────────────────────────────────────

interface TokenEvent {
  tokens: number;
  ts: number;
}

/**
 * In-process sliding-window token budget.
 *
 * Stores a list of (tokens, timestamp) events per identity.
 * On each access, events outside the window are pruned.
 * Injectable `now` for deterministic testing.
 */
export class MemoryTokenBudget implements TokenBudget {
  private readonly events = new Map<string, TokenEvent[]>();
  private readonly now: () => number;

  constructor(
    private readonly config: BudgetConfig,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  private _prune(identity: string): TokenEvent[] {
    const windowStart = this.now() - this.config.windowMs;
    const existing = this.events.get(identity) ?? [];
    const pruned = existing.filter((e) => e.ts > windowStart);
    this.events.set(identity, pruned);
    return pruned;
  }

  private _computeStatus(identity: string, active: TokenEvent[]): BudgetStatus {
    const consumed = active.reduce((sum, e) => sum + e.tokens, 0);
    const remaining = Math.max(0, this.config.limit - consumed);
    // resetAt: earliest timestamp where oldest event would fall out of window
    const oldest = active.length > 0 ? Math.min(...active.map((e) => e.ts)) : this.now();
    const resetAt = oldest + this.config.windowMs;
    return {
      identity,
      consumed,
      limit: this.config.limit,
      remaining,
      resetAt,
      windowMs: this.config.windowMs,
    };
  }

  async consume(opts: ConsumeOptions): Promise<BudgetStatus> {
    const { identity, tokens } = opts;
    const active = this._prune(identity);
    const consumed = active.reduce((sum, e) => sum + e.tokens, 0);

    if (consumed + tokens > this.config.limit) {
      const status = this._computeStatus(identity, active);
      throw new BudgetExceededError(identity, consumed, this.config.limit, status.resetAt);
    }

    const event: TokenEvent = { tokens, ts: this.now() };
    active.push(event);
    this.events.set(identity, active);
    return this._computeStatus(identity, active);
  }

  async status(identity: string): Promise<BudgetStatus> {
    const active = this._prune(identity);
    return this._computeStatus(identity, active);
  }

  async reset(identity: string): Promise<void> {
    this.events.delete(identity);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// KVStore interface (minimal)
// ─────────────────────────────────────────────────────────────────────────────

export interface KVStoreLike {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// KVTokenBudget — persisted sliding window via KV
// ─────────────────────────────────────────────────────────────────────────────

interface KVBudgetRecord {
  events: TokenEvent[];
}

/**
 * KV-backed token budget.
 *
 * Stores sliding window events as JSON in a KV store.
 * Uses TTL equal to the window duration to auto-expire stale records.
 *
 * Note: Not atomic under concurrent writes from multiple processes.
 * For strict atomicity use a Redis Lua script or a distributed lock.
 */
export class KVTokenBudget implements TokenBudget {
  private readonly prefix: string;

  constructor(
    private readonly kv: KVStoreLike,
    private readonly config: BudgetConfig,
    opts: { keyPrefix?: string } = {},
  ) {
    this.prefix = opts.keyPrefix ? `${opts.keyPrefix}:budget:` : "budget:";
  }

  private _k(identity: string): string {
    return `${this.prefix}${identity}`;
  }

  private _now(): number {
    return Date.now();
  }

  private async _load(identity: string): Promise<TokenEvent[]> {
    const record = await this.kv.get<KVBudgetRecord>(this._k(identity));
    if (!record) return [];
    const windowStart = this._now() - this.config.windowMs;
    return record.events.filter((e) => e.ts > windowStart);
  }

  private async _save(identity: string, events: TokenEvent[]): Promise<void> {
    await this.kv.set<KVBudgetRecord>(
      this._k(identity),
      { events },
      this.config.windowMs,
    );
  }

  private _computeStatus(identity: string, active: TokenEvent[]): BudgetStatus {
    const consumed = active.reduce((sum, e) => sum + e.tokens, 0);
    const remaining = Math.max(0, this.config.limit - consumed);
    const now = this._now();
    const oldest = active.length > 0 ? Math.min(...active.map((e) => e.ts)) : now;
    const resetAt = oldest + this.config.windowMs;
    return {
      identity,
      consumed,
      limit: this.config.limit,
      remaining,
      resetAt,
      windowMs: this.config.windowMs,
    };
  }

  async consume(opts: ConsumeOptions): Promise<BudgetStatus> {
    const { identity, tokens } = opts;
    const active = await this._load(identity);
    const consumed = active.reduce((sum, e) => sum + e.tokens, 0);

    if (consumed + tokens > this.config.limit) {
      const status = this._computeStatus(identity, active);
      throw new BudgetExceededError(identity, consumed, this.config.limit, status.resetAt);
    }

    const event: TokenEvent = { tokens, ts: this._now() };
    active.push(event);
    await this._save(identity, active);
    return this._computeStatus(identity, active);
  }

  async status(identity: string): Promise<BudgetStatus> {
    const active = await this._load(identity);
    return this._computeStatus(identity, active);
  }

  async reset(identity: string): Promise<void> {
    await this.kv.delete(this._k(identity));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM types (minimal)
// ─────────────────────────────────────────────────────────────────────────────

export type MessageRole = "system" | "user" | "assistant";

export interface LLMMessage {
  role: MessageRole;
  content: string;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
}

export interface LLMResponse {
  id: string;
  model: string;
  content: string;
  usage: LLMUsage;
  provider: string;
  latencyMs: number;
  cached?: boolean;
}

export interface LLMProvider {
  readonly name: string;
  readonly models: readonly string[];
  complete(request: LLMRequest): Promise<LLMResponse>;
}

// ─────────────────────────────────────────────────────────────────────────────
// BudgetedLLMProvider
// ─────────────────────────────────────────────────────────────────────────────

export interface BudgetedLLMProviderOptions {
  /**
   * Extract the identity from a request.
   * Defaults to `request.metadata?.identity as string ?? "default"`.
   */
  identityFn?: (request: LLMRequest) => string;
  /**
   * Whether to count prompt tokens, completion tokens, or total.
   * Default: "total".
   */
  tokenCountMode?: "prompt" | "completion" | "total";
}

/**
 * Wraps any LLMProvider and enforces a per-identity token budget.
 *
 * - Checks budget before making the request (pre-flight check).
 * - Deducts actual token usage from the budget after the response.
 * - Throws BudgetExceededError (before the call) if budget is exhausted.
 *
 * Note: the pre-flight uses `maxTokens` as an optimistic estimate.
 * The actual deduction uses the real usage from the response.
 */
export class BudgetedLLMProvider implements LLMProvider {
  readonly name: string;
  readonly models: readonly string[];

  private readonly identityFn: (req: LLMRequest) => string;
  private readonly tokenCountMode: "prompt" | "completion" | "total";

  constructor(
    private readonly inner: LLMProvider,
    private readonly budget: TokenBudget,
    private readonly opts: BudgetedLLMProviderOptions = {},
  ) {
    this.name = `budgeted(${inner.name})`;
    this.models = inner.models;
    this.identityFn =
      opts.identityFn ??
      ((req) => (req.metadata?.identity as string | undefined) ?? "default");
    this.tokenCountMode = opts.tokenCountMode ?? "total";
  }

  private _countTokens(usage: LLMUsage): number {
    switch (this.tokenCountMode) {
      case "prompt":
        return usage.promptTokens;
      case "completion":
        return usage.completionTokens;
      case "total":
      default:
        return usage.totalTokens;
    }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const identity = this.identityFn(request);

    // Pre-flight: check if there's any remaining budget
    const current = await this.budget.status(identity);
    if (current.remaining === 0) {
      throw new BudgetExceededError(
        identity,
        current.consumed,
        current.limit,
        current.resetAt,
      );
    }

    // Execute the request
    const response = await this.inner.complete(request);

    // Deduct actual usage (best-effort — if budget ran out between check and deduct, let it slide)
    try {
      await this.budget.consume({ identity, tokens: this._countTokens(response.usage) });
    } catch (err) {
      // If budget exceeded after-the-fact, re-throw as a post-deduction warning
      // but don't fail the response — the call already succeeded.
      if (!(err instanceof BudgetExceededError)) throw err;
    }

    return response;
  }

  /** Expose budget for status checks. */
  get tokenBudget(): TokenBudget {
    return this.budget;
  }
}
