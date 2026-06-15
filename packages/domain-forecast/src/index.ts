// SPDX-License-Identifier: Apache-2.0
/**
 * domain-forecast — RPC-based streaming forecast service.
 *
 * Routes domain-specific forecast requests to typed handlers, with
 * protobuf-style RPC gateway and async streaming output.
 *
 * Provides:
 *   • ForecastDomain      — "risk" | "market" | "geo" | "military"
 *   • ForecastScenario    — individual scenario with probability + drivers
 *   • ForecastResult      — complete forecast for a domain
 *   • ForecastHandler     — injectable handler interface per domain
 *   • MockForecastHandler — in-memory test double with configurable responses
 *   • ForecastRequest     — typed RPC request payload
 *   • ForecastResponse    — typed RPC response envelope
 *   • StreamingForecast   — async iterable of progressive forecast chunks
 *   • RpcGateway          — routes domain → registered handler
 *   • ForecastCache       — TTL-based result cache keyed by domain+context
 *   • ForecastService     — high-level facade (cache + gateway + streaming)
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ForecastDomain = "risk" | "market" | "geo" | "military";
/** Forecast horizon type alias. */
export type ForecastHorizon = "24h" | "7d" | "30d" | "90d" | "1y";
/** Scenario likelihood type alias. */
export type ScenarioLikelihood = "low" | "medium" | "high" | "near-certain";

/** Forecast scenario interface definition. */
export interface ForecastScenario {
  id: string;
  label: string;
  description: string;
  probability: number; // 0–1
  likelihood: ScenarioLikelihood;
  drivers: string[]; // key driving factors
  impacts: string[]; // expected downstream effects
  mitigations?: string[]; // recommended mitigations
}

/** Forecast result interface definition. */
export interface ForecastResult {
  domain: ForecastDomain;
  horizon: ForecastHorizon;
  generatedAt: string;
  confidence: number; // 0–1, overall model confidence
  scenarios: ForecastScenario[];
  summary: string;
  indicators: Record<string, number | string>;
  warnings?: string[];
}

/** Forecast request interface definition. */
export interface ForecastRequest {
  domain: ForecastDomain;
  horizon: ForecastHorizon;
  context?: Record<string, unknown>;
  /** Include streaming chunks (default: false) */
  stream?: boolean;
  /** Force re-generation even if cached */
  forceRefresh?: boolean;
}

// ── RPC envelope ──────────────────────────────────────────────────────────────

export interface ForecastResponse {
  requestId: string;
  domain: ForecastDomain;
  status: "ok" | "error" | "partial";
  result?: ForecastResult;
  error?: string;
  durationMs: number;
}

/** Forecast chunk interface definition. */
export interface ForecastChunk {
  requestId: string;
  sequence: number;
  type: "scenario" | "indicator" | "summary" | "warning" | "complete";
  data: unknown;
}

// ── ForecastHandler interface ─────────────────────────────────────────────────

export interface ForecastHandler {
  domain: ForecastDomain;
  generate(request: ForecastRequest): Promise<ForecastResult>;
  stream?(request: ForecastRequest): AsyncIterable<ForecastChunk>;
}

// ── MockForecastHandler ───────────────────────────────────────────────────────

export interface MockHandlerBehavior {
  result?: Partial<ForecastResult>;
  throws?: string;
  delayMs?: number;
}

let _reqSeq = 0;

function makeDefaultResult(domain: ForecastDomain, horizon: ForecastHorizon): ForecastResult {
  const seq = ++_reqSeq;
  return {
    domain,
    horizon,
    generatedAt: new Date().toISOString(),
    confidence: 0.75,
    summary: `Mock forecast for ${domain} over ${horizon}`,
    indicators: { signalStrength: "medium", dataQuality: 0.8 },
    scenarios: [
      {
        id: `s-${seq}-1`,
        label: "Baseline",
        description: "Most likely continuation of current trends",
        probability: 0.6,
        likelihood: "high",
        drivers: ["historical_pattern", "current_conditions"],
        impacts: ["moderate_change"],
      },
      {
        id: `s-${seq}-2`,
        label: "Adverse",
        description: "Downside scenario with escalation",
        probability: 0.3,
        likelihood: "medium",
        drivers: ["external_shock"],
        impacts: ["significant_disruption"],
        mitigations: ["early_warning_system"],
      },
      {
        id: `s-${seq}-3`,
        label: "Upside",
        description: "Positive resolution scenario",
        probability: 0.1,
        likelihood: "low",
        drivers: ["resolution_signal"],
        impacts: ["improvement"],
      },
    ],
  };
}

