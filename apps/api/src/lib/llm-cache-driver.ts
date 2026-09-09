// SPDX-License-Identifier: Apache-2.0
/**
 * LLM prompt-response caching at the driver choke point.
 *
 * Wraps any LlmDriver (the getDefaultDriver() result in api-bridge) with the
 * @nexus/llm-cache tiered store: an in-process LRU (L1) fronting the shared KV
 * (L2 — survives restarts, shared across pods), TTL-evicted.
 *
 * Safety rules (the "only cache deterministic completions" contract):
 *   - `complete()` and `stream()` both honor the SAME deterministic-only
 *     gate: requests with tools/toolChoice, or any "tool" role message, are
 *     never cached (tool-call results are stateful), and an explicit
 *     temperature > 0 bypasses (non-deterministic sampling). The common case
 *     (temperature unset, i.e. provider default) IS cached — a response
 *     cache's purpose is serving the same answer for the same prompt.
 *   - `stream()` is a FINAL-COMPLETION cache: only the fully-assembled result
 *     of a clean stream is ever stored (the stream must complete to the end
 *     with a "stop" finish and no tool calls). A stream that errors, aborts
 *     mid-way, or finishes with tool calls is NEVER stored — never a partial.
 *     A hit replays the stored completion WITHOUT opening a stream.
 *   - Responses with toolCalls or a non-"stop" finishReason are never stored
 *     (on either path).
 *   - Cached hits return the stored content with `cached: true` and ZEROED
 *     usage — a hit costs no tokens, so the cost log and dashboard stats stay
 *     honest (the original call's tokens were already tracked once).
 *
 * Stream-path counters (council/thread deliberations): streamHits / streamMisses
 * / streamSkips track the stream cache independently of the complete() path, and
 * streamServedBy records which provider served the last stream call (a hit
 * reports the stored entry's provider, a miss the inner driver's) — so a bypass
 * firing is observable in the /health/ready `llmCache` block.
 *
 * Per-user isolation: the key includes the resolved caller id from
 * lib/user-context.ts (AsyncLocalStorage set per request in server.ts); the
 * shared KV keys are `llm-cache:<sha256>` — one user's response can never be
 * served to another. Calls outside a request context (worker) use "anon".
 *
 * Fail-open: every cache interaction is wrapped — a KV error degrades to a
 * normal provider call, never a 500.
 *
 * Env:
 *   LLM_CACHE_TTL_MS    default 900000 (15 min)
 *   LLM_CACHE_DISABLED  "1" to bypass entirely
 */

import { createHash } from "node:crypto";

import {
  KVPromptCache,
  MemoryPromptCache,
  TieredPromptCache,
  type LLMResponse as CachedResponse,
  type PromptCache,
} from "@nexus/llm-cache";
import type { LlmDriver, LlmRequestOptions, LlmResponse } from "@nexus/llm-drivers";

import { getSharedKV } from "./shared-kv.js";
import { getCacheUserId } from "./user-context.js";

const DEFAULT_TTL_MS = parseInt(process.env.LLM_CACHE_TTL_MS ?? "900000", 10);
const DISABLED = process.env.LLM_CACHE_DISABLED === "1";

export interface LlmCacheStats {
  enabled: boolean;
  ttlMs: number;
  hits: number;
  misses: number;
  skips: number;
  size: number;
  /** Final-completion stream cache counters (council/thread path). */
  streamHits: number;
  streamMisses: number;
  streamSkips: number;
  /** Provider that served the last stream call (a hit = stored entry's provider). */
  streamServedBy: string | null;
}

const _stats = {
  hits: 0,
  misses: 0,
  skips: 0,
  streamHits: 0,
  streamMisses: 0,
  streamSkips: 0,
  streamServedBy: null as string | null,
};

let _cache: PromptCache | null = null;
let _injectedCache: PromptCache | null = null;
function getCache(): PromptCache | null {
  if (_injectedCache) return _injectedCache;
  if (_cache !== null) return _cache;
  try {
    _cache = new TieredPromptCache(
      new MemoryPromptCache({ maxSize: 200 }),
      new KVPromptCache(getSharedKV(), { keyPrefix: "llm-cache" }),
      // L1 must never outlive the L2 TTL or it could serve stale entries.
      { l1TtlMs: Math.min(DEFAULT_TTL_MS, 300_000) },
    );
  } catch {
    _cache = null;
  }
  return _cache;
}

