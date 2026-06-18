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

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
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
    const rawList: PolyRaw[] = Array.isArray(body) ? body : ((body as PolyListResp).data ?? []);

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
      return { data: null, error: err instanceof Error ? err.message : String(err) };
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
      return { data: null, error: err instanceof Error ? err.message : String(err) };
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
  value: number;    // normalised 0–1 probability
  confidence: number;
  reasoning?: string;
}

export interface SwarmConsensusResult {
  consensus: number;         // weighted median probability
  mean: number;              // simple mean
  spread: number;            // max − min
  predictions: SwarmPrediction[];
  totalWeight: number;
  timestamp: string;
}

/** Swarm consensus */
export class SwarmConsensus {
  private predictors: Map<string, SwarmPredictor> = new Map();

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
      return { consensus: 0.5, mean: 0.5, spread: 0, predictions: [], totalWeight: 0, timestamp: new Date().toISOString() };
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
      if (cumW >= totalWeight / 2) { median = p.value; break; }
    }

    const mean = weighted.reduce((s, p) => s + p.value * p.w, 0) / totalWeight;
    const values = predictions.map((p) => p.value);
    const spread = Math.max(...values) - Math.min(...values);

    return { consensus: Math.round(median * 10000) / 10000, mean: Math.round(mean * 10000) / 10000, spread, predictions, totalWeight, timestamp: new Date().toISOString() };
  }
}

// ── TradingAnalysisOrchestrator — TradingAgents multi-role pipeline ────────────
//
// TradingAgents (TauricResearch): Decomposes trading decisions into specialised
// roles: fundamental analyst, sentiment analyst, technical analyst → trader
// (proposes position) → risk manager (validates) → portfolio manager (sizes).
// Each agent is an injectable LLM call; the pipeline runs in sequence with
// a shared context object accumulating evidence.

export interface TradeContext {
  symbol: string;
  question?: string;         // for prediction markets
  data: Record<string, unknown>;
  analyses: Record<string, string>;
  proposal?: { action: "buy" | "sell" | "hold"; confidence: number; reasoning: string };
  riskAssessment?: { approved: boolean; adjustedConfidence: number; notes: string };
}

export type AgentRole = "fundamental" | "sentiment" | "technical" | "trader" | "risk_manager";

export interface TradeAgentFn {
  (ctx: TradeContext, role: AgentRole): Promise<string>;
}

export interface TradingAnalysisResult {
  symbol: string;
  action: "buy" | "sell" | "hold";
  confidence: number;       // 0–1
  reasoning: string;
  riskApproved: boolean;
  analyses: Record<string, string>;
  timestamp: string;
}

/** Trading analysis orchestrator */
export class TradingAnalysisOrchestrator {
  private agentFn: TradeAgentFn;
  private roles: AgentRole[];

  constructor(opts: { agentFn: TradeAgentFn; roles?: AgentRole[] }) {
    this.agentFn = opts.agentFn;
    this.roles = opts.roles ?? ["fundamental", "sentiment", "technical", "trader", "risk_manager"];
  }

  async analyze(symbol: string, data: Record<string, unknown>): Promise<TradingAnalysisResult> {
    const ctx: TradeContext = { symbol, data, analyses: {} };

    for (const role of this.roles) {
      try {
        const output = await this.agentFn(ctx, role);

        if (role === "trader") {
          const action = /\b(buy|long)\b/i.test(output) ? "buy"
            : /\b(sell|short)\b/i.test(output) ? "sell"
            : "hold";
          const confMatch = output.match(/confidence[:\s]+(\d+(?:\.\d+)?)\s*%?/i);
          ctx.proposal = {
            action, confidence: confMatch ? parseFloat(confMatch[1]!) / 100 : 0.5,
            reasoning: output.slice(0, 500),
          };
        } else if (role === "risk_manager") {
          const approved = !/\b(reject|deny|do not|don.t)\b/i.test(output);
          const adjMatch = output.match(/adjust(?:ed)? confidence[:\s]+(\d+(?:\.\d+)?)\s*%?/i);
          ctx.riskAssessment = {
            approved, notes: output.slice(0, 300),
            adjustedConfidence: adjMatch ? parseFloat(adjMatch[1]!) / 100 : (ctx.proposal?.confidence ?? 0.5),
          };
        } else {
          ctx.analyses[role] = output.slice(0, 600);
        }
      } catch { /* non-fatal — skip failing agent */ }
    }

    const finalAction = ctx.riskAssessment?.approved === false ? "hold" : (ctx.proposal?.action ?? "hold");
    const finalConf = ctx.riskAssessment?.adjustedConfidence ?? ctx.proposal?.confidence ?? 0.5;

    return {
      symbol,
      action: finalAction,
      confidence: Math.round(finalConf * 100) / 100,
      reasoning: ctx.proposal?.reasoning ?? "No proposal generated",
      riskApproved: ctx.riskAssessment?.approved ?? true,
      analyses: ctx.analyses,
      timestamp: new Date().toISOString(),
    };
  }
}