/** Mock forecast handler. */
export class MockForecastHandler implements ForecastHandler {
  readonly domain: ForecastDomain;
  private behavior: MockHandlerBehavior;
  readonly calls: ForecastRequest[] = [];

  constructor(domain: ForecastDomain, behavior: MockHandlerBehavior = {}) {
    this.domain = domain;
    this.behavior = behavior;
  }

  async generate(request: ForecastRequest): Promise<ForecastResult> {
    this.calls.push(request);
    if (this.behavior.delayMs) {
      await new Promise((r) => setTimeout(r, this.behavior.delayMs));
    }
    if (this.behavior.throws) throw new Error(this.behavior.throws);
    return { ...makeDefaultResult(this.domain, request.horizon), ...this.behavior.result };
  }

  async *stream(request: ForecastRequest): AsyncIterable<ForecastChunk> {
    const result = await this.generate(request);
    const requestId = `req-${Date.now()}`;
    let seq = 0;

    for (const scenario of result.scenarios) {
      yield { requestId, sequence: seq++, type: "scenario", data: scenario };
    }
    for (const [key, value] of Object.entries(result.indicators)) {
      yield { requestId, sequence: seq++, type: "indicator", data: { key, value } };
    }
    if (result.warnings) {
      for (const warning of result.warnings) {
        yield { requestId, sequence: seq++, type: "warning", data: warning };
      }
    }
    yield { requestId, sequence: seq++, type: "summary", data: result.summary };
    yield { requestId, sequence: seq++, type: "complete", data: result };
  }
}

// ── ForecastCache ─────────────────────────────────────────────────────────────

export class ForecastCache {
  private cache = new Map<string, { result: ForecastResult; expiresAt: number }>();
  private ttlMs: number;

  constructor(ttlMs = 60 * 60 * 1000) {
    // 1 hour default
    this.ttlMs = ttlMs;
  }

  private key(
    domain: ForecastDomain,
    horizon: ForecastHorizon,
    context?: Record<string, unknown>,
  ): string {
    const ctx = context ? JSON.stringify(Object.entries(context).sort()) : "";
    return `${domain}:${horizon}:${ctx}`;
  }

  set(request: ForecastRequest, result: ForecastResult): void {
    const k = this.key(request.domain, request.horizon, request.context);
    this.cache.set(k, { result, expiresAt: Date.now() + this.ttlMs });
  }

  get(request: ForecastRequest): ForecastResult | null {
    const k = this.key(request.domain, request.horizon, request.context);
    const entry = this.cache.get(k);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(k);
      return null;
    }
    return entry.result;
  }

  invalidate(domain: ForecastDomain): void {
    for (const k of [...this.cache.keys()]) {
      if (k.startsWith(`${domain}:`)) this.cache.delete(k);
    }
  }

  clear(): void {
    this.cache.clear();
  }
  size(): number {
    return this.cache.size;
  }
}

// ── RpcGateway ────────────────────────────────────────────────────────────────

let _rpcSeq = 0;

/** Rpc gateway. */
export class RpcGateway {
  private handlers = new Map<ForecastDomain, ForecastHandler>();

  register(handler: ForecastHandler): this {
    this.handlers.set(handler.domain, handler);
    return this;
  }

  get(domain: ForecastDomain): ForecastHandler | undefined {
    return this.handlers.get(domain);
  }

  has(domain: ForecastDomain): boolean {
    return this.handlers.has(domain);
  }

  domains(): ForecastDomain[] {
    return [...this.handlers.keys()];
  }

