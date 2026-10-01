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

/** Market interface definition. */
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

/** Market list response interface definition. */
export interface MarketListResponse {
  markets: Market[];
  total: number;
  fetchedAt: string;
}

/** Market query interface definition. */
export interface MarketQuery {
  category?: string;
  ids?: string[];
  limit?: number;
}

// ── CacheTier ─────────────────────────────────────────────────────────────────

export type CacheTierLevel = "hot" | "warm" | "cold";

/** Cache tiers. */
export const CACHE_TIERS: Record<CacheTierLevel, { maxAgeMs: number; swr: number }> = {
  hot: { maxAgeMs: 120_000, swr: 60_000 },
  warm: { maxAgeMs: 300_000, swr: 120_000 },
  cold: { maxAgeMs: 900_000, swr: 300_000 },
};

/** Cache entry interface definition. */
export interface CacheEntry<T> {
  value: T;
  cachedAt: number;
  tier: CacheTierLevel;
}

/** Cache status type alias. */
export type CacheStatus = "fresh" | "stale-while-revalidate" | "expired" | "miss";

/** Cache lookup interface definition. */
export interface CacheLookup<T> {
  value: T | null;
  status: CacheStatus;
}

/** Market cache. */
export class MarketCache {
  private store = new Map<string, CacheEntry<Market | MarketListResponse>>();

  set<T extends Market | MarketListResponse>(
    key: string,
    value: T,
    tier: CacheTierLevel = "warm",
  ): void {
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

  invalidate(key: string): boolean {
    return this.store.delete(key);
  }
  invalidateCategory(category: string): void {
    for (const [k, v] of this.store.entries()) {
      if ((v.value as Market).category === category) this.store.delete(k);
    }
  }
  clear(): void {
    this.store.clear();
  }
  size(): number {
    return this.store.size;
  }
}

// ── RateLimiter ───────────────────────────────────────────────────────────────

export interface RateLimitOptions {
  requestsPerMinute: number;
  windowMs?: number;
}

/** Pm rate limiter. */
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

  reset(key: string): void {
    this.windows.delete(key);
  }
  clear(): void {
    this.windows.clear();
  }
}

// ── ApiKeyAuthenticator ───────────────────────────────────────────────────────

export class ApiKeyAuthenticator {
  private validKeys: Set<string>;
  constructor(keys: string[]) {
    this.validKeys = new Set(keys);
  }
  validate(key: string): boolean {
    return this.validKeys.has(key);
  }
  add(key: string): void {
    this.validKeys.add(key);
  }
  revoke(key: string): void {
    this.validKeys.delete(key);
  }
  count(): number {
    return this.validKeys.size;
  }
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
      { id: `${id}-no`, label: "No", price: 0.4, probability: 0.4 },
    ],
    volume: 10_000 * seq,
    liquidity: 5_000 * seq,
    fetchedAt: new Date().toISOString(),
  };
}

/** Mock market backend. */
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