/** Reset the module cache singleton + counters (tests only). */
export function resetLlmCache(): void {
  _cache = null;
  _injectedCache = null;
  _stats.hits = 0;
  _stats.misses = 0;
  _stats.skips = 0;
  _stats.streamHits = 0;
  _stats.streamMisses = 0;
  _stats.streamSkips = 0;
  _stats.streamServedBy = null;
}

/** Reset counters (tests only). */
export function resetLlmCacheStats(): void {
  _stats.hits = 0;
  _stats.misses = 0;
  _stats.skips = 0;
  _stats.streamHits = 0;
  _stats.streamMisses = 0;
  _stats.streamSkips = 0;
  _stats.streamServedBy = null;
}

export async function getLlmCacheStats(): Promise<LlmCacheStats> {
  let size = 0;
  const cache = getCache();
  if (cache) {
    try {
      size = (await cache.stats()).size;
    } catch {
      /* stats are best-effort */
    }
  }
  return { enabled: !DISABLED, ttlMs: DEFAULT_TTL_MS, ..._stats, size };
}

/** Stable per-user cache key: provider + model + user + temperature + tokens + messages. */
function cacheKey(
  provider: string,
  model: string,
  userId: string,
  opts: LlmRequestOptions,
): string {
  const h = createHash("sha256");
  h.update("llm-cache-v1\0");
  h.update(`${provider}\0${model}\0${userId}\0`);
  h.update(`temp:${opts.temperature ?? "default"}\0max:${opts.maxTokens ?? "default"}\0`);
  for (const m of opts.messages) h.update(`${m.role}:${m.content}\0`);
  return h.digest("hex");
}

/**
 * The deterministic-only gate (shared by complete() and stream()): a request
 * must never touch the cache when sampling or tool-calling could vary output.
 */
function isConfigUncacheable(opts: LlmRequestOptions): boolean {
  if (opts.tools && opts.tools.length > 0) return true;
  if (opts.toolChoice && opts.toolChoice !== "none") return true;
  if (opts.messages.some((m) => m.role === "tool")) return true;
  if (opts.temperature !== undefined && opts.temperature !== 0) return true;
  return false;
}

/** Whether this request must never touch the cache (complete()-path surface). */
function isUncacheable(opts: LlmRequestOptions): boolean {
  // `stream: true` on a complete() call asks the provider to stream; mid-chunks
  // are structurally never cached there. The stream() path passes `stream` only
  // as a request hint (never a sampling knob), so it relies on the shared
  // deterministic gate alone.
  if (opts.stream === true) return true;
  return isConfigUncacheable(opts);
}

/** Cached-hit responses carry this flag and zeroed usage (hit costs nothing). */
export interface CachedLlmResponse extends LlmResponse {
  cached: true;
}

/**
 * LlmDriver decorator — transparent prompt-response caching for complete().
 * stream() and countTokens() pass through untouched.
 */
export class CachingDriver implements LlmDriver {
  readonly provider: string;
  readonly model: string;

  constructor(
    private readonly inner: LlmDriver,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    cache?: PromptCache,
  ) {
    this.provider = inner.provider;
    this.model = inner.model;
    if (cache) _injectedCache = cache;
  }