// ── FinancialResearchAgent — dexter-inspired task planning + self-validation ───
//
// dexter (virattt/dexter): "Dexter takes complex financial questions and turns
// them into clear, step-by-step research plans. It runs those tasks using live
// market data, checks its own work, and refines the results until it has a
// confident, data-backed answer."
//
// Key pattern: Plan → Execute → Validate → Refine (with loop detection).

export interface ResearchTask {
  id: string;
  description: string;
  status: "pending" | "running" | "done" | "failed";
  result?: string;
  attempts: number;
}

export interface ResearchPlan {
  question: string;
  tasks: ResearchTask[];
  createdAt: string;
}

export interface ResearchResult {
  question: string;
  answer: string;
  confidence: number;
  tasks: ResearchTask[];
  iterations: number;
  timestamp: string;
}

export type ResearchLlmFn = (prompt: string) => Promise<string>;
export type ResearchToolFn = (task: ResearchTask, context: string) => Promise<string>;

export interface FinancialResearchAgentOpts {
  llm: ResearchLlmFn;
  tools: Record<string, ResearchToolFn>;
  maxIterations?: number;
  maxTaskAttempts?: number;
}

/** Financial research agent */
export class FinancialResearchAgent {
  private llm: ResearchLlmFn;
  private tools: Record<string, ResearchToolFn>;
  private maxIterations: number;
  private maxTaskAttempts: number;

  constructor(opts: FinancialResearchAgentOpts) {
    this.llm = opts.llm;
    this.tools = opts.tools;
    this.maxIterations = opts.maxIterations ?? 5;
    this.maxTaskAttempts = opts.maxTaskAttempts ?? 2;
  }

  async research(question: string): Promise<ResearchResult> {
    // Step 1: Plan
    const plan = await this._plan(question);
    let iterations = 0;
    let context = `Question: ${question}\n\nResearch plan:\n${plan.tasks.map((t) => `- ${t.description}`).join("\n")}\n\n`;

    // Step 2: Execute → Validate loop
    while (iterations < this.maxIterations) {
      iterations++;
      const pending = plan.tasks.filter((t) => t.status === "pending" || t.status === "failed");
      if (!pending.length) break;

      for (const task of pending) {
        if (task.attempts >= this.maxTaskAttempts) { task.status = "failed"; continue; }
        task.status = "running";
        task.attempts++;

        try {
          const toolName = this._selectTool(task.description);
          const tool = this.tools[toolName] ?? this.tools["default"];
          if (!tool) { task.result = "No tool available"; task.status = "failed"; continue; }

          task.result = await tool(task, context);
          context += `\nTask "${task.description}" result:\n${task.result.slice(0, 400)}\n`;
          task.status = "done";
        } catch (e) {
          task.result = String(e);
          task.status = "failed";
        }
      }

      // Step 3: Validate — ask LLM if we have enough to answer
      if (plan.tasks.every((t) => t.status === "done" || t.status === "failed")) break;
      try {
        const validation = await this.llm(
          `${context}\n\nDo we have sufficient data to answer "${question}"? Reply YES or describe what is still missing.`,
        );
        if (/^yes\b/i.test(validation.trim())) break;
      } catch { break; }
    }

    // Step 4: Synthesize
    const doneTasks = plan.tasks.filter((t) => t.status === "done");
    const answer = await this._synthesize(question, context, doneTasks.length, plan.tasks.length);
    const confidence = doneTasks.length / Math.max(plan.tasks.length, 1);

    return { question, answer, confidence: Math.round(confidence * 100) / 100, tasks: plan.tasks, iterations, timestamp: new Date().toISOString() };
  }

