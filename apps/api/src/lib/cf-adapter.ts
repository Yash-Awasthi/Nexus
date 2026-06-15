// SPDX-License-Identifier: Apache-2.0
/**
 * Cloudflare Workers KV adapter for @nexus/kv KVStore.
 *
 * Enables Nexus API to run on Cloudflare Workers with Workers KV as the
 * backing store for all KV-dependent features:
 *   - Token budgets         (KVTokenBudget)
 *   - Gateway log           (KVGatewayLog)
 *   - LLM prompt cache      (PromptCache)
 *   - Rate limiter          (makeRateLimitPreHandler)
 *   - OAuth state tokens    (oauth.ts)
 *
 * Usage — in your Cloudflare Worker entry point (e.g. worker.ts):
 *
 * ```ts
 * import { registerCFContext, getSharedKVFromCF } from "./lib/cf-adapter.js";
 *
 * export default {
 *   async fetch(request: Request, env: Env, ctx: ExecutionContext) {
 *     registerCFContext(env.NEXUS_KV, ctx);
 *     return app.fetch(request, env, ctx);
 *   },
 * };
 * ```
 *
 * The `NEXUS_KV` binding must be declared in wrangler.toml:
 *
 * ```toml
 * [[kv_namespaces]]
 * binding = "NEXUS_KV"
 * id      = "<your-kv-namespace-id>"
 * ```
 *
 * When NOT running on Cloudflare Workers, this module is a no-op —
 * `getSharedKVFromCF()` returns undefined and `getSharedKV()` falls back
 * to Upstash → MemoryKVStore as usual.
 */

import type { KVStore } from "@nexus/kv";

// ── Cloudflare KV Namespace interface ─────────────────────────────────────────
// Matches the KVNamespace type in @cloudflare/workers-types without importing it.
// Injectable so tests can substitute a mock namespace.

export interface CFKVNamespaceLike {
  /** Get a string value by key. Returns null when absent. */
  get(key: string, options: { type: "text" }): Promise<string | null>;
  /** Store a string value with optional per-key TTL (in seconds). */
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  /** Delete a key (no-op if absent). */
  delete(key: string): Promise<void>;
  /** List keys with optional prefix filter. */
  list(options?: { prefix?: string; limit?: number }): Promise<{ keys: Array<{ name: string }> }>;
}

// ── Cloudflare execution context ──────────────────────────────────────────────
// Used by waitUntil() so fire-and-forget cache writes survive request teardown.

interface CFExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

// ── CloudflareKVStore ──────────────────────────────────────────────────────────

/**
 * KVStore implementation backed by a Cloudflare Workers KV Namespace.
 *
 * TTL handling:
 *   - Cloudflare KV requires TTL ≥ 60 s; values below this are rounded up to 60 s.
 *   - Cloudflare KV does not support sub-second expiry.
 *
 * Limitations:
 *   - `clear()` lists all keys then deletes them; expensive for large namespaces.
 *   - `keys(pattern)` only supports prefix-based filtering (glob * suffix).
 *   - `getOrSet()` is NOT atomic (no CAS) — acceptable for cache-aside workloads.
 */
export class CloudflareKVStore implements KVStore {
  private readonly ns: CFKVNamespaceLike;
  private readonly ctx: CFExecutionContextLike | undefined;
  private readonly keyPrefix: string;

  constructor(
    ns: CFKVNamespaceLike,
    opts: { ctx?: CFExecutionContextLike; keyPrefix?: string } = {},
  ) {
    this.ns        = ns;
    this.ctx       = opts.ctx;
    this.keyPrefix = opts.keyPrefix ? `${opts.keyPrefix}:` : "";
  }

  private _k(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  private _unk(cfKey: string): string {
    return this.keyPrefix ? cfKey.slice(this.keyPrefix.length) : cfKey;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.ns.get(this._k(key), { type: "text" });
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    const opts: { expirationTtl?: number } = {};

    if (ttlMs !== undefined && ttlMs > 0) {
      // CF KV minimum TTL is 60 s — round up
      opts.expirationTtl = Math.max(60, Math.ceil(ttlMs / 1000));
    }

    const writePromise = this.ns.put(this._k(key), serialized, opts);

    // Use waitUntil() when available so writes survive request teardown
    if (this.ctx) {
      this.ctx.waitUntil(writePromise);
    } else {
      await writePromise;
    }
  }

  async delete(key: string): Promise<void> {
    await this.ns.delete(this._k(key));
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  async keys(pattern?: string): Promise<string[]> {
    const prefix = pattern?.endsWith("*")
      ? `${this.keyPrefix}${pattern.slice(0, -1)}`
      : this.keyPrefix || undefined;

    const result = await this.ns.list({ prefix });
    return result.keys.map((k) => this._unk(k.name));
  }

  async clear(): Promise<void> {
    const keys = await this.keys("*");
    await Promise.all(keys.map((k) => this.ns.delete(this._k(k))));
  }

  async getOrSet<T>(key: string, factory: () => Promise<T>, ttlMs?: number): Promise<T> {
    const existing = await this.get<T>(key);
    if (existing !== undefined) return existing;
    const value = await factory();
    await this.set(key, value, ttlMs);
    return value;
  }
}

// ── Singleton context registry ─────────────────────────────────────────────────

let _cfKVStore: CloudflareKVStore | null = null;

/**
 * Register a Cloudflare KV namespace + execution context for the current
 * request.  Call this from your Worker fetch handler before routing.
 *
 * This makes `getSharedKVFromCF()` return a CloudflareKVStore backed by
 * the provided namespace for the lifetime of the process (or until the next
 * registerCFContext call).
 */
export function registerCFContext(
  ns: CFKVNamespaceLike,
  ctx?: CFExecutionContextLike,
  opts: { keyPrefix?: string } = {},
): void {
  _cfKVStore = new CloudflareKVStore(ns, { ctx, keyPrefix: opts.keyPrefix ?? "nexus" });
}

/**
 * Returns a CloudflareKVStore if `registerCFContext()` has been called,
 * otherwise returns undefined (fallback to Upstash/Memory).
 */
export function getSharedKVFromCF(): KVStore | undefined {
  return _cfKVStore ?? undefined;
}

/** Reset CF singleton — for tests. */
export function _resetCFContext(): void {
  _cfKVStore = null;
}

// ── Cache API helpers ──────────────────────────────────────────────────────────
// Thin wrappers around the Cloudflare Cache API for HTTP response caching.
// Used by edge handlers to cache deterministic GET responses.

interface CFCacheEntry {
  body:    string;
  status:  number;
  headers: Record<string, string>;
}

/**
 * Build a Cloudflare Cache API key from a URL string.
 * Strips Authorization headers so cache keys are auth-neutral.
 */
export function buildCFCacheKey(url: string): Request {
  return new Request(url, { method: "GET" });
}

/**
 * Return true if the current runtime is Cloudflare Workers.
 * Detected by the presence of the global `caches` object with a `.default` property.
 */
export function isCFRuntime(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { caches?: { default?: unknown } }).caches?.default !== "undefined"
  );
}
