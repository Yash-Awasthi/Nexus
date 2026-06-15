// SPDX-License-Identifier: Apache-2.0
/**
 * stream-recovery — Production-grade stream failure recovery.
 *
 * Provides:
 *   • HoldbackBuffer      — delayed-emit buffer (prevents premature truncation events)
 *   • ToolJsonRepair      — append-only JSON repair for truncated tool call JSON
 *   • ContinuationSuffix  — injects continuation tokens into truncated streams
 *   • RetryStrategy       — exponential backoff config for mid-stream retries
 *   • StreamRetryHandler  — 5-attempt mid-stream retry with backoff
 *   • SseBlock            — open SSE block (event/data being buffered)
 *   • EmittedSseTracker   — tracks open blocks, closes them on error/stream-end
 *   • StreamRecoveryOrchestrator — assembles all primitives into one facade
 */

// ── HoldbackBuffer ────────────────────────────────────────────────────────────

export interface HoldbackOptions {
  holdMs: number;   // default 750ms
}

/** Held chunk interface definition. */
export interface HeldChunk<T> {
  value: T;
  heldAt: number;
}

/** Holdback buffer. */
export class HoldbackBuffer<T> {
  private queue: HeldChunk<T>[] = [];
  private holdMs: number;

  constructor(opts: HoldbackOptions = { holdMs: 750 }) {
    this.holdMs = opts.holdMs;
  }

  push(value: T): void {
    this.queue.push({ value, heldAt: Date.now() });
  }

  /** Return chunks that have been held for >= holdMs and remove them from queue. */
  drain(now = Date.now()): T[] {
    const ready: T[] = [];
    const remaining: HeldChunk<T>[] = [];
    for (const item of this.queue) {
      if (now - item.heldAt >= this.holdMs) ready.push(item.value);
      else remaining.push(item);
    }
    this.queue = remaining;
    return ready;
  }

  /** Force-drain all items regardless of hold time. */
  flush(): T[] {
    const all = this.queue.map((h) => h.value);
    this.queue = [];
    return all;
  }

  size(): number { return this.queue.length; }
  setHoldMs(ms: number): void { this.holdMs = ms; }
  getHoldMs(): number { return this.holdMs; }
}

// ── ToolJsonRepair ────────────────────────────────────────────────────────────

export interface RepairResult {
  repaired: string;
  wasRepaired: boolean;
  error?: string;
}