  private async _plan(question: string): Promise<ResearchPlan> {
    let raw = "";
    try {
      raw = await this.llm(
        `You are a financial research planner. Break down this question into 3-5 concrete research tasks:\n\n"${question}"\n\nList each task on its own line starting with "- ".`,
      );
    } catch {
      raw = "- Gather market data\n- Analyse sentiment\n- Review fundamentals";
    }

    const tasks: ResearchTask[] = raw
      .split("\n")
      .filter((l) => l.trim().startsWith("-"))
      .slice(0, 6)
      .map((l, i) => ({
        id: `task-${i + 1}`,
        description: l.replace(/^[-*]\s*/, "").trim(),
        status: "pending" as const,
        attempts: 0,
      }));

    if (!tasks.length) tasks.push({ id: "task-1", description: "Analyse the question", status: "pending", attempts: 0 });
    return { question, tasks, createdAt: new Date().toISOString() };
  }

  private _selectTool(description: string): string {
    const d = description.toLowerCase();
    if (d.includes("sentiment") || d.includes("news")) return "sentiment";
    if (d.includes("technical") || d.includes("chart") || d.includes("price")) return "technical";
    if (d.includes("fundamental") || d.includes("balance") || d.includes("income")) return "fundamental";
    if (d.includes("market") || d.includes("polymarket") || d.includes("predict")) return "prediction_market";
    return "default";
  }

  private async _synthesize(question: string, context: string, doneTasks: number, totalTasks: number): Promise<string> {
    try {
      return await this.llm(
        `${context}\n\nSynthesize a concise answer to: "${question}"\nBase your answer only on the research above. Include key data points. Be direct.`,
      );
    } catch {
      return `Research complete (${doneTasks}/${totalTasks} tasks succeeded). Insufficient LLM synthesis available.`;
    }
  }
}

// ── KalshiHttpBackend — Kalshi CLOB API (pmxt/kalshi pattern) ─────────────────
//
// pmxt (pmxt-dev/pmxt): "ccxt for prediction markets" — 14 exchanges unified.
// Kalshi: US-regulated prediction market exchange with REST + WebSocket API.
// Base URL: https://external-api.kalshi.com/trade-api/v2
// Auth: RSA key-pair (private key signs requests) or email+password JWT.
// Read-only market data does NOT require auth.

interface KalshiRawMarket {
  ticker: string;
  title?: string;
  status?: string;
  last_price?: number;
  yes_ask?: number;
  yes_bid?: number;
  yes_bid_size?: number;
  yes_ask_size?: number;
  volume?: number;
  open_interest?: number;
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
  const yesBid = (r.yes_bid ?? 0) / 100;   // Kalshi prices are cents (0-100)
  const yesAsk = (r.yes_ask ?? 0) / 100;
  const lastPrice = (r.last_price ?? 0) / 100;
  const mid = yesBid && yesAsk ? (yesBid + yesAsk) / 2 : lastPrice;

  return {
    id: r.ticker,
    question: r.title ?? r.ticker,
    category: (r.category ?? "general").toLowerCase(),
    outcomes: [
      { id: `${r.ticker}-yes`, label: "Yes", price: mid, probability: mid },
      { id: `${r.ticker}-no`, label: "No", price: 1 - mid, probability: 1 - mid },
    ],
    volume: r.volume ?? 0,
    liquidity: r.open_interest ?? 0,
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
    this.baseUrl = (opts.baseUrl ?? process.env["KALSHI_BASE_URL"] ?? "https://external-api.kalshi.com/trade-api/v2").replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? process.env["KALSHI_API_KEY"];
  }

