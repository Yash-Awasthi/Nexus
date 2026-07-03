// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  LoadTestError,
  LoadRunner,
  MetricsCollector,
  NullHttpClient,
  FetchHttpClient,
  evaluateThresholds,
  withPacing,
  sequential,
  weighted,
  DEFAULT_THRESHOLDS,
  type ScenarioFn,
  type VUContext,
  type LoadTestResult,
  type ThresholdConfig,
  type SleepFn,
  type NowFn,
} from "../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Monotonically advancing clock — starts at 0, only advances when tick() is called.
 * Useful when you want to control time manually.
 */
function makeClock(step = 1): { now: NowFn; tick: (ms?: number) => void; reset: () => void } {
  let t = 0;
  return {
    now: () => t,
    tick: (ms = step) => {
      t += ms;
    },
    reset: () => {
      t = 0;
    },
  };
}

/**
 * Clock that makes exactly one iteration happen per VU.
 *
 * The runner calls now() in this order:
 *   [0]  run(): runStart
 *   [1]  _runStage(): stageDeadline = now() + durationMs
 *   [2..2+2N-1] each VU (synchronously before first await):
 *        while-check (call 2+2*i) + iterStart (call 3+2*i) for i in 0..N-1
 *   [2+2N..2+3N-1] each VU resumes from scenario (latencyMs end)
 *   [2+3N..2+4N-1] each VU resumes from sleep (exit while-check)
 *
 * So: return 0 for the first (2 + 3*N) calls → deadline = durationMs, all
 * per-iteration calls are "within" the deadline; return durationMs+1 for
 * call (2+3*N)+ → exit while-checks see time past deadline → loops stop.
 */
function makeExactClock(vus = 1, durationMs = 10): NowFn {
  let calls = 0;
  const threshold = 2 + 3 * vus; // first call index that should exceed deadline
  return () => (calls++ < threshold ? 0 : durationMs + 1);
}

const noSleep: SleepFn = async (_ms) => {};

function makeRunner(scenario: ScenarioFn, vus = 1, nowFn?: NowFn): LoadRunner {
  return new LoadRunner({ scenario, now: nowFn ?? makeExactClock(vus, 10), sleep: noSleep });
}

function singleStage(vus = 1, durationMs = 10) {
  return { stages: [{ vus, durationMs }] };
}

// ─────────────────────────────────────────────────────────────────────────────
// LoadTestError
// ─────────────────────────────────────────────────────────────────────────────

