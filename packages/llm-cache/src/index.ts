// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/llm-cache — LLM prompt response caching.
 *
 * PromptCache    — core interface: get/set/delete/clear with TTL and stats.
 *
 * MemoryPromptCache — in-process LRU cache.  Fixed maximum entry count;
 *                     eldest entry is evicted when the cap is reached.
 *                     Uses injectable `now` for deterministic tests.
 *
 * KVPromptCache  — delegates to any @nexus/kv KVStore so responses
 *                  can survive across processes and restarts.
 *
 * CachingLLMProvider — drop-in LLMProvider decorator that wraps any
 *                  LLMProvider and memoizes responses by cache key.
 *                  The cache key is derived from model + messages
 *                  (+ temperature when set).  Respects TTL and is
 *                  transparent — cached responses carry `cached: true`.
 *
 * Cache key strategy
 * ──────────────────
 * buildCacheKey(request) produces a stable SHA-256 hex digest of:
 *   model | role:content pairs | temperature (optional)
 * This is deterministic and order-sensitive (message order matters).
 */

import { createHash } from "node:crypto";

// ── Error ──────────────────────────────────────────────────────────────────────

export class CacheError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CacheError";
  }
}

// ── LLM types (minimal — compatible with @nexus/llm-router) ──────────────────

export type MessageRole = "system" | "user" | "assistant";

/** Llm message interface definition. */
export interface LLMMessage {
  role: MessageRole;
  content: string;
}

/** Llm usage interface definition. */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Llm request interface definition. */
export interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
}

/** Llm response interface definition. */
export interface LLMResponse {
  id: string;
  model: string;
  content: string;
  usage: LLMUsage;
  provider: string;
  latencyMs: number;
  cached?: boolean;
}

/** Llm provider interface definition. */
export interface LLMProvider {
  readonly name: string;
  readonly models: readonly string[];
  complete(request: LLMRequest): Promise<LLMResponse>;
}

// ── Cache key ─────────────────────────────────────────────────────────────────

/**
 * Build a stable cache key for an LLM request.
 * Hashes: model, all messages (role + content), and temperature (if set).
 */
export function buildCacheKey(request: LLMRequest): string {
  const parts: string[] = [request.model];
  for (const msg of request.messages) {
    parts.push(`${msg.role}:${msg.content}`);
  }
  if (request.temperature !== undefined) {
    parts.push(`temp:${request.temperature}`);
  }
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

// ── PromptCache interface ─────────────────────────────────────────────────────

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

/** Prompt cache interface definition. */
export interface PromptCache {
  /** Retrieve a cached response. Returns undefined on miss or expiry. */
  get(key: string): Promise<LLMResponse | undefined>;
  /** Store a response with optional TTL in milliseconds. */
  set(key: string, response: LLMResponse, ttlMs?: number): Promise<void>;
  /** Remove a single entry. No-op if absent. */
  delete(key: string): Promise<void>;
  /** Remove all entries. */
  clear(): Promise<void>;
  /** Return hit/miss counters and current size. */
  stats(): Promise<CacheStats>;
}

// ─────────────────────────────────────────────────────────────────────────────
// MemoryPromptCache — LRU with TTL
// ─────────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  response: LLMResponse;
  expiresAt?: number;
}

/**
 * In-memory LRU prompt cache.
 *
 * `maxSize` caps the number of entries (default: 500).
 * When the cap is reached the least-recently-used entry is evicted.
 * Expired entries are lazily evicted on access.
 */