  async call(request: ForecastRequest): Promise<ForecastResponse> {
    const requestId = `rpc-${++_rpcSeq}`;
    const t0 = Date.now();
    const handler = this.handlers.get(request.domain);

    if (!handler) {
      return {
        requestId,
        domain: request.domain,
        status: "error",
        error: `No handler registered for domain: ${request.domain}`,
        durationMs: 0,
      };
    }

    try {
      const result = await handler.generate(request);
      return {
        requestId,
        domain: request.domain,
        status: "ok",
        result,
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      return {
        requestId,
        domain: request.domain,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      };
    }
  }

  async *stream(request: ForecastRequest): AsyncIterable<ForecastChunk> {
    const handler = this.handlers.get(request.domain);
    if (!handler) {
      throw new Error(`No handler registered for domain: ${request.domain}`);
    }
    if (!handler.stream) {
      throw new Error(`Handler for domain '${request.domain}' does not support streaming`);
    }
    yield* handler.stream(request);
  }

  /** Call all registered domains in parallel and return all responses. */
  async callAll(
    horizon: ForecastHorizon,
    context?: Record<string, unknown>,
  ): Promise<ForecastResponse[]> {
    return Promise.all(this.domains().map((domain) => this.call({ domain, horizon, context })));
  }
}

// ── ForecastService ───────────────────────────────────────────────────────────

export interface ForecastServiceOptions {
  gateway: RpcGateway;
  cache?: ForecastCache;
}

/** Forecast service. */
export class ForecastService {
  private gateway: RpcGateway;
  private cache: ForecastCache;

  constructor(opts: ForecastServiceOptions) {
    this.gateway = opts.gateway;
    this.cache = opts.cache ?? new ForecastCache();
  }

  /** Fetch a forecast; cache-first unless forceRefresh. */
  async forecast(request: ForecastRequest): Promise<ForecastResponse> {
    if (!request.forceRefresh) {
      const cached = this.cache.get(request);
      if (cached) {
        return {
          requestId: "cached",
          domain: request.domain,
          status: "ok",
          result: cached,
          durationMs: 0,
        };
      }
    }

    const response = await this.gateway.call(request);
    if (response.status === "ok" && response.result) {
      this.cache.set(request, response.result);
    }
    return response;
  }

  /** Stream a forecast (bypasses cache — streaming is always fresh). */
  async *stream(request: ForecastRequest): AsyncIterable<ForecastChunk> {
    yield* this.gateway.stream(request);
  }

  /** Forecast all registered domains at once. */
  async forecastAll(
    horizon: ForecastHorizon,
    context?: Record<string, unknown>,
  ): Promise<ForecastResponse[]> {
    return this.gateway.callAll(horizon, context);
  }

  getCache(): ForecastCache {
    return this.cache;
  }
  getGateway(): RpcGateway {
    return this.gateway;
  }
}

// ── Convenience factory ───────────────────────────────────────────────────────

export function createDefaultGateway(
  behaviors: Partial<Record<ForecastDomain, MockHandlerBehavior>> = {},
): RpcGateway {
  const gateway = new RpcGateway();
  const domains: ForecastDomain[] = ["risk", "market", "geo", "military"];
  for (const domain of domains) {
    gateway.register(new MockForecastHandler(domain, behaviors[domain] ?? {}));
  }
  return gateway;
}

// ── TypedNoopForecastHandler ──────────────────────────────────────────────────

export class TypedNoopForecastHandler implements ForecastHandler {
  readonly domain: ForecastDomain;
  private reason: string;

  constructor(domain: ForecastDomain, reason?: string) {
    this.domain = domain;
    this.reason = reason ?? `No handler configured for domain: ${domain}`;
  }

  async generate(request: ForecastRequest): Promise<ForecastResult> {
    return {
      domain: request.domain,
      horizon: request.horizon,
      generatedAt: new Date().toISOString(),
      confidence: 0,
      summary: this.reason,
      indicators: { source: "noop", reason: this.reason },
      scenarios: [],
    };
  }

