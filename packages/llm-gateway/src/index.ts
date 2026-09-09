// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/llm-gateway — Lightweight LLM gateway with caching and rate limiting.
 *
 * Inspired by Helicone's ai-gateway.
 * Acts as a unified proxy for all LLM requests with response caching,
 * rate limiting, retry logic, and usage tracking.
 */

// ── Types ────────────────────────────────────────────────────────────────────

import { TrafficLogger, type TrafficSink } from "./traffic.js";

export interface GatewayConfig {
  upstreams: UpstreamConfig[];
  cache?: CacheConfig;
  rateLimit?: RateLimitConfig;
  retry?: RetryConfig;
  /** Receives a masked request/response record for every forwarded call. */
  onTraffic?: TrafficSink;
}

export interface UpstreamConfig {
  name: string;
  baseUrl: string;
  apiKey?: string;
  weight?: number;
  maxConcurrency?: number;
  healthCheckUrl?: string;
}

export interface CacheConfig {
  backend: "memory" | "redis";
  redisUrl?: string;
  ttlMs: number;
  maxEntries?: number;
  keyPrefix?: string;
}

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  perUser?: boolean;
}

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface GatewayRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  userId?: string;
}

export interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  upstream: string;
  cached: boolean;
  latencyMs: number;
}

// ── Cache Backend ────────────────────────────────────────────────────────────

interface CacheEntry {
  response: GatewayResponse;
  storedAt: number;
  ttlMs: number;
}

class MemoryCache {
  private store = new Map<string, CacheEntry>();
  private maxEntries: number;

  constructor(maxEntries: number = 10_000) {
    this.maxEntries = maxEntries;
  }