export class MemoryPromptCache implements PromptCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private readonly now: () => number;
  private _hits = 0;
  private _misses = 0;

  constructor(opts: { maxSize?: number; now?: () => number } = {}) {
    this.maxSize = opts.maxSize ?? 500;
    this.now = opts.now ?? (() => Date.now());
  }

  private _isExpired(entry: CacheEntry): boolean {
    return entry.expiresAt !== undefined && this.now() >= entry.expiresAt;
  }

  /** Promote key to most-recently-used position. */
  private _touch(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  async get(key: string): Promise<LLMResponse | undefined> {
    const entry = this.cache.get(key);
    if (!entry) {
      this._misses++;
      return undefined;
    }
    if (this._isExpired(entry)) {
      this.cache.delete(key);
      this._misses++;
      return undefined;
    }
    this._touch(key, entry);
    this._hits++;
    return entry.response;
  }

  async set(key: string, response: LLMResponse, ttlMs?: number): Promise<void> {
    // Remove first if exists (re-insertion moves to MRU position)
    this.cache.delete(key);

    // Evict LRU entry if at capacity
    if (this.cache.size >= this.maxSize) {
      const lruKey = this.cache.keys().next().value;
      if (lruKey !== undefined) this.cache.delete(lruKey);
    }

    const expiresAt = ttlMs !== undefined && ttlMs > 0 ? this.now() + ttlMs : undefined;
    this.cache.set(key, { response, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this._hits = 0;
    this._misses = 0;
  }

  async stats(): Promise<CacheStats> {
    // Count non-expired entries
    let size = 0;
    const now = this.now();
    for (const entry of this.cache.values()) {
      if (entry.expiresAt === undefined || now < entry.expiresAt) size++;
    }
    return { hits: this._hits, misses: this._misses, size };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// KVStore interface (minimal subset — avoids hard dep on @nexus/kv)
// ─────────────────────────────────────────────────────────────────────────────

export interface KVStoreLike {
  get<T>(key: string): Promise<T | undefined>;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  keys(pattern?: string): Promise<string[]>;
  clear(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// KVPromptCache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * KV-backed prompt cache.  Delegates all persistence to a KVStore.
 * Keys are prefixed with `cache:` to namespace them within the store.
 *
 * Stats are tracked in-process (not persisted across restarts).
 */
export class KVPromptCache implements PromptCache {
  private _hits = 0;
  private _misses = 0;
  private readonly prefix: string;

  constructor(
    private readonly kv: KVStoreLike,
    opts: { keyPrefix?: string } = {},
  ) {
    this.prefix = opts.keyPrefix ? `${opts.keyPrefix}:` : "cache:";
  }

  private _k(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get(key: string): Promise<LLMResponse | undefined> {
    const value = await this.kv.get<LLMResponse>(this._k(key));
    if (value === undefined) {
      this._misses++;
      return undefined;
    }
    this._hits++;
    return value;
  }

  async set(key: string, response: LLMResponse, ttlMs?: number): Promise<void> {
    await this.kv.set(this._k(key), response, ttlMs);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(this._k(key));
  }

  async clear(): Promise<void> {
    // Clear all keys matching our prefix
    const allKeys = await this.kv.keys(`${this.prefix}*`);
    await Promise.all(allKeys.map((k) => this.kv.delete(k)));
    this._hits = 0;
    this._misses = 0;
  }

  async stats(): Promise<CacheStats> {
    const keys = await this.kv.keys(`${this.prefix}*`);
    return { hits: this._hits, misses: this._misses, size: keys.length };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CachingLLMProvider
// ─────────────────────────────────────────────────────────────────────────────

export interface CachingLLMProviderOptions {
  /** Default TTL for cached responses in milliseconds. No TTL if omitted. */
  defaultTtlMs?: number;
  /**
   * Custom key builder. Defaults to `buildCacheKey`.
   * Override to implement semantic/approximate matching.
   */
  keyFn?: (request: LLMRequest) => string;
  /**
   * If true, bypass the cache for a request when `request.metadata.noCache`
   * is set to a truthy value.  Default: true.
   */
  respectNoCache?: boolean;
}

/**
 * Wraps any LLMProvider with transparent response caching.
 *
 * - On cache hit: returns the cached response with `cached: true`.
 * - On cache miss: delegates to the inner provider, stores the result.
 * - `request.metadata.noCache = true` bypasses the cache entirely.
 */
export class CachingLLMProvider implements LLMProvider {
  readonly name: string;
  readonly models: readonly string[];

  private readonly keyFn: (req: LLMRequest) => string;
  private readonly respectNoCache: boolean;

  constructor(
    private readonly inner: LLMProvider,
    private readonly cache: PromptCache,
    private readonly opts: CachingLLMProviderOptions = {},
  ) {
    this.name = `cached(${inner.name})`;
    this.models = inner.models;
    this.keyFn = opts.keyFn ?? buildCacheKey;
    this.respectNoCache = opts.respectNoCache ?? true;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const skipCache = this.respectNoCache && !!request.metadata?.noCache;

    if (!skipCache) {
      const key = this.keyFn(request);
      const cached = await this.cache.get(key);
      if (cached !== undefined) {
        return { ...cached, cached: true };
      }

      const response = await this.inner.complete(request);
      await this.cache.set(key, response, this.opts.defaultTtlMs);
      return response;
    }

    return this.inner.complete(request);
  }

  /** Expose cache for inspection / management. */
  get promptCache(): PromptCache {
    return this.cache;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TieredPromptCache — multi-layer (L1 in-memory → L2 shared/Redis)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two-layer cache: a fast process-local L1 (e.g. {@link MemoryPromptCache})
 * fronting a slower shared L2 (e.g. {@link KVPromptCache} on Redis).
 *
 * - get: L1 first; on L1 miss, try L2 and promote the hit into L1.
 * - set: write-through to both layers.
 * - stats: hits/misses are this tier's own counters; size reflects L1.
 *
 * This cuts both latency (most hits served from memory) and cost (cross-process
 * sharing means one process's miss warms the others via L2).
 */
export class TieredPromptCache implements PromptCache {
  private _hits = 0;
  private _misses = 0;
  private readonly l1TtlMs?: number;

  constructor(
    private readonly l1: PromptCache,
    private readonly l2: PromptCache,
    opts: { l1TtlMs?: number } = {},
  ) {
    this.l1TtlMs = opts.l1TtlMs;
  }

  async get(key: string): Promise<LLMResponse | undefined> {
    const fromL1 = await this.l1.get(key);
    if (fromL1 !== undefined) {
      this._hits++;
      return fromL1;
    }
    const fromL2 = await this.l2.get(key);
    if (fromL2 !== undefined) {
      this._hits++;
      // Promote to L1 so subsequent reads are local.
      await this.l1.set(key, fromL2, this.l1TtlMs);
      return fromL2;
    }
    this._misses++;
    return undefined;
  }

  async set(key: string, response: LLMResponse, ttlMs?: number): Promise<void> {
    await Promise.all([
      this.l1.set(key, response, this.l1TtlMs ?? ttlMs),
      this.l2.set(key, response, ttlMs),
    ]);
  }

  async delete(key: string): Promise<void> {
    await Promise.all([this.l1.delete(key), this.l2.delete(key)]);
  }

  async clear(): Promise<void> {
    await Promise.all([this.l1.clear(), this.l2.clear()]);
    this._hits = 0;
    this._misses = 0;
  }

  async stats(): Promise<CacheStats> {
    const l1 = await this.l1.stats();
    return { hits: this._hits, misses: this._misses, size: l1.size };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SemanticCachingLLMProvider — near-duplicate matching via embeddings
// ─────────────────────────────────────────────────────────────────────────────

/** Embeds a string into a fixed-length vector. Injectable (any embedding model). */
export type EmbedFn = (text: string) => Promise<number[]>;

/** Cosine similarity of two equal-length vectors. Returns 0 for degenerate input. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface SemanticCachingOptions {
  /** Minimum cosine similarity to treat a prior request as a hit (default 0.95). */
  threshold?: number;
  /** Max entries kept in the in-memory vector index (default 1000, FIFO eviction). */
  maxEntries?: number;
  /** Bypass when request.metadata.noCache is truthy (default true). */
  respectNoCache?: boolean;
  /** Text to embed for a request. Default: the last user message content. */
  textFn?: (request: LLMRequest) => string;
}

interface SemanticEntry {
  embedding: number[];
  model: string;
  response: LLMResponse;
}

/**
 * Wraps an {@link LLMProvider} with semantic (approximate) response caching.
 *
 * Exact-match caches miss when a user rephrases a question. This provider embeds
 * each request and returns a cached response when a prior request for the SAME
 * model scores ≥ `threshold` cosine similarity — catching paraphrases.
 *
 * The vector index is in-process and bounded; pair it with {@link CachingLLMProvider}
 * (exact + persistent) for a full cache stack. Embedding is injectable for testing.
 */
export class SemanticCachingLLMProvider implements LLMProvider {
  readonly name: string;
  readonly models: readonly string[];

  private readonly index: SemanticEntry[] = [];
  private readonly threshold: number;
  private readonly maxEntries: number;
  private readonly respectNoCache: boolean;
  private readonly textFn: (request: LLMRequest) => string;
  private _hits = 0;
  private _misses = 0;

  constructor(
    private readonly inner: LLMProvider,
    private readonly embed: EmbedFn,
    opts: SemanticCachingOptions = {},
  ) {
    this.name = `semantic(${inner.name})`;
    this.models = inner.models;
    this.threshold = opts.threshold ?? 0.95;
    this.maxEntries = opts.maxEntries ?? 1000;
    this.respectNoCache = opts.respectNoCache ?? true;
    this.textFn = opts.textFn ?? defaultSemanticText;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const skip = this.respectNoCache && !!request.metadata?.noCache;
    if (skip) return this.inner.complete(request);

    const embedding = await this.embed(this.textFn(request));

    // Search the index for the best same-model match above the threshold.
    let best: { entry: SemanticEntry; score: number } | undefined;
    for (const entry of this.index) {
      if (entry.model !== request.model) continue;
      const score = cosineSimilarity(embedding, entry.embedding);
      if (score >= this.threshold && (!best || score > best.score)) {
        best = { entry, score };
      }
    }
    if (best) {
      this._hits++;
      return { ...best.entry.response, cached: true };
    }

    this._misses++;
    const response = await this.inner.complete(request);
    this.index.push({ embedding, model: request.model, response });
    if (this.index.length > this.maxEntries) this.index.shift(); // FIFO eviction
    return response;
  }

  stats(): CacheStats {
    return { hits: this._hits, misses: this._misses, size: this.index.length };
  }
}

/** Default semantic text: last user message, else concatenated message contents. */
function defaultSemanticText(request: LLMRequest): string {
  const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
  return lastUser?.content ?? request.messages.map((m) => m.content).join("\n");
}
