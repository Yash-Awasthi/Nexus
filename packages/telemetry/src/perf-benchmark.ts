// SPDX-License-Identifier: Apache-2.0
/**
 * PerfBenchmark — lightweight performance measurement harness.
 *
 * Measures wall-clock latency, throughput, and heap delta for arbitrary async
 * operations. Designed for integration into CI pipelines to catch regressions.
 *
 * Usage:
 *   const bench = new PerfBenchmark();
 *   const result = await bench.measure("council.deliberate", async () => {
 *     await engine.deliberate(request);
 *   }, { iterations: 100, warmupIterations: 10 });
 *
 *   console.log(result.p99Ms, result.throughputOpsPerSec);
 *
 * Throughput measurement:
 *   Runs iterations concurrently in batches (configurable concurrency) to
 *   measure realistic throughput, not just serial latency.
 */

import { percentile } from "./slo-tracker.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BenchmarkOptions {
  /** Number of timed iterations (default: 50) */
  iterations?: number;
  /** Number of warmup iterations run before timing (default: 5) */
  warmupIterations?: number;
  /** Concurrent batch size for throughput measurement (default: 1 = serial) */
  concurrency?: number;
  /** Abort after this many ms (default: 30_000) */
  timeoutMs?: number;
}

export interface BenchmarkResult {
  name: string;
  iterations: number;
  concurrency: number;
  /** Total wall-clock duration for all timed iterations in ms */
  totalMs: number;
  /** Ops/sec measured as iterations / (totalMs / 1000) */
  throughputOpsPerSec: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  medianMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  /** Heap delta in bytes: positive = allocated, negative = freed */
  heapDeltaBytes: number;
  /** Per-iteration latencies in ms (sorted) */
  latenciesSortedMs: number[];
}

export interface RegressionCheck {
  /** Name of the metric to check */
  metric: keyof Pick<BenchmarkResult, "p99Ms" | "p95Ms" | "meanMs" | "throughputOpsPerSec">;
  /** Max allowed value (for latency metrics) or min allowed value (for throughput) */
  threshold: number;
  direction: "below" | "above";
}

export interface RegressionReport {
  passed: boolean;
  violations: { check: RegressionCheck; actual: number }[];
}

// ─── PerfBenchmark ────────────────────────────────────────────────────────────

export class PerfBenchmark {
  private readonly results = new Map<string, BenchmarkResult>();

  /**
   * Measure the performance of `fn` and return a BenchmarkResult.
   */
  async measure<T>(
    name: string,
    fn: () => Promise<T>,
    options: BenchmarkOptions = {},
  ): Promise<BenchmarkResult> {
    const { iterations = 50, warmupIterations = 5, concurrency = 1, timeoutMs = 30_000 } = options;

    const deadline = Date.now() + timeoutMs;

    // Warmup — run but don't time
    for (let i = 0; i < warmupIterations; i++) {
      if (Date.now() > deadline) break;
      await fn();
    }

    const heapBefore = process.memoryUsage().heapUsed;
    const latencies: number[] = [];
    const overallStart = performance.now();

    // Timed iterations — batched by concurrency
    let remaining = iterations;
    while (remaining > 0) {
      if (Date.now() > deadline) break;
      const batch = Math.min(remaining, concurrency);
      const batchTimings = await this.runBatch(fn, batch);
      latencies.push(...batchTimings);
      remaining -= batch;
    }

    const totalMs = performance.now() - overallStart;
    const heapAfter = process.memoryUsage().heapUsed;

    latencies.sort((a, b) => a - b);

    const result: BenchmarkResult = {
      name,
      iterations: latencies.length,
      concurrency,
      totalMs,
      throughputOpsPerSec: latencies.length / (totalMs / 1000),
      minMs: latencies[0] ?? 0,
      maxMs: latencies[latencies.length - 1] ?? 0,
      meanMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
      medianMs: percentile(latencies, 0.5),
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      p99Ms: percentile(latencies, 0.99),
      heapDeltaBytes: heapAfter - heapBefore,
      latenciesSortedMs: latencies,
    };

    this.results.set(name, result);
    return result;
  }

  /**
   * Run a batch of `count` concurrent invocations and return their latencies.
   */
  private async runBatch<T>(fn: () => Promise<T>, count: number): Promise<number[]> {
    const tasks = Array.from({ length: count }, async () => {
      const start = performance.now();
      await fn();
      return performance.now() - start;
    });
    return Promise.all(tasks);
  }

  /**
   * Compare a benchmark result against regression thresholds.
   */
  checkRegression(result: BenchmarkResult, checks: RegressionCheck[]): RegressionReport {
    const violations: { check: RegressionCheck; actual: number }[] = [];

    for (const check of checks) {
      const actual = result[check.metric];
      const violated =
        check.direction === "below" ? actual > check.threshold : actual < check.threshold;

      if (violated) {
        violations.push({ check, actual });
      }
    }

    return { passed: violations.length === 0, violations };
  }

  /** Get a previously stored result */
  get(name: string): BenchmarkResult | undefined {
    return this.results.get(name);
  }

  /** Get all stored results */
  all(): BenchmarkResult[] {
    return Array.from(this.results.values());
  }

  /** Format a result as a human-readable summary line */
  static format(result: BenchmarkResult): string {
    return (
      `${result.name}: ` +
      `${result.iterations} iters @ ${result.concurrency}x concurrency | ` +
      `mean=${result.meanMs.toFixed(2)}ms ` +
      `p50=${result.p50Ms.toFixed(2)}ms ` +
      `p95=${result.p95Ms.toFixed(2)}ms ` +
      `p99=${result.p99Ms.toFixed(2)}ms ` +
      `throughput=${result.throughputOpsPerSec.toFixed(1)} ops/s ` +
      `heap_delta=${(result.heapDeltaBytes / 1024).toFixed(1)}KB`
    );
  }

  /**
   * Run a suite of benchmarks and print a formatted table.
   * Returns all results for CI assertion.
   */
  async suite(
    benchmarks: { name: string; fn: () => Promise<unknown>; options?: BenchmarkOptions }[],
  ): Promise<BenchmarkResult[]> {
    const results: BenchmarkResult[] = [];
    for (const b of benchmarks) {
      const result = await this.measure(b.name, b.fn, b.options);
      results.push(result);
      console.log(PerfBenchmark.format(result));
    }
    return results;
  }
}
