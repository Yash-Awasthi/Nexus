// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";

import { PerfBenchmark, type BenchmarkResult } from "../src/perf-benchmark.js";

/** Minimal async no-op for fast benchmarking in tests. */
const noop = async () => {};

describe("PerfBenchmark", () => {
  describe("measure()", () => {
    it("returns a BenchmarkResult with the given name", async () => {
      const bench = new PerfBenchmark();
      const result = await bench.measure("test-op", noop, {
        iterations: 5,
        warmupIterations: 1,
      });
      expect(result.name).toBe("test-op");
    });

    it("runs the expected number of iterations", async () => {
      const bench = new PerfBenchmark();
      let count = 0;
      await bench.measure(
        "counter",
        async () => {
          count++;
        },
        { iterations: 10, warmupIterations: 2 },
      );
      // 10 timed + 2 warmup = 12 total calls
      expect(count).toBe(12);
    });

    it("result.iterations matches the requested count", async () => {
      const bench = new PerfBenchmark();
      const result = await bench.measure("n-iters", noop, {
        iterations: 8,
        warmupIterations: 0,
      });
      expect(result.iterations).toBe(8);
    });

    it("latenciesSortedMs is sorted ascending", async () => {
      const bench = new PerfBenchmark();
      const result = await bench.measure("sorted", noop, {
        iterations: 10,
        warmupIterations: 0,
      });
      const lat = result.latenciesSortedMs;
      for (let i = 1; i < lat.length; i++) {
        expect(lat[i]).toBeGreaterThanOrEqual(lat[i - 1]!);
      }
    });

    it("minMs <= meanMs <= maxMs", async () => {
      const bench = new PerfBenchmark();
      const result = await bench.measure("order", noop, {
        iterations: 20,
        warmupIterations: 0,
      });
      expect(result.minMs).toBeLessThanOrEqual(result.meanMs);
      expect(result.meanMs).toBeLessThanOrEqual(result.maxMs);
    });

    it("p50 <= p95 <= p99", async () => {
      const bench = new PerfBenchmark();
      const result = await bench.measure("percentiles", noop, {
        iterations: 50,
        warmupIterations: 5,
      });
      expect(result.p50Ms).toBeLessThanOrEqual(result.p95Ms);
      expect(result.p95Ms).toBeLessThanOrEqual(result.p99Ms);
    });

    it("throughputOpsPerSec is positive", async () => {
      const bench = new PerfBenchmark();
      const result = await bench.measure("throughput", noop, {
        iterations: 10,
        warmupIterations: 0,
      });
      expect(result.throughputOpsPerSec).toBeGreaterThan(0);
    });

    it("stores the result for later retrieval with get()", async () => {
      const bench = new PerfBenchmark();
      await bench.measure("stored", noop, { iterations: 3, warmupIterations: 0 });
      expect(bench.get("stored")).toBeDefined();
      expect(bench.get("stored")?.name).toBe("stored");
    });

    it("all() returns all accumulated results", async () => {
      const bench = new PerfBenchmark();
      await bench.measure("op-a", noop, { iterations: 2, warmupIterations: 0 });
      await bench.measure("op-b", noop, { iterations: 2, warmupIterations: 0 });
      expect(bench.all()).toHaveLength(2);
    });
  });

  describe("checkRegression()", () => {
    function makeResult(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
      return {
        name: "test",
        iterations: 50,
        concurrency: 1,
        totalMs: 1000,
        throughputOpsPerSec: 50,
        minMs: 5,
        maxMs: 40,
        meanMs: 20,
        medianMs: 18,
        p50Ms: 18,
        p95Ms: 35,
        p99Ms: 39,
        heapDeltaBytes: 0,
        latenciesSortedMs: [],
        ...overrides,
      };
    }

    it("passes when all thresholds are met", () => {
      const result = makeResult({ p99Ms: 50, throughputOpsPerSec: 100 });
      const report = new PerfBenchmark().checkRegression(result, [
        { metric: "p99Ms", threshold: 100, direction: "below" },
        { metric: "throughputOpsPerSec", threshold: 50, direction: "above" },
      ]);
      expect(report.passed).toBe(true);
      expect(report.violations).toHaveLength(0);
    });

    it("fails when p99 exceeds the threshold", () => {
      const result = makeResult({ p99Ms: 150 });
      const report = new PerfBenchmark().checkRegression(result, [
        { metric: "p99Ms", threshold: 100, direction: "below" },
      ]);
      expect(report.passed).toBe(false);
      expect(report.violations).toHaveLength(1);
      expect(report.violations[0]?.actual).toBe(150);
    });

    it("fails when throughput is below the minimum", () => {
      const result = makeResult({ throughputOpsPerSec: 10 });
      const report = new PerfBenchmark().checkRegression(result, [
        { metric: "throughputOpsPerSec", threshold: 50, direction: "above" },
      ]);
      expect(report.passed).toBe(false);
      expect(report.violations[0]?.actual).toBe(10);
    });

    it("reports multiple violations", () => {
      const result = makeResult({ p99Ms: 200, meanMs: 100 });
      const report = new PerfBenchmark().checkRegression(result, [
        { metric: "p99Ms", threshold: 100, direction: "below" },
        { metric: "meanMs", threshold: 50, direction: "below" },
      ]);
      expect(report.passed).toBe(false);
      expect(report.violations).toHaveLength(2);
    });
  });

  describe("format()", () => {
    it("returns a non-empty string summary", async () => {
      const bench = new PerfBenchmark();
      const result = await bench.measure("fmt-test", noop, {
        iterations: 5,
        warmupIterations: 0,
      });
      const str = PerfBenchmark.format(result);
      expect(typeof str).toBe("string");
      expect(str).toContain("fmt-test");
      expect(str).toContain("ops/s");
    });
  });

  describe("suite()", () => {
    it("runs all benchmarks and returns results", async () => {
      const bench = new PerfBenchmark();
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const results = await bench.suite([
        { name: "suite-a", fn: noop, options: { iterations: 3, warmupIterations: 0 } },
        { name: "suite-b", fn: noop, options: { iterations: 3, warmupIterations: 0 } },
      ]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.name)).toEqual(["suite-a", "suite-b"]);
      consoleSpy.mockRestore();
    });
  });
});
