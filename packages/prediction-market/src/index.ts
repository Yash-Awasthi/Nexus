// SPDX-License-Identifier: Apache-2.0
/**
 * prediction-market — Polymarket price relay with tiered CDN caching.
 *
 * Provides:
 *   • MarketOutcome            — individual outcome with price + probability
 *   • Market                   — top-level prediction market
 *   • CacheTier                — 120s/300s/900s stale-while-revalidate tiers
 *   • MarketCache              — tiered TTL cache with SWR semantics
 *   • RateLimiter              — per-key sliding window
 *   • ApiKeyAuthenticator      — API key validation
 *   • MarketBackend            — injectable HTTP backend interface
 *   • MockMarketBackend        — configurable in-memory test double
 *   • PolymarketHttpBackend    — real Polymarket CLOB API client (no auth required)
 *   • PolymarketClient         — relay client (injectable HTTP backend)
 *   • PredictionMarketService  — facade (auth + rate-limit + cache + client)
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MarketOutcome {
  id: string;
  label: string;
  price: number;
  probability: number;
  volume24h?: number;
}

export interface Market {
  id: string;
  question: string;
  category: string;
  outcomes: MarketOutcome[];
  volume: number;
  liquidity: number;
  resolveAt?: string;
  fetchedAt: string;
}

export interface MarketListResponse {
  markets: Market[];
  total: number;
  fetchedAt: string;
}

export interface MarketQuery {
  category?: string;
  ids?: string[];
  limit?: number;
}

// ── CacheTier ─────────────────────────────────────────────────────────────────

export type CacheTierLevel = "hot" | "warm" | "cold";

export const CACHE_TIERS: Record<CacheTierLevel, { maxAgeMs: number; swr: number }> = {
  hot:  { maxAgeMs: 120_000,  swr: 60_000  },
  warm: { maxAgeMs: 300_000,  swr: 120_000 },
  cold: { maxAgeMs: 900_000,  swr: 300_000 },
};

export interface CacheEntry<T> {
  value: T;
  cachedAt: number;
  tier: CacheTierLevel;
}

export type CacheStatus = "fresh" | "stale-while-revalidate" | "expired" | "miss";

export interface CacheLookup<T> {
  value: T | null;
  status: CacheStatus;
}

export class MarketCache {
  private store = new Map<string, CacheEntry<Market | MarketListResponse>>();

  set<T extends Market | MarketListResponse>(key: string, value: T, tier: CacheTierLevel = "warm"): void {
    this.store.set(key, { value, cachedAt: Date.now(), tier });
  }

  get<T extends Market | MarketListResponse>(key: string): CacheLookup<T> {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return { value: null, status: "miss" };
    const age = Date.now() - entry.cachedAt;
    const { maxAgeMs, swr } = CACHE_TIERS[entry.tier];
    if (age < maxAgeMs) return { value: entry.value, status: "fresh" };
    if (age < maxAgeMs + swr) return { value: entry.value, status: "stale-while-revalidate" };
    this.store.delete(key);
    return { value: null, status: "expired" };
  }

  invalidate(key: string): boolean { return this.store.delete(key); }
  invalidateCategory(category: string): void {
    for (const [k, v] of this.store.entries()) {
      if ((v.value as Market).category === category) this.store.delete(k);
    }
  }
  clear(): void { this.store.clear(); }
  size(): number { return this.store.size; }
}

// ── RateLimiter ───────────────────────────────────────────────────────────────

export interface RateLimitOptions {
  requestsPerMinute: number;
  windowMs?: number;
}

export class PmRateLimiter {
  private windows = new Map<string, number[]>();
  private rpm: number;
  private windowMs: number;

  constructor(opts: RateLimitOptions) {
    this.rpm = opts.requestsPerMinute;
    this.windowMs = opts.windowMs ?? 60_000;
  }

  check(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const timestamps = (this.windows.get(key) ?? []).filter((t) => t > windowStart);
    if (timestamps.length >= this.rpm) {
      return { allowed: false, retryAfterMs: Math.max(0, timestamps[0]! + this.windowMs - now) };
    }
    timestamps.push(now);
    this.windows.set(key, timestamps);
    return { allowed: true, retryAfterMs: 0 };
  }

  reset(key: string): void { this.windows.delete(key); }
  clear(): void { this.windows.clear(); }
}

// ── ApiKeyAuthenticator ───────────────────────────────────────────────────────

export class ApiKeyAuthenticator {
  private validKeys: Set<string>;
  constructor(keys: string[]) { this.validKeys = new Set(keys); }
  validate(key: string): boolean { return this.validKeys.has(key); }
  add(key: string): void { this.validKeys.add(key); }
  revoke(key: string): void { this.validKeys.delete(key); }
  count(): number { return this.validKeys.size; }
}

// ── MarketBackend interface ───────────────────────────────────────────────────

export interface MarketBackend {
  fetchMarket(id: string): Promise<Market>;
  fetchMarkets(query: MarketQuery): Promise<MarketListResponse>;
}

// ── MockMarketBackend ─────────────────────────────────────────────────────────

export interface MockMarketBehavior {
  markets?: Market[];
  throws?: string;
  delayMs?: number;
}

let _mSeq = 0;

function makeDefaultMarket(id: string, category = "politics"): Market {
  const seq = ++_mSeq;
  return {
    id,
    question: `Will event ${seq} occur?`,
    category,
    outcomes: [
      { id: `${id}-yes`, label: "Yes", price: 0.6, probability: 0.6 },
      { id: `${id}-no`,  label: "No",  price: 0.4, probability: 0.4 },
    ],
    volume: 10_000 * seq,
    liquidity: 5_000 * seq,
    fetchedAt: new Date().toISOString(),
  };
}

export class MockMarketBackend implements MarketBackend {
  private behavior: MockMarketBehavior;
  readonly fetchLog: string[] = [];

  constructor(behavior: MockMarketBehavior = {}) {
    this.behavior = behavior;
  }

  async fetchMarket(id: string): Promise<Market> {
    this.fetchLog.push(id);
    if (this.behavior.delayMs) await new Promise((r) => setTimeout(r, this.behavior.delayMs));
    if (this.behavior.throws) throw new Error(this.behavior.throws);
    return this.behavior.markets?.find((m) => m.id === id) ?? makeDefaultMarket(id);
  }

  async fetchMarkets(query: MarketQuery): Promise<MarketListResponse> {
    if (this.behavior.delayMs) await new Promise((r) => setTimeout(r, this.behavior.delayMs));
    if (this.behavior.throws) throw new Error(this.behavior.throws);
    let markets = this.behavior.markets ?? [
      makeDefaultMarket("m-1", "politics"),
      makeDefaultMarket("m-2", "crypto"),
      makeDefaultMarket("m-3", "sports"),
    ];
    if (query.category) markets = markets.filter((m) => m.category === query.category);
    if (query.ids) markets = markets.filter((m) => query.ids!.includes(m.id));
    if (query.limit) markets = markets.slice(0, query.limit);
    return { markets, total: markets.length, fetchedAt: new Date().toISOString() };
  }
}

// ── PolymarketHttpBackend ─────────────────────────────────────────────────────

interface PolyToken { token_id: string; outcome: string; price: number; }

interface PolyRaw {
  condition_id: string;
  question?: string;
  title?: string;
  category?: string;
  tokens?: PolyToken[];
  volume?: number;
  liquidity?: number;
  end_date_iso?: string;
}

interface PolyListResp { data?: PolyRaw[]; }

function toMarket(raw: PolyRaw): Market {
  const tokens = raw.tokens ?? [];
  const totalPrice = tokens.reduce((s, t) => s + (t.price ?? 0), 0) || 1;
  return {
    id:       raw.condition_id,
    question: raw.question ?? raw.title ?? raw.condition_id,
    category: (raw.category ?? "general").toLowerCase(),
    outcomes: tokens.map((t) => ({
      id:          t.token_id,
      label:       t.outcome,
      price:       t.price ?? 0,
      probability: (t.price ?? 0) / totalPrice,
    })),
    volume:    raw.volume    ?? 0,
    liquidity: raw.liquidity ?? 0,
    resolveAt: raw.end_date_iso,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Real Polymarket CLOB HTTP backend.
 *
 * Calls the public Polymarket CLOB REST API — no API key required for reads.
 *   GET https://clob.polymarket.com/markets          — list markets
 *   GET https://clob.polymarket.com/markets/{id}     — single market
 *
 * Wrap with PolymarketClient to get SWR caching on top.
 */
