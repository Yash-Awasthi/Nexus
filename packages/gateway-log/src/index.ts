// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/gateway-log — LLM gateway audit log.
 *
 * IGatewayLog        — core interface: append, query, stats, clear.
 *
 * MemoryGatewayLog   — in-process circular buffer.  Capped at `maxEntries`
 *                      (default: 10 000). Oldest entries are discarded when
 *                      the cap is reached.  Injectable `now` for tests.
 *
 * KVGatewayLog       — persists each log entry into a KVStore under a
 *                      timestamped key.  Entries expire with the store's TTL.
 *
 * LoggingLLMProvider — decorator: wraps any LLMProvider, writes one
 *                      GatewayLogEntry per call (success or error).
 *
 * GatewayLogStats    — aggregate metrics computed from a set of entries.
 */

import { randomUUID } from "node:crypto";

// ── Error ──────────────────────────────────────────────────────────────────────

export class GatewayLogError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GatewayLogError";
  }
}

// ── LLM types (minimal) ───────────────────────────────────────────────────────

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

// ── GatewayLogEntry ───────────────────────────────────────────────────────────

export type LogEntryStatus = "success" | "error" | "cached";

export interface GatewayLogEntry {
  /** Unique entry ID. */
  id: string;
  /** Unix timestamp (ms) when the request was initiated. */
  timestamp: number;
  /** Model requested. */
  model: string;
  /** Provider that handled the request. */
  provider: string;
  /** Outcome of the request. */
  status: LogEntryStatus;
  /** Latency in milliseconds. */
  latencyMs: number;
  /** Token usage (undefined on error). */
  usage?: LLMUsage;
  /** Error message (only on status === "error"). */
  errorMessage?: string;
  /** Optional identity from request metadata. */
  identity?: string;
  /** Optional arbitrary tags. */
  tags?: Record<string, string>;
}

// ── GatewayLogQuery ───────────────────────────────────────────────────────────

export interface GatewayLogQuery {
  /** Filter by provider name. */
  provider?: string;
  /** Filter by model. */
  model?: string;
  /** Filter by status. */
  status?: LogEntryStatus;
  /** Filter by identity. */
  identity?: string;
  /** Only entries at or after this timestamp. */
  since?: number;
  /** Only entries before this timestamp. */
  before?: number;
  /** Maximum number of entries to return (most recent first). */
  limit?: number;
}

// ── GatewayLogStats ───────────────────────────────────────────────────────────

export interface GatewayLogStats {
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  cachedRequests: number;
  totalTokens: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  /** Breakdown of token usage by provider. */
  tokensByProvider: Record<string, number>;
  /** Breakdown of request count by model. */
  requestsByModel: Record<string, number>;
}

/**
 * Compute aggregate stats from an array of log entries.
 */
export function computeStats(entries: GatewayLogEntry[]): GatewayLogStats {
  const success = entries.filter((e) => e.status === "success");
  const errors = entries.filter((e) => e.status === "error");
  const cached = entries.filter((e) => e.status === "cached");

  const totalTokens = entries.reduce((sum, e) => sum + (e.usage?.totalTokens ?? 0), 0);

  const latencies = entries.map((e) => e.latencyMs).sort((a, b) => a - b);
  const avgLatencyMs =
    latencies.length > 0 ? latencies.reduce((s, v) => s + v, 0) / latencies.length : 0;
  const p = (pct: number): number => {
    if (latencies.length === 0) return 0;
    const idx = Math.floor(pct * latencies.length);
    return latencies[Math.min(idx, latencies.length - 1)] ?? 0;
  };

  const tokensByProvider: Record<string, number> = {};
  const requestsByModel: Record<string, number> = {};

  for (const e of entries) {
    tokensByProvider[e.provider] = (tokensByProvider[e.provider] ?? 0) + (e.usage?.totalTokens ?? 0);
    requestsByModel[e.model] = (requestsByModel[e.model] ?? 0) + 1;
  }

  return {
    totalRequests: entries.length,
    successRequests: success.length,
    errorRequests: errors.length,
    cachedRequests: cached.length,
    totalTokens,
    avgLatencyMs,
    p50LatencyMs: p(0.5),
    p95LatencyMs: p(0.95),
    p99LatencyMs: p(0.99),
    tokensByProvider,
    requestsByModel,
  };
}

