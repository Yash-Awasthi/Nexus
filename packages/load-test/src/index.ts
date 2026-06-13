// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/load-test — Load testing suite for the Nexus platform.
 *
 * Architecture
 * ─────────────
 *   ScenarioFn       — what one virtual user (VU) does per iteration
 *   VUContext        — per-iteration context: http client, check(), sleep()
 *   MetricsCollector — thread-safe (single-threaded JS) sample recorder
 *                      computing p50/p90/p95/p99 latency, error rate, RPS
 *   LoadRunner       — drives staged ramp: spawns N concurrent VU loops,
 *                      advances through stages, drains gracefully
 *   evaluateThresholds — checks LoadTestResult against pass/fail criteria
 *
 * Staged ramp model
 * ──────────────────
 *   A run is composed of one or more LoadStage entries, each specifying
 *   { durationMs, vus }.  The runner spawns `vus` concurrent async loops
 *   for the stage duration, then moves to the next stage.  VU loops that
 *   are mid-iteration when the stage ends are given `gracefulStopMs` to
 *   finish naturally before being abandoned.
 *
 * Injectability
 * ─────────────
 *   now  : () => number   — injectable clock (default: Date.now)
 *   sleep: (ms) => Promise — injectable sleep (default: setTimeout-based)
 *   Both parameters exist specifically to make tests deterministic without
 *   real wall-clock delays.
 *
 * Usage
 * ─────
 * ```ts
 * import { LoadRunner, evaluateThresholds } from "@nexus/load-test";
 *
 * const runner = new LoadRunner({
 *   scenario: async (ctx) => {
 *     const res = await ctx.http.get("https://api.nexus.dev/health");
 *     ctx.check("status-200", res.status === 200);
 *   },
 * });
 *
 * const result = await runner.run({
 *   stages: [
 *     { durationMs: 30_000, vus: 10, name: "ramp-up" },
 *     { durationMs: 60_000, vus: 50, name: "sustained" },
 *     { durationMs: 10_000, vus: 0,  name: "cool-down" },
 *   ],
 *   thresholds: { p95LatencyMs: 500, errorRatePercent: 1 },
 * });
 *
 * console.log(result.thresholdsPassed, result.latency.p95);
 * ```
 *
 * Zero hard inter-package dependencies.
 */

// ── Error ─────────────────────────────────────────────────────────────────────

export type LoadTestErrorCode =
  | "SCENARIO_ERROR"
  | "INVALID_CONFIG"
  | "RUNNER_ABORTED";

export class LoadTestError extends Error {
  readonly code: LoadTestErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(code: LoadTestErrorCode, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "LoadTestError";
    this.code = code;
    this.context = context;
  }
}

// ── HTTP client for scenarios ──────────────────────────────────────────────────

export interface HttpResponse {
  status: number;
  ok: boolean;
  body: unknown;
  latencyMs: number;
}