  async get(key: string): Promise<GatewayResponse | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.storedAt > entry.ttlMs) {
      this.store.delete(key);
      return null;
    }
    return entry.response;
  }

  async set(key: string, response: GatewayResponse, ttlMs: number): Promise<void> {
    if (this.store.size >= this.maxEntries) {
      // Evict oldest
      const oldest = this.store.keys().next().value;
      if (oldest) this.store.delete(oldest);
    }
    this.store.set(key, { response, storedAt: Date.now(), ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

// ── Rate Limiter ─────────────────────────────────────────────────────────────

class SlidingWindowRateLimiter {
  private windows: Map<string, number[]> = new Map();

  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {}

  tryAcquire(key: string): { allowed: boolean; remaining: number } {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // Remove old timestamps
    const valid = timestamps.filter((t) => t > windowStart);
    this.windows.set(key, valid);

    if (valid.length >= this.maxRequests) {
      return { allowed: false, remaining: 0 };
    }

    valid.push(now);
    return { allowed: true, remaining: this.maxRequests - valid.length };
  }
}

// ── Gateway ──────────────────────────────────────────────────────────────────

export class LLMGateway {
  private cache?: MemoryCache;
  private rateLimiter?: SlidingWindowRateLimiter;
  private config: GatewayConfig;
  private usage: Map<string, { requests: number; tokens: number; cost: number }> = new Map();
  private traffic?: TrafficLogger;

  constructor(config: GatewayConfig) {
    this.config = config;

    if (config.cache) {
      this.cache = new MemoryCache(config.cache.maxEntries);
    }

    if (config.rateLimit) {
      this.rateLimiter = new SlidingWindowRateLimiter(
        config.rateLimit.maxRequests,
        config.rateLimit.windowMs,
      );
    }

    if (config.onTraffic) {
      this.traffic = new TrafficLogger(config.onTraffic);
    }
  }

  /**
   * Forward a request to the best available upstream, emitting a masked
   * traffic record to the configured sink for every outcome.
   */
  async forward(request: GatewayRequest): Promise<GatewayResponse> {
    const response = await this.forwardCore(request);
    this.traffic?.record({
      request,
      response,
      upstream: response.upstream,
      cached: response.cached,
      latencyMs: response.latencyMs,
    });
    return response;
  }

  private async forwardCore(request: GatewayRequest): Promise<GatewayResponse> {
    // Check cache first
    const cacheKey = this.buildCacheKey(request);
    if (this.cache && request.method === "POST") {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return { ...cached, cached: true };
      }
    }

    // Check rate limit
    if (this.rateLimiter && request.userId) {
      const { allowed, remaining } = this.rateLimiter.tryAcquire(request.userId);
      if (!allowed) {
        return {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(this.config.rateLimit!.windowMs / 1000)) },
          body: { error: "Rate limit exceeded" },
          upstream: "none",
          cached: false,
          latencyMs: 0,
        };
      }
    }

    // Select upstream
    const upstream = this.selectUpstream();
    if (!upstream) {
      return {
        status: 503,
        headers: {},
        body: { error: "No available upstreams" },
        upstream: "none",
        cached: false,
        latencyMs: 0,
      };
    }

    // Forward with retry
    const start = Date.now();
    let lastError: Error | null = null;
    const maxAttempts = this.config.retry?.maxAttempts ?? 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await this.callUpstream(upstream, request);
        const latencyMs = Date.now() - start;

        // Cache successful responses
        if (this.cache && response.status === 200) {
          const ttl = this.config.cache!.ttlMs;
          await this.cache.set(cacheKey, { ...response, cached: false }, ttl);
        }

        // Track usage
        this.trackUsage(upstream.name, response);

        return { ...response, cached: false, latencyMs };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < maxAttempts - 1) {
          const delay = Math.min(
            (this.config.retry?.baseDelayMs ?? 1000) * Math.pow(2, attempt),
            this.config.retry?.maxDelayMs ?? 10_000,
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    return {
      status: 502,
      headers: {},
      body: { error: `All retries failed: ${lastError?.message}` },
      upstream: upstream.name,
      cached: false,
      latencyMs: Date.now() - start,
    };
  }

  /**
   * Get usage statistics.
   */
  getUsage(): Map<string, { requests: number; tokens: number; cost: number }> {
    return new Map(this.usage);
  }

  /**
   * Get health status of all upstreams.
   */
  async healthCheck(): Promise<Array<{ name: string; healthy: boolean; latencyMs: number }>> {
    const results = await Promise.all(
      this.config.upstreams.map(async (upstream) => {
        const start = Date.now();
        try {
          const resp = await fetch(upstream.healthCheckUrl ?? `${upstream.baseUrl}/health`, {
            signal: AbortSignal.timeout(5000),
          });
          return { name: upstream.name, healthy: resp.ok, latencyMs: Date.now() - start };
        } catch {
          return { name: upstream.name, healthy: false, latencyMs: Date.now() - start };
        }
      }),
    );
    return results;
  }

  private selectUpstream(): UpstreamConfig | undefined {
    const available = this.config.upstreams;
    if (available.length === 0) return undefined;

    // Weighted random selection
    const totalWeight = available.reduce((sum, u) => sum + (u.weight ?? 1), 0);
    let random = Math.random() * totalWeight;

    for (const upstream of available) {
      random -= upstream.weight ?? 1;
      if (random <= 0) return upstream;
    }

    return available[0];
  }

  private async callUpstream(
    upstream: UpstreamConfig,
    request: GatewayRequest,
  ): Promise<GatewayResponse> {
    const headers: Record<string, string> = { ...request.headers };
    if (upstream.apiKey) {
      headers["Authorization"] = `Bearer ${upstream.apiKey}`;
    }

    const resp = await fetch(`${upstream.baseUrl}${request.path}`, {
      method: request.method,
      headers,
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });

    const body = await resp.json();

    return {
      status: resp.status,
      headers: Object.fromEntries(resp.headers.entries()),
      body,
      upstream: upstream.name,
      cached: false,
      latencyMs: 0,
    };
  }

  private buildCacheKey(request: GatewayRequest): string {
    const prefix = this.config.cache?.keyPrefix ?? "llm";
    const bodyStr = request.body ? JSON.stringify(request.body) : "";
    // Simple hash
    let hash = 0;
    for (let i = 0; i < bodyStr.length; i++) {
      hash = ((hash << 5) - hash + bodyStr.charCodeAt(i)) | 0;
    }
    return `${prefix}:${request.path}:${Math.abs(hash).toString(36)}`;
  }

  private trackUsage(upstreamName: string, response: GatewayResponse): void {
    if (!this.usage.has(upstreamName)) {
      this.usage.set(upstreamName, { requests: 0, tokens: 0, cost: 0 });
    }
    const stats = this.usage.get(upstreamName)!;
    stats.requests++;

    // Extract usage from response if available
    const body = response.body as Record<string, unknown>;
    if (body && typeof body === "object" && "usage" in body) {
      const usage = body.usage as Record<string, number>;
      stats.tokens += (usage?.total_tokens as number) ?? 0;
    }
  }
}

export * from "./traffic.js";

export default LLMGateway;