// ── IGatewayLog ───────────────────────────────────────────────────────────────

export interface IGatewayLog {
  /**
   * Append a new log entry.  Returns the entry as stored (with assigned id).
   */
  append(entry: Omit<GatewayLogEntry, "id">): Promise<GatewayLogEntry>;

  /**
   * Query entries matching the filter.  Returns entries sorted most-recent first.
   */
  query(filter?: GatewayLogQuery): Promise<GatewayLogEntry[]>;

  /**
   * Return aggregate stats for entries matching the filter.
   */
  stats(filter?: GatewayLogQuery): Promise<GatewayLogStats>;

  /**
   * Remove all stored entries.
   */
  clear(): Promise<void>;

  /**
   * Total number of entries stored (including any that match no filter).
   */
  count(): Promise<number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// MemoryGatewayLog — circular buffer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory circular buffer gateway log.
 *
 * Entries are appended to an array.  When `maxEntries` is reached
 * the oldest entry is removed before inserting the new one.
 * Queries scan the buffer in O(n).
 */
export class MemoryGatewayLog implements IGatewayLog {
  private readonly entries: GatewayLogEntry[] = [];
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: { maxEntries?: number; now?: () => number } = {}) {
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async append(entry: Omit<GatewayLogEntry, "id">): Promise<GatewayLogEntry> {
    const full: GatewayLogEntry = { id: randomUUID(), ...entry };
    if (this.entries.length >= this.maxEntries) {
      this.entries.shift(); // evict oldest
    }
    this.entries.push(full);
    return full;
  }

  private _filter(entries: GatewayLogEntry[], f: GatewayLogQuery = {}): GatewayLogEntry[] {
    let result = entries;
    if (f.provider) result = result.filter((e) => e.provider === f.provider);
    if (f.model) result = result.filter((e) => e.model === f.model);
    if (f.status) result = result.filter((e) => e.status === f.status);
    if (f.identity) result = result.filter((e) => e.identity === f.identity);
    if (f.since !== undefined) result = result.filter((e) => e.timestamp >= f.since!);
    if (f.before !== undefined) result = result.filter((e) => e.timestamp < f.before!);
    // Most recent first
    result = [...result].reverse();
    if (f.limit !== undefined) result = result.slice(0, f.limit);
    return result;
  }

  async query(filter?: GatewayLogQuery): Promise<GatewayLogEntry[]> {
    return this._filter(this.entries, filter);
  }

  async stats(filter?: GatewayLogQuery): Promise<GatewayLogStats> {
    const matched = this._filter(this.entries, { ...filter, limit: undefined });
    return computeStats(matched);
  }

  async clear(): Promise<void> {
    this.entries.length = 0;
  }

  async count(): Promise<number> {
    return this.entries.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// KV interface (minimal)
// ─────────────────────────────────────────────────────────────────────────────

export interface KVStoreLike {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  keys(pattern?: string): Promise<string[]>;
  clear(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// KVGatewayLog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * KV-backed gateway log.
 *
 * Each entry is stored under a key `{prefix}:{timestamp}:{id}`.
 * Listing uses prefix matching. Entries can have an optional TTL.
 *
 * Note: `stats()` and `query()` require listing all keys under the prefix —
 * avoid calling them at high frequency on large stores.
 */
export class KVGatewayLog implements IGatewayLog {
  private readonly prefix: string;

  constructor(
    private readonly kv: KVStoreLike,
    opts: { keyPrefix?: string; entryTtlMs?: number } = {},
  ) {
    this.prefix = opts.keyPrefix ? `${opts.keyPrefix}:gwlog` : "gwlog";
    this._entryTtlMs = opts.entryTtlMs;
  }

  private readonly _entryTtlMs: number | undefined;

  private _key(entry: Pick<GatewayLogEntry, "id" | "timestamp">): string {
    // Pad timestamp so lexicographic order == chronological order
    return `${this.prefix}:${String(entry.timestamp).padStart(15, "0")}:${entry.id}`;
  }

  async append(entry: Omit<GatewayLogEntry, "id">): Promise<GatewayLogEntry> {
    const full: GatewayLogEntry = { id: randomUUID(), ...entry };
    await this.kv.set(this._key(full), full, this._entryTtlMs);
    return full;
  }

  private async _loadAll(): Promise<GatewayLogEntry[]> {
    const keys = await this.kv.keys(`${this.prefix}:*`);
    const entries = await Promise.all(keys.map((k) => this.kv.get<GatewayLogEntry>(k)));
    return entries.filter((e): e is GatewayLogEntry => e !== undefined);
  }

  private _filter(entries: GatewayLogEntry[], f: GatewayLogQuery = {}): GatewayLogEntry[] {
    let result = entries;
    if (f.provider) result = result.filter((e) => e.provider === f.provider);
    if (f.model) result = result.filter((e) => e.model === f.model);
    if (f.status) result = result.filter((e) => e.status === f.status);
    if (f.identity) result = result.filter((e) => e.identity === f.identity);
    if (f.since !== undefined) result = result.filter((e) => e.timestamp >= f.since!);
    if (f.before !== undefined) result = result.filter((e) => e.timestamp < f.before!);
    result = result.sort((a, b) => b.timestamp - a.timestamp); // most recent first
    if (f.limit !== undefined) result = result.slice(0, f.limit);
    return result;
  }

  async query(filter?: GatewayLogQuery): Promise<GatewayLogEntry[]> {
    const all = await this._loadAll();
    return this._filter(all, filter);
  }

  async stats(filter?: GatewayLogQuery): Promise<GatewayLogStats> {
    const all = await this._loadAll();
    const matched = this._filter(all, { ...filter, limit: undefined });
    return computeStats(matched);
  }

  async clear(): Promise<void> {
    await this.kv.clear();
  }

  async count(): Promise<number> {
    const keys = await this.kv.keys(`${this.prefix}:*`);
    return keys.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LoggingLLMProvider
// ─────────────────────────────────────────────────────────────────────────────

export interface LoggingLLMProviderOptions {
  /**
   * Extract identity from request metadata for log tagging.
   * Defaults to `request.metadata?.identity as string`.
   */
  identityFn?: (request: LLMRequest) => string | undefined;
  /**
   * Extract arbitrary tags from request/response for log enrichment.
   */
  tagsFn?: (request: LLMRequest, response?: LLMResponse) => Record<string, string>;
}

/**
 * Wraps any LLMProvider and writes a structured log entry for every call.
 *
 * - Success: status = "success" or "cached" (if response.cached === true).
 * - Error: status = "error" with the error message.
 * - Errors are re-thrown after logging.
 */
export class LoggingLLMProvider implements LLMProvider {
  readonly name: string;
  readonly models: readonly string[];

  private readonly identityFn: (req: LLMRequest) => string | undefined;
  private readonly tagsFn: (req: LLMRequest, resp?: LLMResponse) => Record<string, string>;
  private readonly _now: () => number;

  constructor(
    private readonly inner: LLMProvider,
    private readonly log: IGatewayLog,
    opts: LoggingLLMProviderOptions & { now?: () => number } = {},
  ) {
    this.name = `logging(${inner.name})`;
    this.models = inner.models;
    this.identityFn =
      opts.identityFn ?? ((req) => req.metadata?.identity as string | undefined);
    this.tagsFn = opts.tagsFn ?? (() => ({}));
    this._now = opts.now ?? (() => Date.now());
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const startMs = this._now();

    try {
      const response = await this.inner.complete(request);
      const latencyMs = this._now() - startMs;

      await this.log.append({
        timestamp: startMs,
        model: response.model,
        provider: response.provider,
        status: response.cached ? "cached" : "success",
        latencyMs,
        usage: response.usage,
        identity: this.identityFn(request),
        tags: this.tagsFn(request, response),
      });

      return response;
    } catch (err) {
      const latencyMs = this._now() - startMs;
      const errorMessage = err instanceof Error ? err.message : String(err);

      await this.log.append({
        timestamp: startMs,
        model: request.model,
        provider: this.inner.name,
        status: "error",
        latencyMs,
        errorMessage,
        identity: this.identityFn(request),
        tags: this.tagsFn(request, undefined),
      });

      throw err;
    }
  }

  /** Expose the underlying log for querying. */
  get gatewayLog(): IGatewayLog {
    return this.log;
  }
}
