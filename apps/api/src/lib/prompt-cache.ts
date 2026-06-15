// SPDX-License-Identifier: Apache-2.0
/**
 * LLM Prompt Cache — KV-backed deduplication for identical LLM requests.
 *
 * Only non-streaming, deterministic requests are cached (temperature === 0 or
 * not set).  The cache key is a SHA-256 digest of the normalised request
 * signature so it is stable across pods and restarts.
 *
 * Cache TTL: PROMPT_CACHE_TTL_MS (default 3 600 000 ms = 1 h).
 * On a cache hit the response is returned immediately with:
 *   X-Nexus-Cache: HIT
 *   X-Nexus-Cache-Key: <first 16 hex chars of SHA-256>
 *
 * The underlying KVStore is injected so tests can override it.
 */

import { createHash } from "node:crypto";
import type { KVStore } from "@nexus/kv";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CachedLlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CacheableRequest {
  model:       string;
  messages:    CachedLlmMessage[];
  system?:     string;
  max_tokens?: number;
  temperature?: number;
}

export interface CachedLlmResponse {
  id:          string;
  type:        "message";
  role:        "assistant";
  content:     Array<{ type: "text"; text: string }>;
  model:       string;
  stop_reason: string | null;
  usage: {
    input_tokens:  number;
    output_tokens: number;
  };
}

export interface PromptCacheResult {
  hit:       boolean;
  cacheKey:  string;
  response?: CachedLlmResponse;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const CACHE_KEY_PREFIX = "promptcache";

// ── PromptCache ────────────────────────────────────────────────────────────────

export class PromptCache {
  private readonly kv: KVStore;
  private readonly ttlMs: number;

  constructor(kv: KVStore, opts: { ttlMs?: number } = {}) {
    this.kv    = kv;
    const envTtl = parseInt(process.env.PROMPT_CACHE_TTL_MS ?? "0", 10);
    this.ttlMs = opts.ttlMs ?? (envTtl > 0 ? envTtl : DEFAULT_CACHE_TTL_MS);
  }

  /**
   * Compute a stable cache key for the request.
   * Only temperature-zero (deterministic) requests should be cached —
   * callers are responsible for checking this before calling.
   */
  cacheKey(req: CacheableRequest): string {
    // Normalise messages: trim whitespace, sort by index (preserve order)
    const messages = req.messages.map((m) => ({
      role:    m.role,
      content: m.content.trim(),
    }));

    const signature = JSON.stringify({
      model:      req.model,
      messages,
      system:     (req.system ?? "").trim(),
      max_tokens: req.max_tokens ?? 0,
      // temperature intentionally excluded — only called for temperature=0
    });

    const hash = createHash("sha256").update(signature).digest("hex");
    return `${CACHE_KEY_PREFIX}:${hash}`;
  }

  /**
   * Returns true when this request is eligible for caching:
   *   - Non-streaming (caller must check stream===false before calling)
   *   - Deterministic: temperature is 0, undefined, or not set
   */
  static isEligible(req: { temperature?: number; stream?: boolean }): boolean {
    if (req.stream) return false;
    const temp = req.temperature;
    return temp === undefined || temp === 0;
  }

  async get(req: CacheableRequest): Promise<PromptCacheResult> {
    const key = this.cacheKey(req);
    try {
      const cached = await this.kv.get<CachedLlmResponse>(key);
      if (cached) {
        return { hit: true, cacheKey: key, response: cached };
      }
    } catch {
      // Cache miss on error — never block the request
    }
    return { hit: false, cacheKey: key };
  }

  async set(req: CacheableRequest, response: CachedLlmResponse): Promise<void> {
    const key = this.cacheKey(req);
    try {
      await this.kv.set(key, response, this.ttlMs);
    } catch {
      // Non-fatal — cache write failure never blocks the caller
    }
  }

  async invalidate(req: CacheableRequest): Promise<void> {
    const key = this.cacheKey(req);
    await this.kv.delete(key);
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _promptCache: PromptCache | null = null;

export function getPromptCache(kv: KVStore): PromptCache {
  if (!_promptCache) {
    _promptCache = new PromptCache(kv);
  }
  return _promptCache;
}

/** Reset singleton — for tests. */
export function _resetPromptCache(): void {
  _promptCache = null;
}