  async fetchMarket(id: string): Promise<Market> {
    const headers = this._headers();
    const res = await this._fetch(`${this.baseUrl}/markets/${encodeURIComponent(id)}`, headers) as { market?: KalshiRawMarket };
    if (!res.market) throw new Error(`Kalshi market not found: ${id}`);
    return kalshiToMarket(res.market);
  }

  async fetchMarkets(query: MarketQuery): Promise<MarketListResponse> {
    const params = new URLSearchParams({ limit: String(query.limit ?? 100) });
    if (query.category) params.set("category", query.category);

    const headers = this._headers();
    const res = await this._fetch(`${this.baseUrl}/markets?${params}`, headers) as KalshiMarketsResponse;
    const raw = res.markets ?? [];
    const markets = (query.ids ? raw.filter((m) => query.ids!.includes(m.ticker)) : raw).map(kalshiToMarket);

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
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`Kalshi API ${res.status}: ${url}`);
      return res.json();
    } catch (e) { clearTimeout(timer); throw e; }
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

/** MetaculusHttpBackend — community probability forecasts. No auth required. */
export class MetaculusHttpBackend implements MarketBackend {
  private baseUrl: string;

  constructor(opts: { baseUrl?: string } = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://www.metaculus.com/api2").replace(/\/$/, "");
  }

  async fetchMarket(id: string): Promise<Market> {
    const numId = id.replace(/^metaculus-/, "");
    const raw = await this._fetch(`${this.baseUrl}/questions/${numId}/`) as MetaculusRawQuestion;
    return metaculusToMarket(raw);
  }

  async fetchMarkets(query: MarketQuery): Promise<MarketListResponse> {
    const params = new URLSearchParams({ limit: String(query.limit ?? 50), has_community_prediction: "true" });
    if (query.category) params.set("categories", query.category);

    const res = await this._fetch(`${this.baseUrl}/questions/?${params}`) as MetaculusListResponse;
    const markets = (res.results ?? []).map(metaculusToMarket);
    return { markets, total: res.count ?? markets.length, fetchedAt: new Date().toISOString() };
  }

  private async _fetch(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`Metaculus API ${res.status}: ${url}`);
      return res.json();
    } catch (e) { clearTimeout(timer); throw e; }
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
export function applyOrderBookDelta(
  book: OrderBookSnapshot,
  delta: OrderBookDelta
): OrderBookSnapshot {
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
export function bestBidPrice(book: OrderBookSnapshot): number | undefined {
  return book.bids[0]?.price;
}

/** Best ask price (lowest sell), or undefined if the book has no asks. */
export function bestAskPrice(book: OrderBookSnapshot): number | undefined {
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
  quantity: number
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
export function createOrderBook(
  instrumentId: string,
  bookType: BookType = "L2_MBP"
): OrderBookSnapshot {
  return { instrumentId, bookType, bids: [], asks: [], sequence: 0, timestamp: new Date().toISOString() };
}

// ── Polymarket CLOB Domain Models ─────────────────────────────────────────────
// Extracted from: Polymarket/agents agents/utils/objects.py
// Polygon chainId=137, CLOB at clob.polymarket.com, Gamma API at gamma-api.polymarket.com

export const POLYGON_CHAIN_ID = 137;
export const POLYMARKET_CLOB_URL = "https://clob.polymarket.com";
export const POLYMARKET_GAMMA_API_URL = "https://gamma-api.polymarket.com";

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
export function parseClobPrice(price: string): number {
  return parseFloat(price);
}

/** Derive implied probability from CLOB token prices for a binary market. */
export function impliedProbability(yesPrice: number): number {
  return Math.max(0, Math.min(1, yesPrice));
}

/** Resolve the active outcome label from a PolySimpleMarket. */
export function resolveOutcomes(market: PolySimpleMarket): Array<{ label: string; price: number }> {
  try {
    const labels: string[] = JSON.parse(market.outcomes);
    const prices: string[] = JSON.parse(market.outcomePrices);
    return labels.map((label, i) => ({ label, price: parseFloat(prices[i] ?? "0") }));
  } catch {
    return [];
  }
}