  async *stream(request: ForecastRequest): AsyncIterable<ForecastChunk> {
    const result = await this.generate(request);
    yield { requestId: `noop-${Date.now()}`, sequence: 0, type: "complete", data: result };
  }
}

// ── OpenWeatherForecastHandler ────────────────────────────────────────────────

export interface ForecastPoint {
  timestamp: string;
  value: number;
  unit: string;
  confidence: number;
}

/** Open weather forecast handler options interface definition. */
export interface OpenWeatherForecastHandlerOptions {
  apiKey?: string;
  city?: string;
  fetchFn?: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

interface OWMItem {
  dt_txt: string;
  main: { temp: number; humidity: number };
  weather: { description: string }[];
  wind: { speed: number };
  clouds: { all: number };
}

interface OWMResponse {
  list: OWMItem[];
  city: { name: string };
}

/** Open weather forecast handler. */
export class OpenWeatherForecastHandler implements ForecastHandler {
  readonly domain: ForecastDomain = "geo";
  private apiKey: string;
  private city: string;
  private fetchFn: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

  constructor(opts: OpenWeatherForecastHandlerOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.OWM_API_KEY ?? "";
    this.city = opts.city ?? process.env.OWM_CITY ?? "London";
    this.fetchFn = opts.fetchFn ?? ((url) => fetch(url));
  }

  async generate(request: ForecastRequest): Promise<ForecastResult> {
    if (!this.apiKey) {
      return new TypedNoopForecastHandler(this.domain, "OWM_API_KEY not configured").generate(
        request,
      );
    }
    const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(this.city)}&appid=${this.apiKey}&units=metric`;
    let data: OWMResponse;
    try {
      const resp = await this.fetchFn(url);
      if (!resp.ok)
        return new TypedNoopForecastHandler(this.domain, "OWM API error").generate(request);
      data = (await resp.json()) as OWMResponse;
    } catch {
      return new TypedNoopForecastHandler(this.domain, "OWM fetch failed").generate(request);
    }
    const items = data.list ?? [];
    if (!items.length)
      return new TypedNoopForecastHandler(this.domain, "No data returned").generate(request);

    const buckets = new Map<string, OWMItem[]>();
    for (const it of items) {
      const day = it.dt_txt.slice(0, 10);
      const arr = buckets.get(day) ?? [];
      arr.push(it);
      buckets.set(day, arr);
    }
    const scenarios: ForecastScenario[] = [...buckets.entries()]
      .slice(0, 3)
      .map(([day, its], i) => {
        const avgTemp = its.reduce((s, it) => s + it.main.temp, 0) / its.length;
        const avgCloud = its.reduce((s, it) => s + it.clouds.all, 0) / its.length;
        const desc = its[0]?.weather[0]?.description ?? "unknown";
        const prob = Math.max(0.1, (100 - avgCloud) / 100);
        return {
          id: `owm-${day}-${i}`,
          label: i === 0 ? "Today" : i === 1 ? "Tomorrow" : `Day +${i + 1}`,
          description: `${desc}, avg ${avgTemp.toFixed(1)}°C`,
          probability: prob,
          likelihood: prob > 0.7 ? "high" : prob > 0.4 ? "medium" : "low",
          drivers: ["openweathermap"],
          impacts: [desc],
        };
      });
    const latest = items[0]!;
    return {
      domain: request.domain,
      horizon: request.horizon,
      generatedAt: new Date().toISOString(),
      confidence: 1 - (latest.clouds.all / 100) * 0.3,
      summary: `${data.city?.name ?? this.city}: ${latest.weather[0]?.description ?? ""}`,
      indicators: {
        temperature_c: latest.main.temp,
        humidity_pct: latest.main.humidity,
        wind_speed_ms: latest.wind.speed,
        source: "openweathermap",
      },
      scenarios,
    };
  }
}

/** Production gateway — wires real handlers when env vars are set. */
export function createProductionGateway(
  behaviors: Partial<Record<ForecastDomain, MockHandlerBehavior>> = {},
): RpcGateway {
  const gateway = new RpcGateway();
  const geoHandler =
    process.env.OWM_API_KEY && !behaviors["geo"]
      ? new OpenWeatherForecastHandler()
      : behaviors["geo"]
        ? new MockForecastHandler("geo", behaviors["geo"])
        : new TypedNoopForecastHandler("geo");
  gateway.register(geoHandler);
  for (const domain of ["risk", "market", "military"] as ForecastDomain[]) {
    gateway.register(
      behaviors[domain]
        ? new MockForecastHandler(domain, behaviors[domain]!)
        : new TypedNoopForecastHandler(domain),
    );
  }
  return gateway;
}