export class PolymarketHttpBackend implements MarketBackend {
  private baseUrl: string;

  constructor(config: { baseUrl?: string } = {}) {
    this.baseUrl = config.baseUrl ?? "https://clob.polymarket.com";
  }

  async fetchMarket(id: string): Promise<Market> {
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/markets/${encodeURIComponent(id)}`, {
        headers: { Accept: "application/json" },
      });
    } catch (err) {
      throw new Error(`PolymarketHttpBackend: network error for market ${id}: ${String(err)}`);
    }
    if (!resp.ok) {
      throw new Error(`PolymarketHttpBackend: HTTP ${resp.status} for market ${id}`);
    }
    return toMarket((await resp.json()) as PolyRaw);
  }

  async fetchMarkets(query: MarketQuery = {}): Promise<MarketListResponse> {
    const params = new URLSearchParams();
    params.set("limit", String(Math.min(query.limit ?? 20, 100)));
    if (query.category) params.set("category", query.category);

    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/markets?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });
    } catch (err) {
      throw new Error(`PolymarketHttpBackend: network error listing markets: ${String(err)}`);
    }
    if (!resp.ok) {
      throw new Error(`PolymarketHttpBackend: HTTP ${resp.status} listing markets`);
    }

    const body = (await resp.json()) as PolyListResp | PolyRaw[];
    const rawList: PolyRaw[] = Array.isArray(body)
      ? body
      : (body as PolyListResp).data ?? [];

    let markets = rawList.map(toMarket);
    if (query.ids?.length) {
      const idSet = new Set(query.ids);
      markets = markets.filter((m) => idSet.has(m.id));
    }

    return { markets, total: markets.length, fetchedAt: new Date().toISOString() };
  }
}

// ── PolymarketClient ──────────────────────────────────────────────────────────

export class PolymarketClient {
  private backend: MarketBackend;
  private cache: MarketCache;
  private tier: CacheTierLevel;

  constructor(backend: MarketBackend, cache?: MarketCache, tier: CacheTierLevel = "warm") {
    this.backend = backend;
    this.cache = cache ?? new MarketCache();
    this.tier = tier;
  }

  async getMarket(id: string, forceRefresh = false): Promise<Market> {
    const key = `market:${id}`;
    if (!forceRefresh) {
      const lookup = this.cache.get<Market>(key);
      if (lookup.value && (lookup.status === "fresh" || lookup.status === "stale-while-revalidate")) {
        return lookup.value;
      }
    }
    const market = await this.backend.fetchMarket(id);
    this.cache.set(key, market, this.tier);
    return market;
  }

  async getMarkets(query: MarketQuery = {}, forceRefresh = false): Promise<MarketListResponse> {
    const key = `markets:${JSON.stringify(query)}`;
    if (!forceRefresh) {
      const lookup = this.cache.get<MarketListResponse>(key);
      if (lookup.value && (lookup.status === "fresh" || lookup.status === "stale-while-revalidate")) {
        return lookup.value;
      }
    }
    const response = await this.backend.fetchMarkets(query);
    this.cache.set(key, response, this.tier);
    return response;
  }

  getCache(): MarketCache { return this.cache; }
}

// ── PredictionMarketService ───────────────────────────────────────────────────

export interface PredictionMarketServiceOptions {
  backend: MarketBackend;
  apiKeys?: string[];
  requestsPerMinute?: number;
  cacheTier?: CacheTierLevel;
}

export interface ServiceCallResult<T> {
  data: T | null;
  error?: string;
  rateLimited?: boolean;
  unauthorized?: boolean;
  cached?: boolean;
}

export class PredictionMarketService {
  private client: PolymarketClient;
  private rateLimiter: PmRateLimiter;
  private auth?: ApiKeyAuthenticator;

  constructor(opts: PredictionMarketServiceOptions) {
    const cache = new MarketCache();
    this.client = new PolymarketClient(opts.backend, cache, opts.cacheTier ?? "warm");
    this.rateLimiter = new PmRateLimiter({ requestsPerMinute: opts.requestsPerMinute ?? 60 });
    if (opts.apiKeys?.length) this.auth = new ApiKeyAuthenticator(opts.apiKeys);
  }

  async getMarket(id: string, apiKey?: string): Promise<ServiceCallResult<Market>> {
    if (this.auth && (!apiKey || !this.auth.validate(apiKey))) return { data: null, unauthorized: true };
    const rl = this.rateLimiter.check(apiKey ?? "anonymous");
    if (!rl.allowed) return { data: null, rateLimited: true };
    try {
      return { data: await this.client.getMarket(id) };
    } catch (err) {
      return { data: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getMarkets(query: MarketQuery = {}, apiKey?: string): Promise<ServiceCallResult<MarketListResponse>> {
    if (this.auth && (!apiKey || !this.auth.validate(apiKey))) return { data: null, unauthorized: true };
    const rl = this.rateLimiter.check(apiKey ?? "anonymous");
    if (!rl.allowed) return { data: null, rateLimited: true };
    try {
      return { data: await this.client.getMarkets(query) };
    } catch (err) {
      return { data: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  getClient(): PolymarketClient { return this.client; }
  getRateLimiter(): PmRateLimiter { return this.rateLimiter; }
}