/** An error's message plus its cause, which undici keeps out of "fetch failed". */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${err.message} (${detail})` : err.message;
}

/**
 * fetch, retried twice on a network error. Kalshi's edge intermittently resets
 * connections; an immediate retry is reset too, one a moment later usually is not.
 */
async function fetchRetry(url: string, init: RequestInit, pauseMs = 750): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (attempt === 2 || !(err instanceof TypeError) || init.signal?.aborted) throw err;
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }
}

// ── PolymarketHttpBackend ─────────────────────────────────────────────────────

interface PolyToken {
  token_id: string;
  outcome: string;
  price: number;
}

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

interface PolyListResp {
  data?: PolyRaw[];
}

function toMarket(raw: PolyRaw): Market {
  const tokens = raw.tokens ?? [];
  const totalPrice = tokens.reduce((s, t) => s + (t.price ?? 0), 0) || 1;
  return {
    id: raw.condition_id,
    question: raw.question ?? raw.title ?? raw.condition_id,
    category: (raw.category ?? "general").toLowerCase(),
    outcomes: tokens.map((t) => ({
      id: t.token_id,
      label: t.outcome,
      price: t.price ?? 0,
      probability: (t.price ?? 0) / totalPrice,
    })),
    volume: raw.volume ?? 0,
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
      resp = await fetchRetry(`${this.baseUrl}/markets/${encodeURIComponent(id)}`, {
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
    // /markets pages through the archive oldest first; /sampling-markets is the open set.
    let resp: Response;
    try {
      resp = await fetchRetry(`${this.baseUrl}/sampling-markets`, {
        headers: { Accept: "application/json" },
      });
    } catch (err) {
      throw new Error(`PolymarketHttpBackend: network error listing markets: ${String(err)}`);
    }
    if (!resp.ok) {
      throw new Error(`PolymarketHttpBackend: HTTP ${resp.status} listing markets`);
    }

    const body = (await resp.json()) as PolyListResp | PolyRaw[];
    const rawList: PolyRaw[] = Array.isArray(body) ? body : ((body as PolyListResp).data ?? []);

    let markets = rawList.map(toMarket);
    if (query.ids?.length) {
      const idSet = new Set(query.ids);
      markets = markets.filter((m) => idSet.has(m.id));
    }
    if (query.category) markets = markets.filter((m) => m.category === query.category);
    markets = markets.slice(0, Math.min(query.limit ?? 20, 100));

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
      if (
        lookup.value &&
        (lookup.status === "fresh" || lookup.status === "stale-while-revalidate")
      ) {
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
      if (
        lookup.value &&
        (lookup.status === "fresh" || lookup.status === "stale-while-revalidate")
      ) {
        return lookup.value;
      }
    }
    const response = await this.backend.fetchMarkets(query);
    this.cache.set(key, response, this.tier);
    return response;
  }

  getCache(): MarketCache {
    return this.cache;
  }
}

// ── PredictionMarketService ───────────────────────────────────────────────────

export interface PredictionMarketServiceOptions {
  backend: MarketBackend;
  apiKeys?: string[];
  requestsPerMinute?: number;
  cacheTier?: CacheTierLevel;
}

/** Service call result interface definition. */
export interface ServiceCallResult<T> {
  data: T | null;
  error?: string;
  rateLimited?: boolean;
  unauthorized?: boolean;
  cached?: boolean;
}

/** Prediction market service. */
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
    if (this.auth && (!apiKey || !this.auth.validate(apiKey)))
      return { data: null, unauthorized: true };
    const rl = this.rateLimiter.check(apiKey ?? "anonymous");
    if (!rl.allowed) return { data: null, rateLimited: true };
    try {
      return { data: await this.client.getMarket(id) };
    } catch (err) {
      return { data: null, error: describeError(err) };
    }
  }

  async getMarkets(
    query: MarketQuery = {},
    apiKey?: string,
  ): Promise<ServiceCallResult<MarketListResponse>> {
    if (this.auth && (!apiKey || !this.auth.validate(apiKey)))
      return { data: null, unauthorized: true };
    const rl = this.rateLimiter.check(apiKey ?? "anonymous");
    if (!rl.allowed) return { data: null, rateLimited: true };
    try {
      return { data: await this.client.getMarkets(query) };
    } catch (err) {
      return { data: null, error: describeError(err) };
    }
  }

  getClient(): PolymarketClient {
    return this.client;
  }
  getRateLimiter(): PmRateLimiter {
    return this.rateLimiter;
  }
}

// ── SwarmConsensus — MiroFish-inspired ensemble prediction aggregation ─────────
//
// MiroFish (666ghj/MiroFish): "A Simple and Universal Swarm Intelligence Engine,
// Predicting Anything". Core insight: run N independent predictors (LLMs, models,
// market signals), weight their outputs by confidence × historical accuracy, then
// aggregate via weighted median to resist outlier poisoning.

export interface SwarmPredictor {
  id: string;
  weight: number; // 0–1 confidence weight
}

export interface SwarmPrediction {
  predictorId: string;
  value: number; // normalised 0–1 probability
  confidence: number;
  reasoning?: string;
}

export interface SwarmConsensusResult {
  consensus: number; // weighted median probability
  mean: number; // simple mean
  spread: number; // max − min
  predictions: SwarmPrediction[];
  totalWeight: number;
  timestamp: string;
}

/** Swarm consensus */
export class SwarmConsensus {
  private predictors = new Map<string, SwarmPredictor>();

  registerPredictor(p: SwarmPredictor): this {
    this.predictors.set(p.id, p);
    return this;
  }

  /**
   * Aggregate predictions using weighted median.
   * Weighted median is more robust than weighted mean for adversarial/noisy inputs.
   */
  aggregate(predictions: SwarmPrediction[]): SwarmConsensusResult {
    if (!predictions.length) {
      return {
        consensus: 0.5,
        mean: 0.5,
        spread: 0,
        predictions: [],
        totalWeight: 0,
        timestamp: new Date().toISOString(),
      };
    }

    // Attach predictor weights; default weight 1 for unregistered predictors
    const weighted = predictions.map((p) => ({
      ...p,
      w: (this.predictors.get(p.predictorId)?.weight ?? 1) * p.confidence,
    }));

    const totalWeight = weighted.reduce((s, p) => s + p.w, 0) || 1;

    // Weighted median
    const sorted = [...weighted].sort((a, b) => a.value - b.value);
    let cumW = 0;
    let median = sorted[0]!.value;
    for (const p of sorted) {
      cumW += p.w;
      if (cumW >= totalWeight / 2) {
        median = p.value;
        break;
      }
    }

    const mean = weighted.reduce((s, p) => s + p.value * p.w, 0) / totalWeight;
    const values = predictions.map((p) => p.value);
    const spread = Math.max(...values) - Math.min(...values);

    return {
      consensus: Math.round(median * 10000) / 10000,
      mean: Math.round(mean * 10000) / 10000,
      spread,
      predictions,
      totalWeight,
      timestamp: new Date().toISOString(),
    };
  }
}

// ── KalshiHttpBackend — Kalshi CLOB API (pmxt/kalshi pattern) ─────────────────
//
// pmxt (pmxt-dev/pmxt): "ccxt for prediction markets" — 14 exchanges unified.
// Kalshi: US-regulated prediction market exchange with REST + WebSocket API.
// Base URL: https://api.elections.kalshi.com/trade-api/v2
// Auth: RSA key-pair (private key signs requests) or email+password JWT.
// Read-only market data does NOT require auth.

interface KalshiRawMarket {
  ticker: string;
  title?: string;
  status?: string;
  last_price_dollars?: string;
  yes_ask_dollars?: string;
  yes_bid_dollars?: string;
  volume_fp?: string;
  open_interest_fp?: string;
  expiration_time?: string;
  rules_primary?: string;
  category?: string;
  subtitle?: string;
}

interface KalshiMarketsResponse {
  markets?: KalshiRawMarket[];
  cursor?: string;
}

function kalshiToMarket(r: KalshiRawMarket): Market {
  const yesBid = Number(r.yes_bid_dollars ?? 0);
  const yesAsk = Number(r.yes_ask_dollars ?? 0);
  const lastPrice = Number(r.last_price_dollars ?? 0);
  const mid = yesBid && yesAsk ? (yesBid + yesAsk) / 2 : lastPrice;

  return {
    id: r.ticker,
    question: r.title ?? r.ticker,
    category: (r.category ?? "general").toLowerCase(),
    outcomes: [
      { id: `${r.ticker}-yes`, label: "Yes", price: mid, probability: mid },
      { id: `${r.ticker}-no`, label: "No", price: 1 - mid, probability: 1 - mid },
    ],
    volume: Number(r.volume_fp ?? 0),
    liquidity: Number(r.open_interest_fp ?? 0),
    resolveAt: r.expiration_time,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * KalshiHttpBackend — read-only Kalshi market data.
 * Implements MarketBackend — drop-in replacement for PolymarketHttpBackend.
 * No API key required for market reads.
 */
export class KalshiHttpBackend implements MarketBackend {
  private baseUrl: string;
  private apiKey?: string;

  constructor(opts: { baseUrl?: string; apiKey?: string } = {}) {
    this.baseUrl = (
      opts.baseUrl ??
      process.env["KALSHI_BASE_URL"] ??
      "https://api.elections.kalshi.com/trade-api/v2"
    ).replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? process.env["KALSHI_API_KEY"];
  }

  async fetchMarket(id: string): Promise<Market> {
    const headers = this._headers();
    const res = (await this._fetch(
      `${this.baseUrl}/markets/${encodeURIComponent(id)}`,
      headers,
    )) as { market?: KalshiRawMarket };
    if (!res.market) throw new Error(`Kalshi market not found: ${id}`);
    return kalshiToMarket(res.market);
  }

  async fetchMarkets(query: MarketQuery): Promise<MarketListResponse> {
    // Multivariate parlays dominate the unfiltered list and have no readable title.
    const params = new URLSearchParams({
      limit: String(query.limit ?? 100),
      mve_filter: "exclude",
      status: "open",
    });
    if (query.category) params.set("category", query.category);

    const headers = this._headers();
    const res = (await this._fetch(
      `${this.baseUrl}/markets?${params}`,
      headers,
    )) as KalshiMarketsResponse;
    const raw = res.markets ?? [];
    const markets = (query.ids ? raw.filter((m) => query.ids!.includes(m.ticker)) : raw).map(
      kalshiToMarket,
    );

    return { markets, total: markets.length, fetchedAt: new Date().toISOString() };
  }

  private _headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async _fetch(url: string, headers: Record<string, string>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetchRetry(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`Kalshi API ${res.status}: ${url}`);
      return res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }
}

// ── MetaculusHttpBackend — reputation-based forecasting platform ──────────────
//
// Metaculus: AI forecasting community. No financial stakes — probability
// forecasts scored on accuracy. Useful signal for @nexus/prediction-market
// consensus aggregation (pair with SwarmConsensus).
// API: https://www.metaculus.com/api/ — no auth required for reads.

interface MetaculusRawQuestion {
  id: number;
  title?: string;
  description?: string;
  resolution_criteria?: string;
  community_prediction?: { q2?: number; full?: { q2?: number } };
  number_of_forecasters?: number;
  close_time?: string;
  categories?: string[];
  status?: string;
}

interface MetaculusListResponse {
  results?: MetaculusRawQuestion[];
  count?: number;
  next?: string;
}

function metaculusToMarket(q: MetaculusRawQuestion): Market {
  const prob = q.community_prediction?.q2 ?? q.community_prediction?.full?.q2 ?? 0.5;
  return {
    id: `metaculus-${q.id}`,
    question: q.title ?? `Question ${q.id}`,
    category: (q.categories?.[0] ?? "general").toLowerCase(),
    outcomes: [
      { id: `metaculus-${q.id}-yes`, label: "Yes", price: prob, probability: prob },
      { id: `metaculus-${q.id}-no`, label: "No", price: 1 - prob, probability: 1 - prob },
    ],
    volume: q.number_of_forecasters ?? 0,
    liquidity: 0,
    resolveAt: q.close_time,
    fetchedAt: new Date().toISOString(),
  };
}

/** MetaculusHttpBackend — community probability forecasts. The API needs an account token. */
export class MetaculusHttpBackend implements MarketBackend {
  private baseUrl: string;
  private token?: string;

  constructor(opts: { baseUrl?: string; token?: string } = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://www.metaculus.com/api2").replace(/\/$/, "");
    this.token = opts.token ?? process.env["METACULUS_TOKEN"];
  }

  async fetchMarket(id: string): Promise<Market> {
    const numId = id.replace(/^metaculus-/, "");
    const raw = (await this._fetch(`${this.baseUrl}/questions/${numId}/`)) as MetaculusRawQuestion;
    return metaculusToMarket(raw);
  }

  async fetchMarkets(query: MarketQuery): Promise<MarketListResponse> {
    const params = new URLSearchParams({
      limit: String(query.limit ?? 50),
      has_community_prediction: "true",
    });
    if (query.category) params.set("categories", query.category);

    const res = (await this._fetch(
      `${this.baseUrl}/questions/?${params}`,
    )) as MetaculusListResponse;
    const markets = (res.results ?? []).map(metaculusToMarket);
    return { markets, total: res.count ?? markets.length, fetchedAt: new Date().toISOString() };
  }

  private async _fetch(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetchRetry(url, {
        headers: {
          Accept: "application/json",
          ...(this.token ? { Authorization: `Token ${this.token}` } : {}),
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`Metaculus API ${res.status}: ${url}`);
      return res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }
}

// ── Order book model ───────────────────────────────────────────────────────────
// Ported from nautechsystems/nautilus_trader: model/book.pyx + model/enums.py
// Target: @nexus/prediction-market — CLOB (Central Limit Order Book) for
// Polymarket/Kalshi price-level tracking and mid-price / spread computation.
// The Cython/Rust implementation is not portable; these are the type-layer
// and pure-logic equivalents extracted for TypeScript.

/** Order book granularity (mirrors nautilus BookType). */
export type BookType =
  | "L1_MBP" // Top-of-book (best bid + best ask only)
  | "L2_MBP" // Market-by-price (full depth, aggregated at each price)
  | "L3_MBO"; // Market-by-order (individual order visibility)

/** Which side of the book an order or level sits on. */
export type OrderSide = "BUY" | "SELL";

/** Delta action applied to a single price level (mirrors nautilus BookAction). */
export type BookAction = "ADD" | "UPDATE" | "DELETE" | "CLEAR";

/** Aggressor side for a trade tick. */
export type AggressorSide = "BUYER" | "SELLER" | "NO_AGGRESSOR";

/**
 * A single price level in an order book.
 * L2: represents aggregate size at a price.
 * L3: represents one resting order.
 */
export interface OrderBookLevel {
  price: number;
  size: number;
  /** Number of individual orders at this level (L2 only). */
  count?: number;
}

/**
 * Incremental delta update to an order book.
 * Ported from nautilus OrderBookDelta.
 * Stream these to keep a local book in sync with an exchange feed.
 */
export interface OrderBookDelta {
  instrumentId: string;
  action: BookAction;
  side: OrderSide;
  price: number;
  size: number;
  /** Exchange-assigned sequence number; monotonically increasing per instrument. */
  sequence: number;
  /** ISO-8601 event timestamp. */
  tsEvent: string;
}

/**
 * Full order book snapshot at a point in time.
 * Ported from nautilus OrderBook state representation.
 */
export interface OrderBookSnapshot {
  instrumentId: string;
  bookType: BookType;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  /** Sequence number of the last applied update. */
  sequence: number;
  /** ISO-8601 timestamp of the snapshot. */
  timestamp: string;
}

/** Apply a single delta to a mutable snapshot in place. Returns the snapshot. */
function applyOrderBookDelta(book: OrderBookSnapshot, delta: OrderBookDelta): OrderBookSnapshot {
  const levels = delta.side === "BUY" ? book.bids : book.asks;

  if (delta.action === "CLEAR") {
    if (delta.side === "BUY") book.bids = [];
    else book.asks = [];
    book.sequence = delta.sequence;
    book.timestamp = delta.tsEvent;
    return book;
  }

  const idx = levels.findIndex((l) => l.price === delta.price);

  if (delta.action === "ADD" || delta.action === "UPDATE") {
    if (idx >= 0) {
      levels[idx] = { price: delta.price, size: delta.size };
    } else {
      levels.push({ price: delta.price, size: delta.size });
      // Keep bids descending, asks ascending
      if (delta.side === "BUY") {
        levels.sort((a, b) => b.price - a.price);
      } else {
        levels.sort((a, b) => a.price - b.price);
      }
    }
  } else if (delta.action === "DELETE" && idx >= 0) {
    levels.splice(idx, 1);
  }

  book.sequence = delta.sequence;
  book.timestamp = delta.tsEvent;
  return book;
}

/** Best bid price (highest buy), or undefined if the book has no bids. */
function bestBidPrice(book: OrderBookSnapshot): number | undefined {
  return book.bids[0]?.price;
}

/** Best ask price (lowest sell), or undefined if the book has no asks. */
function bestAskPrice(book: OrderBookSnapshot): number | undefined {
  return book.asks[0]?.price;
}

/** Mid-point between best bid and best ask. Returns undefined if either side is empty. */
export function bookMidpoint(book: OrderBookSnapshot): number | undefined {
  const bid = bestBidPrice(book);
  const ask = bestAskPrice(book);
  if (bid === undefined || ask === undefined) return undefined;
  return (bid + ask) / 2;
}

/** Bid-ask spread. Returns undefined if either side is empty. */
export function bookSpread(book: OrderBookSnapshot): number | undefined {
  const bid = bestBidPrice(book);
  const ask = bestAskPrice(book);
  if (bid === undefined || ask === undefined) return undefined;
  return ask - bid;
}

/**
 * Compute the average fill price for a given notional quantity on one side.
 * Walks the book levels from best price, consuming size until `quantity` is filled.
 * Ported from nautilus `orderbook_get_avg_px_for_quantity()`.
 *
 * @returns { avgPrice, filled, unfilled } — unfilled > 0 means book depth was exhausted.
 */
export function avgPriceForQuantity(
  book: OrderBookSnapshot,
  side: OrderSide,
  quantity: number,
): { avgPrice: number; filled: number; unfilled: number } {
  const levels = side === "BUY" ? book.asks : book.bids; // BUY walks asks, SELL walks bids
  let remaining = quantity;
  let totalCost = 0;
  let totalFilled = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(level.size, remaining);
    totalCost += take * level.price;
    totalFilled += take;
    remaining -= take;
  }

  const avgPrice = totalFilled > 0 ? totalCost / totalFilled : 0;
  return { avgPrice, filled: totalFilled, unfilled: remaining };
}

/** Create an empty order book snapshot for an instrument. */
function createOrderBook(instrumentId: string, bookType: BookType = "L2_MBP"): OrderBookSnapshot {
  return {
    instrumentId,
    bookType,
    bids: [],
    asks: [],
    sequence: 0,
    timestamp: new Date().toISOString(),
  };
}

// ── Polymarket CLOB Domain Models ─────────────────────────────────────────────
// Extracted from: Polymarket/agents agents/utils/objects.py
// Polygon chainId=137, CLOB at clob.polymarket.com, Gamma API at gamma-api.polymarket.com

const POLYMARKET_CLOB_URL = "https://clob.polymarket.com";
/** One outcome token's live CLOB book, sorted best price first. Public read, no key. */
export async function fetchPolymarketBook(
  tokenId: string,
  baseUrl = POLYMARKET_CLOB_URL,
): Promise<OrderBookSnapshot> {
  const resp = await fetchRetry(`${baseUrl}/book?token_id=${encodeURIComponent(tokenId)}`, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`Polymarket book: HTTP ${resp.status} for ${tokenId}`);
  const raw = (await resp.json()) as {
    bids?: { price: string; size: string }[];
    asks?: { price: string; size: string }[];
  };
  const book = createOrderBook(tokenId);
  const tsEvent = new Date().toISOString();
  let sequence = 0;
  for (const [side, levels] of [
    ["BUY", raw.bids ?? []],
    ["SELL", raw.asks ?? []],
  ] as const) {
    for (const l of levels) {
      sequence++;
      applyOrderBookDelta(book, {
        instrumentId: tokenId,
        action: "ADD",
        side,
        price: parseClobPrice(l.price),
        size: Number(l.size),
        sequence,
        tsEvent,
      });
    }
  }
  return book;
}

/** A single matched trade from the Polymarket CLOB. */
export interface PolyTrade {
  id: number;
  takerOrderId: string;
  market: string;
  assetId: string;
  side: "BUY" | "SELL";
  size: string;
  feeRateBps: string;
  price: string;
  status: string;
  matchTime: string;
  lastUpdate: string;
  outcome: string;
  makerAddress: string;
  owner: string;
  transactionHash: string;
  bucketIndex: string;
  makerOrders: string[];
  type: string;
}

/** Lightweight market summary from the Polymarket Gamma API. */
export interface PolySimpleMarket {
  id: number;
  question: string;
  end: string;
  description: string;
  active: boolean;
  funded: boolean;
  rewardsMinSize: number;
  rewardsMaxSpread: number;
  spread: number;
  outcomes: string;
  outcomePrices: string;
  clobTokenIds?: string;
}

/** CLOB liquidity reward configuration attached to a market. */
export interface PolyClobReward {
  id: string;
  conditionId: string;
  assetAddress: string;
  rewardsAmount: number;
  rewardsDailyRate: number;
  /** yyyy-mm-dd */
  startDate: string;
  /** yyyy-mm-dd */
  endDate: string;
}

/** Taxonomy tag on a Polymarket event. */
export interface PolyTag {
  id: string;
  label?: string;
  slug?: string;
  forceShow?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Top-level Polymarket event (groups one or more markets). */
export interface PolymarketEventRecord {
  id: string;
  ticker?: string;
  slug?: string;
  title?: string;
  startDate?: string;
  creationDate?: string;
  endDate?: string;
  image?: string;
  icon?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  new?: boolean;
  featured?: boolean;
  restricted?: boolean;
  liquidity?: number;
  volume?: number;
  reviewStatus?: string;
  createdAt?: string;
  updatedAt?: string;
  competitive?: number;
  volume24hr?: number;
  enableOrderBook?: boolean;
  liquidityClob?: number;
  commentCount?: number;
  markets?: PolyMarket[];
  tags?: PolyTag[];
  cyom?: boolean;
  showAllOutcomes?: boolean;
  showMarketImages?: boolean;
}

/** Full Polymarket CLOB market record (from Gamma API). */
export interface PolyMarket {
  id: number;
  question?: string;
  conditionId?: string;
  slug?: string;
  resolutionSource?: string;
  endDate?: string;
  liquidity?: number;
  startDate?: string;
  image?: string;
  icon?: string;
  description?: string;
  outcome?: unknown[];
  outcomePrices?: unknown[];
  volume?: number;
  active?: boolean;
  closed?: boolean;
  marketMakerAddress?: string;
  createdAt?: string;
  updatedAt?: string;
  new?: boolean;
  featured?: boolean;
  submitted_by?: string;
  archived?: boolean;
  resolvedBy?: string;
  restricted?: boolean;
  groupItemTitle?: string;
  groupItemThreshold?: number;
  questionID?: string;
  enableOrderBook?: boolean;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  volumeNum?: number;
  liquidityNum?: number;
  endDateIso?: string;
  startDateIso?: string;
  hasReviewedDates?: boolean;
  volume24hr?: number;
  clobTokenIds?: unknown[];
  umaBond?: number;
  umaReward?: number;
  volume24hrClob?: number;
  volumeClob?: number;
  liquidityClob?: number;
  acceptingOrders?: boolean;
  negRisk?: boolean;
  commentCount?: number;
  events?: PolymarketEventRecord[];
  ready?: boolean;
  deployed?: boolean;
  funded?: boolean;
  deployedTimestamp?: string;
  acceptingOrdersTimestamp?: string;
  cyom?: boolean;
  competitive?: number;
  pagerDutyNotificationEnabled?: boolean;
  reviewStatus?: string;
  approved?: boolean;
  clobRewards?: PolyClobReward[];
  rewardsMinSize?: number;
  rewardsMaxSpread?: number;
  spread?: number;
}

/** Full CLOB market record as returned from the CLOB API (not Gamma). */
export interface PolyComplexMarket {
  id: number;
  conditionId: string;
  questionId: string;
  tokens: [string, string];
  rewards: string;
  minimumOrderSize: string;
  minimumTickSize: string;
  description: string;
  category: string;
  endDateIso: string;
  gameStartTime: string;
  question: string;
  marketSlug: string;
  minIncentiveSize: string;
  maxIncentiveSpread: string;
  active: boolean;
  closed: boolean;
  secondsDelay: number;
  icon: string;
  fpmm: string;
  name: string;
  price: number;
  tax?: number;
}

/** Lightweight event summary from Gamma API event listing. */
export interface PolySimpleEvent {
  id: number;
  ticker: string;
  slug: string;
  title: string;
  description: string;
  end: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  restricted: boolean;
  new: boolean;
  featured: boolean;
  markets: string;
}

/** News article source. */
export interface PolySource {
  id?: string;
  name?: string;
}

/** News article associated with Polymarket events. */
export interface PolyArticle {
  source?: PolySource;
  author?: string;
  title?: string;
  description?: string;
  url?: string;
  urlToImage?: string;
  publishedAt?: string;
  content?: string;
}

/** Parse a CLOB price string to a float (0–1 range on Polymarket). */
function parseClobPrice(price: string): number {
  return parseFloat(price);
}