export interface LoadTestHttpClient {
  get(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
  post(url: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResponse>;
  put(url: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResponse>;
  del(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
}

/**
 * No-op HTTP client — all methods return immediately with status 200.
 * Use in unit tests when you don't want real network calls from scenarios.
 */
export class NullHttpClient implements LoadTestHttpClient {
  async get(_url: string): Promise<HttpResponse> {
    return { status: 200, ok: true, body: null, latencyMs: 0 };
  }
  async post(_url: string): Promise<HttpResponse> {
    return { status: 200, ok: true, body: null, latencyMs: 0 };
  }
  async put(_url: string): Promise<HttpResponse> {
    return { status: 200, ok: true, body: null, latencyMs: 0 };
  }
  async del(_url: string): Promise<HttpResponse> {
    return { status: 200, ok: true, body: null, latencyMs: 0 };
  }
}

/**
 * Fetch-backed HTTP client for real load test runs.
 */
export class FetchHttpClient implements LoadTestHttpClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async get(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
    return this._req("GET", url, undefined, headers);
  }
  async post(url: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResponse> {
    return this._req("POST", url, body, headers);
  }
  async put(url: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResponse> {
    return this._req("PUT", url, body, headers);
  }
  async del(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
    return this._req("DELETE", url, undefined, headers);
  }

  private async _req(
    method: string,
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpResponse> {
    const start = Date.now();
    const res = await this.fetchFn(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const latencyMs = Date.now() - start;
    let responseBody: unknown = null;
    try {
      responseBody = await res.json();
    } catch {
      // non-JSON body — ignore
    }
    return { status: res.status, ok: res.ok, body: responseBody, latencyMs };
  }
}

// ── VU context ─────────────────────────────────────────────────────────────────

export interface CheckResult {
  name: string;
  passed: boolean;
}

export interface VUContext {
  /** 1-based VU id within the current stage */
  readonly vuId: number;
  /** 1-based iteration counter for this VU in the current stage */
  readonly iteration: number;
  /** HTTP client for making requests */
  readonly http: LoadTestHttpClient;
  /**
   * Assert a condition and record the outcome.
   * Failed checks count toward the checksFailed metric.
   */
  check(name: string, value: boolean): void;
  /**
   * Pause execution for `ms` milliseconds.
   * Uses the runner's injectable sleep — 0ms in unit tests.
   */
  sleep(ms: number): Promise<void>;
}

// ── Scenario ──────────────────────────────────────────────────────────────────

export type ScenarioFn = (ctx: VUContext) => Promise<void>;

// ── Metrics ───────────────────────────────────────────────────────────────────

export interface LatencyStats {
  min: number;
  avg: number;
  max: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

export interface CheckSummary {
  total: number;
  passed: number;
  failed: number;
  rate: number;
}

export interface StageMetrics {
  name?: string;
  vus: number;
  durationMs: number;
  iterations: number;
  errors: number;
}

/** Records raw latency samples and check outcomes, computes derived metrics. */
export class MetricsCollector {
  private readonly samples: number[] = [];
  private errors = 0;
  private checksTotal = 0;
  private checksFailed = 0;
  readonly stageMetrics: StageMetrics[] = [];

  recordSample(latencyMs: number, success: boolean): void {
    this.samples.push(latencyMs);
    if (!success) this.errors++;
  }

  recordCheck(passed: boolean): void {
    this.checksTotal++;
    if (!passed) this.checksFailed++;
  }

  pushStageMetrics(m: StageMetrics): void {
    this.stageMetrics.push(m);
  }

  get totalSamples(): number {
    return this.samples.length;
  }

  get totalErrors(): number {
    return this.errors;
  }

  computeLatency(): LatencyStats {
    if (this.samples.length === 0) {
      return { min: 0, avg: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    return {
      min: sorted[0]!,
      avg: Math.round(sum / sorted.length),
      max: sorted[sorted.length - 1]!,
      p50: percentile(sorted, 50),
      p90: percentile(sorted, 90),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    };
  }

  computeChecks(): CheckSummary {
    const passed = this.checksTotal - this.checksFailed;
    return {
      total: this.checksTotal,
      passed,
      failed: this.checksFailed,
      rate: this.checksTotal === 0 ? 1 : passed / this.checksTotal,
    };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(idx, sorted.length - 1)]!;
}

// ── Load profile types ─────────────────────────────────────────────────────────

export interface LoadStage {
  /** Number of concurrent virtual users for this stage */
  vus: number;
  /** How long this stage runs in milliseconds */
  durationMs: number;
  /** Optional label for reporting */
  name?: string;
}

export interface ThresholdConfig {
  /** Maximum allowed p95 latency in ms */
  p95LatencyMs?: number;
  /** Maximum allowed p99 latency in ms */
  p99LatencyMs?: number;
  /** Maximum allowed error rate (0–100) */
  errorRatePercent?: number;
  /** Minimum required throughput in requests/second */
  minThroughputRps?: number;
  /** Minimum required check pass rate (0–1) */
  minCheckPassRate?: number;
}

export interface RunConfig {
  stages: LoadStage[];
  thresholds?: ThresholdConfig;
  /** Max ms to wait for in-flight iterations after stage deadline (default: 5000) */
  gracefulStopMs?: number;
}

// ── Load test result ──────────────────────────────────────────────────────────

export interface LoadTestResult {
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  /** 0–100 */
  errorRatePercent: number;
  /** Requests per second over entire run */
  throughputRps: number;
  latency: LatencyStats;
  checks: CheckSummary;
  /** Wall-clock duration of the full run in ms */
  durationMs: number;
  stageMetrics: StageMetrics[];
  /** true if all thresholds passed (or none were configured) */
  thresholdsPassed: boolean;
  /** Human-readable description of each violated threshold */
  thresholdViolations: string[];
}

// ── Threshold evaluation ───────────────────────────────────────────────────────

export function evaluateThresholds(
  result: Omit<LoadTestResult, "thresholdsPassed" | "thresholdViolations">,
  thresholds: ThresholdConfig,
): { passed: boolean; violations: string[] } {
  const violations: string[] = [];

  if (
    thresholds.p95LatencyMs !== undefined &&
    result.latency.p95 > thresholds.p95LatencyMs
  ) {
    violations.push(
      `p95 latency ${result.latency.p95}ms exceeds threshold ${thresholds.p95LatencyMs}ms`,
    );
  }

  if (
    thresholds.p99LatencyMs !== undefined &&
    result.latency.p99 > thresholds.p99LatencyMs
  ) {
    violations.push(
      `p99 latency ${result.latency.p99}ms exceeds threshold ${thresholds.p99LatencyMs}ms`,
    );
  }

  if (
    thresholds.errorRatePercent !== undefined &&
    result.errorRatePercent > thresholds.errorRatePercent
  ) {
    violations.push(
      `error rate ${result.errorRatePercent.toFixed(2)}% exceeds threshold ${thresholds.errorRatePercent}%`,
    );
  }

  if (
    thresholds.minThroughputRps !== undefined &&
    result.throughputRps < thresholds.minThroughputRps
  ) {
    violations.push(
      `throughput ${result.throughputRps.toFixed(2)} rps below threshold ${thresholds.minThroughputRps} rps`,
    );
  }

  if (
    thresholds.minCheckPassRate !== undefined &&
    result.checks.rate < thresholds.minCheckPassRate
  ) {
    violations.push(
      `check pass rate ${(result.checks.rate * 100).toFixed(1)}% below threshold ${(thresholds.minCheckPassRate * 100).toFixed(1)}%`,
    );
  }

  return { passed: violations.length === 0, violations };
}

// ── SleepFn ────────────────────────────────────────────────────────────────────

export type SleepFn = (ms: number) => Promise<void>;
export type NowFn = () => number;

// ── LoadRunner ─────────────────────────────────────────────────────────────────

export interface LoadRunnerConfig {
  scenario: ScenarioFn;
  /** Default HTTP client injected into VUContext (default: NullHttpClient) */
  http?: LoadTestHttpClient;
  /** Injectable clock — default: Date.now */
  now?: NowFn;
  /** Injectable sleep — default: real setTimeout */
  sleep?: SleepFn;
}

export class LoadRunner {
  private readonly scenario: ScenarioFn;
  private readonly http: LoadTestHttpClient;
  private readonly now: NowFn;
  private readonly sleep: SleepFn;

  constructor(config: LoadRunnerConfig) {
    this.scenario = config.scenario;
    this.http = config.http ?? new NullHttpClient();
    this.now = config.now ?? (() => Date.now());
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async run(config: RunConfig): Promise<LoadTestResult> {
    if (!config.stages || config.stages.length === 0) {
      throw new LoadTestError("INVALID_CONFIG", "At least one stage is required");
    }
    for (const stage of config.stages) {
      if (stage.vus < 0) {
        throw new LoadTestError("INVALID_CONFIG", "Stage vus must be >= 0");
      }
      if (stage.durationMs < 0) {
        throw new LoadTestError("INVALID_CONFIG", "Stage durationMs must be >= 0");
      }
    }

    const metrics = new MetricsCollector();
    const runStart = this.now();

    for (const stage of config.stages) {
      await this._runStage(stage, metrics, config.gracefulStopMs ?? 5000);
    }

    const totalDurationMs = this.now() - runStart;

    // ── Build result ────────────────────────────────────────────────────────
    const total = metrics.totalSamples;
    const failed = metrics.totalErrors;
    const success = total - failed;
    const errorRatePercent = total === 0 ? 0 : (failed / total) * 100;
    const throughputRps = totalDurationMs === 0 ? 0 : (total / totalDurationMs) * 1000;

    const partial: Omit<LoadTestResult, "thresholdsPassed" | "thresholdViolations"> = {
      totalRequests: total,
      successRequests: success,
      failedRequests: failed,
      errorRatePercent,
      throughputRps,
      latency: metrics.computeLatency(),
      checks: metrics.computeChecks(),
      durationMs: totalDurationMs,
      stageMetrics: metrics.stageMetrics,
    };

    const { passed, violations } = config.thresholds
      ? evaluateThresholds(partial, config.thresholds)
      : { passed: true, violations: [] };

    return { ...partial, thresholdsPassed: passed, thresholdViolations: violations };
  }

  private async _runStage(
    stage: LoadStage,
    metrics: MetricsCollector,
    gracefulStopMs: number,
  ): Promise<void> {
    if (stage.vus === 0) {
      // Cool-down / idle stage — just sleep
      if (stage.durationMs > 0) await this.sleep(stage.durationMs);
      metrics.pushStageMetrics({ name: stage.name, vus: 0, durationMs: stage.durationMs, iterations: 0, errors: 0 });
      return;
    }

    const stageDeadline = this.now() + stage.durationMs;
    let stageIterations = 0;
    let stageErrors = 0;

    // Each VU runs an async loop until the stage deadline
    const vuLoops = Array.from({ length: stage.vus }, (_, i) =>
      this._vuLoop(i + 1, stageDeadline, metrics, (itCount, errCount) => {
        stageIterations += itCount;
        stageErrors += errCount;
      }),
    );

    // Race all VU loops — they self-terminate at the deadline
    await Promise.all(vuLoops);

    metrics.pushStageMetrics({
      name: stage.name,
      vus: stage.vus,
      durationMs: stage.durationMs,
      iterations: stageIterations,
      errors: stageErrors,
    });

    // Graceful stop gap — give lingering scenarios time to complete
    if (gracefulStopMs > 0) await this.sleep(Math.min(gracefulStopMs, 10));
  }

  private async _vuLoop(
    vuId: number,
    deadline: number,
    metrics: MetricsCollector,
    onIteration: (itCount: number, errCount: number) => void,
  ): Promise<void> {
    let iteration = 0;

    while (this.now() < deadline) {
      iteration++;
      const iterStart = this.now();
      let success = true;

      const ctx: VUContext = {
        vuId,
        iteration,
        http: this.http,
        check: (name: string, value: boolean) => {
          metrics.recordCheck(value);
        },
        sleep: this.sleep,
      };

      try {
        await this.scenario(ctx);
      } catch {
        success = false;
      }

      const latencyMs = this.now() - iterStart;
      metrics.recordSample(latencyMs, success);
      onIteration(1, success ? 0 : 1);

      // Yield to allow other VU loops to run
      await this.sleep(0);
    }
  }
}

// ── Scenario builders ─────────────────────────────────────────────────────────

/**
 * Wrap a scenario with a per-iteration sleep between requests.
 * Useful for pacing VUs to avoid thundering-herd spikes.
 */
export function withPacing(scenario: ScenarioFn, thinkTimeMs: number): ScenarioFn {
  return async (ctx) => {
    await scenario(ctx);
    await ctx.sleep(thinkTimeMs);
  };
}

/**
 * Combine multiple scenarios into a single sequential scenario.
 * All steps run in order within one VU iteration.
 */
export function sequential(...scenarios: ScenarioFn[]): ScenarioFn {
  return async (ctx) => {
    for (const s of scenarios) {
      await s(ctx);
    }
  };
}

/**
 * Weight-based scenario picker.
 * Randomly selects a scenario proportional to its weight each iteration.
 */
export interface WeightedScenario {
  scenario: ScenarioFn;
  weight: number;
}

export function weighted(options: WeightedScenario[], rng?: () => number): ScenarioFn {
  const totalWeight = options.reduce((s, o) => s + o.weight, 0);
  const rand = rng ?? Math.random;
  return async (ctx) => {
    let r = rand() * totalWeight;
    for (const { scenario, weight } of options) {
      r -= weight;
      if (r <= 0) {
        await scenario(ctx);
        return;
      }
    }
    // Fallback — pick last
    await options[options.length - 1]!.scenario(ctx);
  };
}