/** Tool json repair. */
export class ToolJsonRepair {
  /**
   * Attempt to repair truncated JSON by appending missing closers.
   * Strategy: append-only (never remove characters).
   */
  repair(partialJson: string): RepairResult {
    // First try: it's already valid
    try {
      JSON.parse(partialJson);
      return { repaired: partialJson, wasRepaired: false };
    } catch {
      // continue
    }

    let text = partialJson.trimEnd();

    // Count open structures
    let openBraces = 0;
    let openBrackets = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (escape) { escape = false; continue; }
      if (ch === "\\" && inString) { escape = true; continue; }
      if (ch === '"' && !escape) { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") openBraces++;
      else if (ch === "}") openBraces--;
      else if (ch === "[") openBrackets++;
      else if (ch === "]") openBrackets--;
    }

    // If we're in an unclosed string, close it
    if (inString) text += '"';

    // Append missing closers
    const closers = "]".repeat(Math.max(0, openBrackets)) + "}".repeat(Math.max(0, openBraces));
    const candidate = text + closers;

    try {
      JSON.parse(candidate);
      return { repaired: candidate, wasRepaired: true };
    } catch (err) {
      return {
        repaired: partialJson,
        wasRepaired: false,
        error: `Repair failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

// ── ContinuationSuffix ────────────────────────────────────────────────────────

export const DEFAULT_CONTINUATION_SUFFIXES: Record<string, string> = {
  markdown: "\n\n*[Stream interrupted — continuing...]*\n\n",
  json:     ',"_continuation":true}',
  plain:    " [...]",
};

/** Continuation suffix. */
export class ContinuationSuffix {
  private suffixes: Record<string, string>;

  constructor(suffixes?: Record<string, string>) {
    this.suffixes = suffixes ?? DEFAULT_CONTINUATION_SUFFIXES;
  }

  inject(text: string, mode: string = "plain"): string {
    const suffix = this.suffixes[mode] ?? this.suffixes["plain"] ?? " [...]";
    return text + suffix;
  }

  getSuffix(mode: string): string {
    return this.suffixes[mode] ?? this.suffixes["plain"] ?? " [...]";
  }
}

// ── RetryStrategy ─────────────────────────────────────────────────────────────

export interface RetryStrategyOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs?: number;
  backoffFactor?: number;
}

/** Retry strategy. */
export class RetryStrategy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffFactor: number;

  constructor(opts: RetryStrategyOptions) {
    this.maxAttempts    = opts.maxAttempts;
    this.initialDelayMs = opts.initialDelayMs;
    this.maxDelayMs     = opts.maxDelayMs     ?? 30_000;
    this.backoffFactor  = opts.backoffFactor  ?? 2;
  }

  delayFor(attempt: number): number {
    const delay = this.initialDelayMs * Math.pow(this.backoffFactor, attempt);
    return Math.min(delay, this.maxDelayMs);
  }

  shouldRetry(attempt: number): boolean {
    return attempt < this.maxAttempts;
  }
}

/** Default retry strategy. */
export const DEFAULT_RETRY_STRATEGY = new RetryStrategy({
  maxAttempts:    5,
  initialDelayMs: 100,
  maxDelayMs:     5_000,
  backoffFactor:  2,
});

// ── StreamRetryHandler ────────────────────────────────────────────────────────

export type StreamFn<T> = () => AsyncIterable<T>;

/** Retry result interface definition. */
export interface RetryResult<T> {
  values: T[];
  attempts: number;
  succeeded: boolean;
  error?: string;
}

/** Stream retry handler. */
export class StreamRetryHandler<T = string> {
  private strategy: RetryStrategy;

  constructor(strategy: RetryStrategy = DEFAULT_RETRY_STRATEGY) {
    this.strategy = strategy;
  }

  async collect(streamFn: StreamFn<T>, delayFn?: (ms: number) => Promise<void>): Promise<RetryResult<T>> {
    const delay = delayFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let attempt = 0;
    let lastError: string | undefined;

    while (this.strategy.shouldRetry(attempt)) {
      try {
        const values: T[] = [];
        for await (const chunk of streamFn()) {
          values.push(chunk);
        }
        return { values, attempts: attempt + 1, succeeded: true };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        attempt++;
        if (this.strategy.shouldRetry(attempt)) {
          await delay(this.strategy.delayFor(attempt));
        }
      }
    }

    return { values: [], attempts: attempt, succeeded: false, error: lastError };
  }
}

// ── EmittedSseTracker ─────────────────────────────────────────────────────────

export type SseBlockType = "block" | "updateBlock" | "researchComplete" | string;

/** Sse block interface definition. */
export interface SseBlock {
  id: string;
  type: SseBlockType;
  openedAt: number;
  data?: unknown;
}

/** Close event interface definition. */
export interface CloseEvent {
  blockId: string;
  type: SseBlockType;
  reason: "error" | "end";
  closedAt: string;
}

/** Emitted sse tracker. */
export class EmittedSseTracker {
  private openBlocks = new Map<string, SseBlock>();
  readonly closeEvents: CloseEvent[] = [];

  open(block: SseBlock): void {
    this.openBlocks.set(block.id, block);
  }

  close(blockId: string, reason: "error" | "end"): void {
    const block = this.openBlocks.get(blockId);
    if (!block) return;
    this.openBlocks.delete(blockId);
    this.closeEvents.push({ blockId, type: block.type, reason, closedAt: new Date().toISOString() });
  }

  /** Close all open blocks (called on stream error or forced termination). */
  closeAll(reason: "error" | "end"): CloseEvent[] {
    const events: CloseEvent[] = [];
    for (const [id, block] of this.openBlocks.entries()) {
      const ev: CloseEvent = { blockId: id, type: block.type, reason, closedAt: new Date().toISOString() };
      events.push(ev);
      this.closeEvents.push(ev);
    }
    this.openBlocks.clear();
    return events;
  }

  hasOpen(blockId: string): boolean { return this.openBlocks.has(blockId); }
  openCount(): number { return this.openBlocks.size; }
  getOpen(): SseBlock[] { return [...this.openBlocks.values()]; }
  clear(): void { this.openBlocks.clear(); this.closeEvents.length = 0; }
}

// ── StreamRecoveryOrchestrator ────────────────────────────────────────────────

export interface OrchestratorOptions {
  holdMs?: number;
  maxRetries?: number;
  initialDelayMs?: number;
}

/** Stream recovery orchestrator. */
export class StreamRecoveryOrchestrator {
  readonly holdback: HoldbackBuffer<string>;
  readonly jsonRepair: ToolJsonRepair;
  readonly continuation: ContinuationSuffix;
  readonly retryHandler: StreamRetryHandler<string>;
  readonly sseTracker: EmittedSseTracker;

  constructor(opts: OrchestratorOptions = {}) {
    this.holdback    = new HoldbackBuffer({ holdMs: opts.holdMs ?? 750 });
    this.jsonRepair  = new ToolJsonRepair();
    this.continuation = new ContinuationSuffix();
    this.retryHandler = new StreamRetryHandler<string>(new RetryStrategy({
      maxAttempts:    opts.maxRetries    ?? 5,
      initialDelayMs: opts.initialDelayMs ?? 100,
    }));
    this.sseTracker  = new EmittedSseTracker();
  }

  /** Recover from stream failure: close all open SSE blocks + inject continuation. */
  handleError(lastText: string, mode = "plain"): { text: string; closedBlocks: CloseEvent[] } {
    const closedBlocks = this.sseTracker.closeAll("error");
    const text = this.continuation.inject(lastText, mode);
    return { text, closedBlocks };
  }
}