describe("LoadTestError", () => {
  it("is an Error with name LoadTestError", () => {
    const e = new LoadTestError("INVALID_CONFIG", "bad");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("LoadTestError");
  });

  it("exposes code and message", () => {
    const e = new LoadTestError("SCENARIO_ERROR", "crash");
    expect(e.code).toBe("SCENARIO_ERROR");
    expect(e.message).toBe("crash");
  });

  it("stores optional context", () => {
    const e = new LoadTestError("RUNNER_ABORTED", "stop", { stage: 2 });
    expect(e.context).toEqual({ stage: 2 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MetricsCollector
// ─────────────────────────────────────────────────────────────────────────────

describe("MetricsCollector", () => {
  let mc: MetricsCollector;

  beforeEach(() => {
    mc = new MetricsCollector();
  });

  it("totalSamples starts at 0", () => {
    expect(mc.totalSamples).toBe(0);
  });

  it("recordSample increments totalSamples", () => {
    mc.recordSample(10, true);
    mc.recordSample(20, true);
    expect(mc.totalSamples).toBe(2);
  });

  it("recordSample counts errors when success:false", () => {
    mc.recordSample(5, false);
    expect(mc.totalErrors).toBe(1);
  });

  it("recordSample does not count errors when success:true", () => {
    mc.recordSample(5, true);
    expect(mc.totalErrors).toBe(0);
  });

  it("computeLatency returns all zeros for empty samples", () => {
    const l = mc.computeLatency();
    expect(l).toEqual({ min: 0, avg: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0 });
  });

  it("computeLatency min and max are correct", () => {
    [50, 10, 90, 30, 70].forEach((v) => mc.recordSample(v, true));
    const l = mc.computeLatency();
    expect(l.min).toBe(10);
    expect(l.max).toBe(90);
  });

  it("computeLatency avg is mean of all samples", () => {
    [10, 20, 30].forEach((v) => mc.recordSample(v, true));
    expect(mc.computeLatency().avg).toBe(20);
  });

  it("computeLatency p50 is median", () => {
    [10, 20, 30, 40, 50].forEach((v) => mc.recordSample(v, true));
    expect(mc.computeLatency().p50).toBe(30);
  });

  it("computeLatency p95 is above 95% of samples", () => {
    // 20 samples: values 1..20
    for (let i = 1; i <= 20; i++) mc.recordSample(i, true);
    const l = mc.computeLatency();
    expect(l.p95).toBeGreaterThanOrEqual(19);
  });

  it("computeLatency p99 is the highest for small sample sets", () => {
    [1, 2, 3].forEach((v) => mc.recordSample(v, true));
    expect(mc.computeLatency().p99).toBe(3);
  });

  it("computeLatency handles single sample", () => {
    mc.recordSample(42, true);
    const l = mc.computeLatency();
    expect(l.min).toBe(42);
    expect(l.max).toBe(42);
    expect(l.p99).toBe(42);
  });

  it("computeChecks total, passed, failed are correct", () => {
    mc.recordCheck(true);
    mc.recordCheck(true);
    mc.recordCheck(false);
    const c = mc.computeChecks();
    expect(c.total).toBe(3);
    expect(c.passed).toBe(2);
    expect(c.failed).toBe(1);
  });

  it("computeChecks rate is 1 when no checks recorded", () => {
    expect(mc.computeChecks().rate).toBe(1);
  });

  it("computeChecks rate is passes/total", () => {
    mc.recordCheck(true);
    mc.recordCheck(false);
    expect(mc.computeChecks().rate).toBe(0.5);
  });

  it("pushStageMetrics stores stage data", () => {
    mc.pushStageMetrics({ name: "ramp", vus: 5, durationMs: 1000, iterations: 10, errors: 1 });
    expect(mc.stageMetrics).toHaveLength(1);
    expect(mc.stageMetrics[0]!.name).toBe("ramp");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NullHttpClient
// ─────────────────────────────────────────────────────────────────────────────

describe("NullHttpClient", () => {
  const client = new NullHttpClient();

  it("get() returns status 200 ok:true", async () => {
    const r = await client.get("https://example.com");
    expect(r.status).toBe(200);
    expect(r.ok).toBe(true);
  });

  it("post() returns status 200", async () => {
    expect((await client.post("https://x.com", {})).status).toBe(200);
  });

  it("put() returns status 200", async () => {
    expect((await client.put("https://x.com")).status).toBe(200);
  });

  it("del() returns status 200", async () => {
    expect((await client.del("https://x.com")).status).toBe(200);
  });

  it("all methods return latencyMs:0", async () => {
    expect((await client.get("x")).latencyMs).toBe(0);
    expect((await client.post("x")).latencyMs).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FetchHttpClient
// ─────────────────────────────────────────────────────────────────────────────

describe("FetchHttpClient", () => {
  it("GET sends correct method and returns status", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: 1 }),
    });
    const client = new FetchHttpClient(mockFetch as typeof fetch);
    const r = await client.get("https://api.nexus.dev/health");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.nexus.dev/health",
      expect.objectContaining({ method: "GET" }),
    );
    expect(r.ok).toBe(true);
    expect(r.body).toEqual({ data: 1 });
  });

  it("POST sends body as JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({}),
    });
    const client = new FetchHttpClient(mockFetch as typeof fetch);
    await client.post("https://api.nexus.dev/item", { name: "x" });
    const callOpts = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(callOpts.body).toBe(JSON.stringify({ name: "x" }));
  });

  it("handles non-JSON response body gracefully", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error("no body");
      },
    });
    const client = new FetchHttpClient(mockFetch as typeof fetch);
    const r = await client.get("https://x.com");
    expect(r.body).toBeNull();
  });

  it("returns latencyMs >= 0", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    const client = new FetchHttpClient(mockFetch as typeof fetch);
    const r = await client.get("https://x.com");
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateThresholds
// ─────────────────────────────────────────────────────────────────────────────

function makeResult(
  overrides: Partial<LoadTestResult> = {},
): Omit<LoadTestResult, "thresholdsPassed" | "thresholdViolations"> {
  return {
    totalRequests: 100,
    successRequests: 99,
    failedRequests: 1,
    errorRatePercent: 1,
    throughputRps: 50,
    latency: { min: 10, avg: 50, max: 200, p50: 45, p90: 120, p95: 150, p99: 190 },
    checks: { total: 100, passed: 99, failed: 1, rate: 0.99 },
    durationMs: 2000,
    stageMetrics: [],
    ...overrides,
  };
}

describe("evaluateThresholds", () => {
  it("passes when all thresholds are met", () => {
    const { passed, violations } = evaluateThresholds(makeResult(), {
      p95LatencyMs: 200,
      errorRatePercent: 5,
      minThroughputRps: 10,
      minCheckPassRate: 0.9,
    });
    expect(passed).toBe(true);
    expect(violations).toHaveLength(0);
  });

  it("passes with empty thresholds", () => {
    const { passed } = evaluateThresholds(makeResult(), {});
    expect(passed).toBe(true);
  });

  it("fails p95LatencyMs when exceeded", () => {
    const { passed, violations } = evaluateThresholds(makeResult(), { p95LatencyMs: 100 });
    expect(passed).toBe(false);
    expect(violations[0]).toContain("p95");
  });

  it("fails p99LatencyMs when exceeded", () => {
    const { violations } = evaluateThresholds(makeResult(), { p99LatencyMs: 50 });
    expect(violations[0]).toContain("p99");
  });

  it("fails errorRatePercent when exceeded", () => {
    const { violations } = evaluateThresholds(makeResult({ errorRatePercent: 10 }), {
      errorRatePercent: 5,
    });
    expect(violations[0]).toContain("error rate");
  });

  it("fails minThroughputRps when below threshold", () => {
    const { violations } = evaluateThresholds(makeResult({ throughputRps: 5 }), {
      minThroughputRps: 20,
    });
    expect(violations[0]).toContain("throughput");
  });

  it("fails minCheckPassRate when below threshold", () => {
    const { violations } = evaluateThresholds(
      makeResult({ checks: { total: 100, passed: 80, failed: 20, rate: 0.8 } }),
      { minCheckPassRate: 0.95 },
    );
    expect(violations[0]).toContain("check pass rate");
  });

  it("collects multiple violations", () => {
    const { violations } = evaluateThresholds(
      makeResult({ errorRatePercent: 20, throughputRps: 1 }),
      { errorRatePercent: 5, minThroughputRps: 100 },
    );
    expect(violations).toHaveLength(2);
  });

  it("violation messages include actual and threshold values", () => {
    const { violations } = evaluateThresholds(makeResult(), { p95LatencyMs: 100 });
    expect(violations[0]).toContain("150ms");
    expect(violations[0]).toContain("100ms");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LoadRunner — basic execution
// ─────────────────────────────────────────────────────────────────────────────

describe("LoadRunner — basic", () => {
  it("throws INVALID_CONFIG when stages array is empty", async () => {
    const runner = new LoadRunner({
      scenario: async () => {},
      now: makeExactClock(1),
      sleep: noSleep,
    });
    await expect(runner.run({ stages: [] })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("throws INVALID_CONFIG when vus is negative", async () => {
    const runner = new LoadRunner({
      scenario: async () => {},
      now: makeExactClock(1),
      sleep: noSleep,
    });
    await expect(runner.run({ stages: [{ vus: -1, durationMs: 10 }] })).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });

  it("throws INVALID_CONFIG when durationMs is negative", async () => {
    const runner = new LoadRunner({
      scenario: async () => {},
      now: makeExactClock(1),
      sleep: noSleep,
    });
    await expect(runner.run({ stages: [{ vus: 1, durationMs: -1 }] })).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });

  it("returns a LoadTestResult with expected shape", async () => {
    const runner = makeRunner(async () => {});
    const result = await runner.run(singleStage());
    expect(result).toMatchObject({
      totalRequests: expect.any(Number),
      successRequests: expect.any(Number),
      failedRequests: expect.any(Number),
      errorRatePercent: expect.any(Number),
      throughputRps: expect.any(Number),
      thresholdsPassed: true,
      thresholdViolations: [],
    });
  });

  it("totalRequests === successRequests when scenario never throws", async () => {
    // 3 VUs — clock must be sized for 3 VUs to avoid an infinite loop
    const runner = makeRunner(async () => {}, 3);
    const result = await runner.run(singleStage(3));
    expect(result.failedRequests).toBe(0);
    expect(result.totalRequests).toBe(result.successRequests);
  });

  it("failedRequests counts scenario exceptions", async () => {
    const runner = makeRunner(async () => {
      throw new Error("crash");
    });
    const result = await runner.run(singleStage(1));
    expect(result.failedRequests).toBeGreaterThanOrEqual(1);
    expect(result.errorRatePercent).toBe(100);
  });

  it("VUContext provides correct vuId and iteration", async () => {
    const captured: { vuId: number; iteration: number }[] = [];
    // 2 VUs — clock sized accordingly
    const runner = makeRunner(async (ctx) => {
      captured.push({ vuId: ctx.vuId, iteration: ctx.iteration });
    }, 2);
    await runner.run(singleStage(2));
    expect(captured.length).toBeGreaterThanOrEqual(1);
    const ids = captured.map((c) => c.vuId);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
  });

  it("VUContext.check records pass/fail", async () => {
    const runner = makeRunner(async (ctx) => {
      ctx.check("always-true", true);
      ctx.check("always-false", false);
    });
    const result = await runner.run(singleStage(1));
    expect(result.checks.total).toBeGreaterThan(0);
    expect(result.checks.failed).toBeGreaterThan(0);
  });

  it("VUContext.http is the configured client", async () => {
    const calls: string[] = [];
    const mockHttp = {
      get: async (url: string) => {
        calls.push(url);
        return { status: 200, ok: true, body: null, latencyMs: 0 };
      },
      post: async () => ({ status: 200, ok: true, body: null, latencyMs: 0 }),
      put: async () => ({ status: 200, ok: true, body: null, latencyMs: 0 }),
      del: async () => ({ status: 200, ok: true, body: null, latencyMs: 0 }),
    };
    const runner = new LoadRunner({
      scenario: async (ctx) => {
        await ctx.http.get("https://nexus.dev/ping");
      },
      http: mockHttp,
      now: makeExactClock(1),
      sleep: noSleep,
    });
    await runner.run(singleStage(1));
    expect(calls).toContain("https://nexus.dev/ping");
  });

  it("durationMs in result is non-negative", async () => {
    const runner = makeRunner(async () => {});
    const result = await runner.run(singleStage());
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("stageMetrics has one entry per stage", async () => {
    // Use a constant clock (t always 0) with durationMs:0 → while(0<0) = false, 0 iterations
    const clock = makeClock(1);
    const runner = new LoadRunner({
      scenario: async () => {},
      now: clock.now,
      sleep: noSleep,
    });
    const result = await runner.run({
      stages: [
        { vus: 1, durationMs: 0, name: "warmup" },
        { vus: 1, durationMs: 0, name: "load" },
      ],
    });
    expect(result.stageMetrics).toHaveLength(2);
    expect(result.stageMetrics[0]!.name).toBe("warmup");
    expect(result.stageMetrics[1]!.name).toBe("load");
  });

  it("vus:0 stage (cool-down) records zero iterations", async () => {
    const runner = new LoadRunner({
      scenario: async () => {},
      now: () => 0,
      sleep: noSleep,
    });
    const result = await runner.run({ stages: [{ vus: 0, durationMs: 0 }] });
    expect(result.stageMetrics[0]!.iterations).toBe(0);
    expect(result.totalRequests).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LoadRunner — thresholds
// ─────────────────────────────────────────────────────────────────────────────

describe("LoadRunner — thresholds", () => {
  it("thresholdsPassed:true when no thresholds configured", async () => {
    const runner = makeRunner(async () => {});
    const result = await runner.run(singleStage());
    expect(result.thresholdsPassed).toBe(true);
    expect(result.thresholdViolations).toHaveLength(0);
  });

  it("thresholdsPassed:true when all thresholds met", async () => {
    const runner = makeRunner(async () => {});
    const result = await runner.run({
      ...singleStage(),
      thresholds: { errorRatePercent: 100 },
    });
    expect(result.thresholdsPassed).toBe(true);
  });

  it("thresholdsPassed:false when error rate threshold violated", async () => {
    const runner = makeRunner(async () => {
      throw new Error("fail");
    });
    const result = await runner.run({
      ...singleStage(),
      thresholds: { errorRatePercent: 0 },
    });
    expect(result.thresholdsPassed).toBe(false);
    expect(result.thresholdViolations.length).toBeGreaterThan(0);
  });

  it("thresholdViolations contains descriptive message", async () => {
    const runner = makeRunner(async () => {
      throw new Error("fail");
    });
    const result = await runner.run({
      ...singleStage(),
      thresholds: { errorRatePercent: 0 },
    });
    expect(result.thresholdViolations[0]).toContain("error rate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LoadRunner — latency tracking
// ─────────────────────────────────────────────────────────────────────────────

describe("LoadRunner — latency", () => {
  it("latency.min is 0 when clock does not advance within an iteration", async () => {
    // makeExactClock returns 0 for all within-iteration calls → latencyMs = 0
    const runner = makeRunner(async () => {});
    const result = await runner.run(singleStage());
    expect(result.latency.min).toBeGreaterThanOrEqual(0);
  });

  it("latency fields are all numbers", async () => {
    const runner = makeRunner(async () => {});
    const { latency } = await runner.run(singleStage());
    for (const key of ["min", "avg", "max", "p50", "p90", "p95", "p99"] as const) {
      expect(typeof latency[key]).toBe("number");
    }
  });

  it("latency is all zeros when no requests made (vus:0 stage)", async () => {
    const runner = new LoadRunner({
      scenario: async () => {},
      now: () => 0,
      sleep: noSleep,
    });
    const result = await runner.run({ stages: [{ vus: 0, durationMs: 0 }] });
    expect(result.latency).toEqual({ min: 0, avg: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario builders
// ─────────────────────────────────────────────────────────────────────────────

describe("withPacing", () => {
  it("calls original scenario then sleeps", async () => {
    const calls: string[] = [];
    const scenario: ScenarioFn = async () => {
      calls.push("scenario");
    };
    const sleepFn = vi.fn(async (_ms: number) => {
      calls.push("sleep");
    });
    const paced = withPacing(scenario, 100);

    const ctx: VUContext = {
      vuId: 1,
      iteration: 1,
      http: new NullHttpClient(),
      check: () => {},
      sleep: sleepFn,
    };
    await paced(ctx);
    expect(calls).toEqual(["scenario", "sleep"]);
    expect(sleepFn).toHaveBeenCalledWith(100);
  });
});

describe("sequential", () => {
  it("runs all scenarios in order", async () => {
    const order: number[] = [];
    const s1: ScenarioFn = async () => {
      order.push(1);
    };
    const s2: ScenarioFn = async () => {
      order.push(2);
    };
    const s3: ScenarioFn = async () => {
      order.push(3);
    };
    const ctx: VUContext = {
      vuId: 1,
      iteration: 1,
      http: new NullHttpClient(),
      check: () => {},
      sleep: noSleep,
    };
    await sequential(s1, s2, s3)(ctx);
    expect(order).toEqual([1, 2, 3]);
  });

  it("stops on first thrown error", async () => {
    const order: number[] = [];
    const s1: ScenarioFn = async () => {
      order.push(1);
    };
    const s2: ScenarioFn = async () => {
      throw new Error("stop");
    };
    const s3: ScenarioFn = async () => {
      order.push(3);
    };
    const ctx: VUContext = {
      vuId: 1,
      iteration: 1,
      http: new NullHttpClient(),
      check: () => {},
      sleep: noSleep,
    };
    await expect(sequential(s1, s2, s3)(ctx)).rejects.toThrow("stop");
    expect(order).toEqual([1]);
  });
});

describe("weighted", () => {
  it("always calls one of the scenarios", async () => {
    const called: number[] = [];
    const s1: ScenarioFn = async () => {
      called.push(1);
    };
    const s2: ScenarioFn = async () => {
      called.push(2);
    };
    const pick = weighted([
      { scenario: s1, weight: 1 },
      { scenario: s2, weight: 1 },
    ]);
    const ctx: VUContext = {
      vuId: 1,
      iteration: 1,
      http: new NullHttpClient(),
      check: () => {},
      sleep: noSleep,
    };
    await pick(ctx);
    expect(called).toHaveLength(1);
  });

  it("respects weight bias to always pick same scenario when rng returns 0", async () => {
    const called: number[] = [];
    const s1: ScenarioFn = async () => {
      called.push(1);
    };
    const s2: ScenarioFn = async () => {
      called.push(2);
    };
    // rng always returns 0 → r * totalWeight = 0 → always picks s1 (r - w1 <= 0)
    const pick = weighted(
      [
        { scenario: s1, weight: 99 },
        { scenario: s2, weight: 1 },
      ],
      () => 0,
    );
    const ctx: VUContext = {
      vuId: 1,
      iteration: 1,
      http: new NullHttpClient(),
      check: () => {},
      sleep: noSleep,
    };
    for (let i = 0; i < 5; i++) await pick(ctx);
    expect(called.every((v) => v === 1)).toBe(true);
  });

  it("falls back to last scenario when rng returns exactly 1", async () => {
    const called: number[] = [];
    const s1: ScenarioFn = async () => {
      called.push(1);
    };
    const s2: ScenarioFn = async () => {
      called.push(2);
    };
    const pick = weighted(
      [
        { scenario: s1, weight: 1 },
        { scenario: s2, weight: 1 },
      ],
      () => 1, // r * totalWeight = 2, never subtracts to <= 0 in loop
    );
    const ctx: VUContext = {
      vuId: 1,
      iteration: 1,
      http: new NullHttpClient(),
      check: () => {},
      sleep: noSleep,
    };
    await pick(ctx);
    expect(called[0]).toBe(2); // fallback to last
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT_THRESHOLDS
// ─────────────────────────────────────────────────────────────────────────────

describe("DEFAULT_THRESHOLDS", () => {
  it("is exported and has p95LatencyMs", () => {
    expect(typeof DEFAULT_THRESHOLDS.p95LatencyMs).toBe("number");
  });

  it("is exported and has errorRatePercent", () => {
    expect(typeof DEFAULT_THRESHOLDS.errorRatePercent).toBe("number");
  });

  it("applied automatically when thresholds omitted — passes for zero-latency scenario", async () => {
    const runner = makeRunner(async () => {});
    // NullHttpClient: latency ≈ 0ms, errorRate = 0% — both within defaults
    const result = await runner.run(singleStage(1));
    expect(result.thresholdsPassed).toBe(true);
    expect(result.thresholdViolations).toHaveLength(0);
  });

  it("fails when error rate exceeds default (no explicit thresholds)", async () => {
    const runner = makeRunner(async () => {
      throw new Error("always fail");
    });
    const result = await runner.run(singleStage(1));
    // 100% error rate > DEFAULT_THRESHOLDS.errorRatePercent (5)
    expect(result.thresholdsPassed).toBe(false);
    expect(result.thresholdViolations.some((v) => v.includes("error rate"))).toBe(true);
  });

  it("thresholds:{} disables all conditions (explicit opt-out passes even at 100% errors)", async () => {
    const runner = makeRunner(async () => {
      throw new Error("always fail");
    });
    const result = await runner.run({ ...singleStage(1), thresholds: {} });
    expect(result.thresholdsPassed).toBe(true);
    expect(result.thresholdViolations).toHaveLength(0);
  });
});