  async complete(opts: LlmRequestOptions): Promise<LlmResponse> {
    if (DISABLED || isUncacheable(opts)) {
      _stats.skips++;
      return this.inner.complete(opts);
    }

    const cache = getCache();
    if (!cache) {
      _stats.skips++;
      return this.inner.complete(opts);
    }

    const userId = getCacheUserId() ?? "anon";
    const key = cacheKey(this.inner.provider, opts.model ?? this.inner.model, userId, opts);

    try {
      const hit = await cache.get(key);
      if (hit) {
        _stats.hits++;
        const cached: CachedLlmResponse = {
          id: hit.id,
          content: hit.content,
          model: hit.model,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          finishReason: "stop",
          durationMs: 0,
          cached: true,
        };
        return cached;
      }
    } catch {
      /* cache read failed — fail open to the real call */
    }

    try {
      const res = await this.inner.complete(opts);
      _stats.misses++;
      // Never store tool-call results or error/aborted finishes.
      if (res.toolCalls && res.toolCalls.length > 0) {
        _stats.skips++;
        return res;
      }
      if (res.finishReason !== "stop" && res.finishReason !== "unknown") {
        _stats.skips++;
        return res;
      }
      const entry: CachedResponse = {
        id: res.id,
        model: res.model,
        content: res.content,
        usage: {
          promptTokens: res.usage?.inputTokens ?? 0,
          completionTokens: res.usage?.outputTokens ?? 0,
          totalTokens: res.usage?.totalTokens ?? 0,
        },
        provider: this.inner.provider,
        latencyMs: res.durationMs,
      };
      try {
        await cache.set(key, entry, this.ttlMs);
      } catch {
        /* cache write failed — response still returns */
      }
      return res;
    } catch (err) {
      _stats.misses++;
      throw err;
    }
  }

  async stream(
    opts: LlmRequestOptions,
    handler: Parameters<LlmDriver["stream"]>[1],
  ): Promise<LlmResponse> {
    // Deterministic-only gate — mirrors complete(): temperature > 0, tools, or
    // tool-role messages bypass, so sampled/tool-calling output is never cached.
    if (DISABLED || isConfigUncacheable(opts)) {
      _stats.streamSkips++;
      return this.inner.stream(opts, handler);
    }

    const cache = getCache();
    if (!cache) {
      _stats.streamSkips++;
      return this.inner.stream(opts, handler);
    }

    const userId = getCacheUserId() ?? "anon";
    const key = cacheKey(this.inner.provider, opts.model ?? this.inner.model, userId, opts);

    try {
      const hit = await cache.get(key);
      if (hit) {
        _stats.streamHits++;
        _stats.streamServedBy = hit.provider ?? this.inner.provider;
        // Replay the FULLY-ASSEMBLED completion WITHOUT opening a stream: a
        // single content delta + a done delta, zeroed usage (a hit costs $0).
        const zeroed = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        const cached: CachedLlmResponse = {
          id: hit.id,
          content: hit.content,
          model: hit.model,
          usage: zeroed,
          finishReason: "stop",
          durationMs: 0,
          cached: true,
        };
        await handler({ delta: hit.content, done: false });
        await handler({ delta: "", done: true, usage: zeroed });
        return cached;
      }
    } catch {
      /* cache read failed — fail open to the real stream */
    }

    // Miss: run the real stream, forwarding every delta. Store ONLY the
    // fully-assembled result of a clean completion — never a partial: an
    // error, a mid-stream abort (handler throw), a tool-call sequence, or a
    // non-"stop" finish all leave the cache untouched.
    let content = "";
    let aborted = false;
    try {
      const res = await this.inner.stream(opts, async (delta) => {
        if (delta.delta) content += delta.delta;
        try {
          await handler(delta);
        } catch (err) {
          aborted = true;
          throw err;
        }
      });
      _stats.streamMisses++;
      _stats.streamServedBy = this.inner.provider;
      const clean =
        !aborted && res.finishReason === "stop" && (!res.toolCalls || res.toolCalls.length === 0);
      if (!clean) {
        _stats.streamSkips++;
        return res;
      }
      const entry: CachedResponse = {
        id: res.id,
        model: res.model,
        content,
        usage: {
          promptTokens: res.usage?.inputTokens ?? 0,
          completionTokens: res.usage?.outputTokens ?? 0,
          totalTokens: res.usage?.totalTokens ?? 0,
        },
        provider: this.inner.provider,
        latencyMs: res.durationMs,
      };
      try {
        await cache.set(key, entry, this.ttlMs);
      } catch {
        /* cache write failed — response still streams */
      }
      return res;
    } catch (err) {
      _stats.streamMisses++;
      throw err;
    }
  }

  countTokens(text: string): number {
    return this.inner.countTokens(text);
  }
}
