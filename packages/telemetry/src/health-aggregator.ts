// SPDX-License-Identifier: Apache-2.0
/**
 * HealthAggregator — structured health check system.
 *
 * Each registered probe is an async function that returns a ProbeResult.
 * The aggregator runs all probes in parallel and synthesises a single
 * AggregatedHealth response suitable for /health/ready endpoints.
 *
 * Status logic:
 *   - All probes pass   → "ready"
 *   - ≥1 probe fails but ≥1 critical probe passes → "degraded"
 *   - Any critical probe fails → "down"
 *   - All probes timed-out   → "down"
 *
 * Usage:
 *   const health = new HealthAggregator();
 *   health.register("postgres", () => pingDb(), { critical: true, timeoutMs: 2000 });
 *   health.register("redis", () => pingRedis(), { critical: true });
 *   health.register("queue_depth", () => checkQueueDepth(), { critical: false });
 *
 *   const result = await health.check();
 *   // → { status: "ready", checks: { postgres: "ok", redis: "ok", queue_depth: "ok" } }
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type HealthStatus = "ready" | "degraded" | "down";
export type ProbeStatus = "ok" | "fail" | "timeout";

export interface ProbeResult {
  status: ProbeStatus;
  /** Human-readable message — included in the response when status !== "ok" */
  message?: string;
  /** Round-trip latency of the probe in ms */
  latencyMs: number;
}

export interface ProbeConfig {
  /** If critical=true, a failure drives the overall status to "down" */
  critical?: boolean;
  /** Per-probe timeout in ms (default: 5000) */
  timeoutMs?: number;
}

export interface AggregatedHealth {
  status: HealthStatus;
  checks: Record<string, ProbeStatus>;
  messages: Record<string, string>;
  latencies: Record<string, number>;
  checkedAt: Date;
  durationMs: number;
}

export type ProbeFn = () => Promise<{ ok: boolean; message?: string }>;

// ─── HealthProbe (internal) ────────────────────────────────────────────────────

interface RegisteredProbe {
  name: string;
  fn: ProbeFn;
  critical: boolean;
  timeoutMs: number;
}

// ─── HealthAggregator ─────────────────────────────────────────────────────────

export class HealthAggregator {
  private readonly probes: RegisteredProbe[] = [];
  private readonly defaultTimeoutMs: number;

  constructor(defaultTimeoutMs = 5000) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  register(name: string, fn: ProbeFn, config: ProbeConfig = {}): void {
    if (this.probes.some((p) => p.name === name)) {
      throw new Error(`Probe "${name}" is already registered`);
    }
    this.probes.push({
      name,
      fn,
      critical: config.critical ?? false,
      timeoutMs: config.timeoutMs ?? this.defaultTimeoutMs,
    });
  }

  unregister(name: string): boolean {
    const idx = this.probes.findIndex((p) => p.name === name);
    if (idx === -1) return false;
    this.probes.splice(idx, 1);
    return true;
  }

  async check(): Promise<AggregatedHealth> {
    const startedAt = Date.now();
    const checkedAt = new Date();

    if (this.probes.length === 0) {
      return {
        status: "ready",
        checks: {},
        messages: {},
        latencies: {},
        checkedAt,
        durationMs: 0,
      };
    }

    // Run all probes in parallel
    const results = await Promise.all(
      this.probes.map((probe) => this.runProbe(probe)),
    );

    const checks: Record<string, ProbeStatus> = {};
    const messages: Record<string, string> = {};
    const latencies: Record<string, number> = {};

    for (let i = 0; i < this.probes.length; i++) {
      const probe = this.probes[i]!;
      const result = results[i]!;
      checks[probe.name] = result.status;
      if (result.message) messages[probe.name] = result.message;
      latencies[probe.name] = result.latencyMs;
    }

    const status = this.aggregate(results);

    return {
      status,
      checks,
      messages,
      latencies,
      checkedAt,
      durationMs: Date.now() - startedAt,
    };
  }

  private async runProbe(probe: RegisteredProbe): Promise<ProbeResult & { critical: boolean }> {
    const start = Date.now();

    try {
      const resultOrTimeout = await Promise.race([
        probe.fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("__timeout__")), probe.timeoutMs),
        ),
      ]);

      const latencyMs = Date.now() - start;
      return {
        status: resultOrTimeout.ok ? "ok" : "fail",
        ...(resultOrTimeout.ok ? {} : { message: resultOrTimeout.message ?? "probe returned ok=false" }),
        latencyMs,
        critical: probe.critical,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const isTimeout = err instanceof Error && err.message === "__timeout__";
      return {
        status: isTimeout ? "timeout" : "fail",
        message: isTimeout
          ? `Probe timed out after ${probe.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err),
        latencyMs,
        critical: probe.critical,
      };
    }
  }

  private aggregate(results: Array<ProbeResult & { critical: boolean }>): HealthStatus {
    const allOk = results.every((r) => r.status === "ok");
    if (allOk) return "ready";

    const criticalFailed = results.some(
      (r) => r.critical && (r.status === "fail" || r.status === "timeout"),
    );
    if (criticalFailed) return "down";

    return "degraded";
  }
}

// ─── Built-in probe factories ─────────────────────────────────────────────────

/**
 * Create a Postgres connectivity probe using a simple SELECT 1 query.
 * Accepts any object with a `.execute(sql)` method.
 */
export function postgresProbe(
  client: { execute: (sql: string) => Promise<unknown> },
): ProbeFn {
  return async () => {
    await client.execute("SELECT 1");
    return { ok: true };
  };
}

/**
 * Create a Redis connectivity probe using a PING command.
 * Accepts any object with a `.ping()` method that resolves to "PONG".
 */
export function redisProbe(
  client: { ping: () => Promise<string> },
): ProbeFn {
  return async () => {
    const pong = await client.ping();
    return { ok: pong === "PONG", ...(pong !== "PONG" ? { message: `Unexpected PING response: ${pong}` } : {}) };
  };
}

/**
 * Create a queue-depth probe that fails when queue depth exceeds `maxDepth`.
 */
export function queueDepthProbe(
  getDepth: () => Promise<number>,
  maxDepth: number,
): ProbeFn {
  return async () => {
    const depth = await getDepth();
    const ok = depth <= maxDepth;
    return {
      ok,
      ...(ok ? {} : { message: `Queue depth ${depth} exceeds limit ${maxDepth}` }),
    };
  };
}
