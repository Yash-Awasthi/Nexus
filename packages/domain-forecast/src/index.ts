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
export type ForecastHorizon = "24h" | "7d" | "30d" | "90d" | "1y";
export type ScenarioLikelihood = "low" | "medium" | "high" | "near-certain";

export interface ForecastScenario {
  id: string;
  label: string;
  description: string;
  probability: number;       // 0–1
  likelihood: ScenarioLikelihood;
  drivers: string[];         // key driving factors
  impacts: string[];         // expected downstream effects
  mitigations?: string[];    // recommended mitigations
}

export interface ForecastResult {
  domain: ForecastDomain;
  horizon: ForecastHorizon;
  generatedAt: string;
  confidence: number;        // 0–1, overall model confidence
  scenarios: ForecastScenario[];
  summary: string;
  indicators: Record<string, number | string>;
  warnings?: string[];
}

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

  constructor(ttlMs = 60 * 60 * 1000) { // 1 hour default
    this.ttlMs = ttlMs;
  }

  private key(domain: ForecastDomain, horizon: ForecastHorizon, context?: Record<string, unknown>): string {
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
    if (Date.now() > entry.expiresAt) { this.cache.delete(k); return null; }
    return entry.result;
  }

  invalidate(domain: ForecastDomain): void {
    for (const k of [...this.cache.keys()]) {
      if (k.startsWith(`${domain}:`)) this.cache.delete(k);
    }
  }

  clear(): void { this.cache.clear(); }
  size(): number { return this.cache.size; }
}

// ── RpcGateway ────────────────────────────────────────────────────────────────

let _rpcSeq = 0;

export class RpcGateway {
  private handlers = new Map<ForecastDomain, ForecastHandler>();

  register(handler: ForecastHandler): this {
    this.handlers.set(handler.domain, handler);
    return this;
  }

  get(domain: ForecastDomain): ForecastHandler | undefined {
    return this.handlers.get(domain);
  }

  has(domain: ForecastDomain): boolean { return this.handlers.has(domain); }

  domains(): ForecastDomain[] { return [...this.handlers.keys()]; }

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
      return { requestId, domain: request.domain, status: "ok", result, durationMs: Date.now() - t0 };
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
    return Promise.all(
      this.domains().map((domain) =>
        this.call({ domain, horizon, context })
      )
    );
  }
}

// ── ForecastService ───────────────────────────────────────────────────────────

export interface ForecastServiceOptions {
  gateway: RpcGateway;
  cache?: ForecastCache;
}

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

  getCache(): ForecastCache { return this.cache; }
  getGateway(): RpcGateway { return this.gateway; }
}

// ── Convenience factory ───────────────────────────────────────────────────────

export function createDefaultGateway(behaviors: Partial<Record<ForecastDomain, MockHandlerBehavior>> = {}): RpcGateway {
  const gateway = new RpcGateway();
  const domains: ForecastDomain[] = ["risk", "market", "geo", "military"];
  for (const domain of domains) {
    gateway.register(new MockForecastHandler(domain, behaviors[domain] ?? {}));
  }
  return gateway;
}
