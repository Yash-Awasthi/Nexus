// SPDX-License-Identifier: Apache-2.0
import * as fc from "fast-check";
import { describe, it, expect, vi } from "vitest";

import { SloTracker, percentile } from "../src/slo-tracker.js";

// ─── percentile helper ────────────────────────────────────────────────────────

describe("percentile", () => {
  it("returns 0 for empty array", () => {
    expect(percentile([], 0.99)).toBe(0);
  });

  it("returns the only element for single-element array", () => {
    expect(percentile([42], 0.5)).toBe(42);
  });

  it("returns correct P50 for sorted array", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });

  it("returns correct P99 for large sorted array", () => {
    // Linear interpolation: idx = 0.99 * 99 = 98.01 → 99 + (100-99)*0.01 = 99.01
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(arr, 0.99)).toBeCloseTo(99.01, 1);
  });

  it("interpolates between values", () => {
    const result = percentile([10, 20], 0.5);
    expect(result).toBe(15);
  });
});

// ─── SloTracker — basic reporting ────────────────────────────────────────────

describe("SloTracker — basic reporting", () => {
  it("returns compliant=true and empty violations for zero requests", () => {
    const slo = new SloTracker();
    const report = slo.report();
    expect(report.compliant).toBe(true);
    expect(report.violations).toHaveLength(0);
    expect(report.totalRequests).toBe(0);
  });

  it("tracks success and error counts correctly", () => {
    const slo = new SloTracker();
    slo.record({ success: true, latencyMs: 10 });
    slo.record({ success: true, latencyMs: 20 });
    slo.record({ success: false, latencyMs: 5 });
    const report = slo.report();
    expect(report.totalRequests).toBe(3);
    expect(report.successCount).toBe(2);
    expect(report.errorCount).toBe(1);
  });

  it("computes availability correctly", () => {
    const slo = new SloTracker();
    for (let i = 0; i < 999; i++) slo.record({ success: true, latencyMs: 10 });
    slo.record({ success: false, latencyMs: 10 });
    const report = slo.report();
    expect(report.availability).toBeCloseTo(0.999, 3);
  });

  it("computes error rate as 1 - availability", () => {
    const slo = new SloTracker();
    for (let i = 0; i < 9; i++) slo.record({ success: true, latencyMs: 10 });
    slo.record({ success: false, latencyMs: 10 });
    const report = slo.report();
    expect(report.errorRate).toBeCloseTo(0.1, 3);
    expect(report.availability + report.errorRate).toBeCloseTo(1.0, 10);
  });

  it("computes latency percentiles from recorded values", () => {
    const slo = new SloTracker();
    for (let ms = 1; ms <= 100; ms++) {
      slo.record({ success: true, latencyMs: ms });
    }
    const report = slo.report();
    // P50: idx=49.5 → sorted[49]=50, sorted[50]=51 → 50 + 0.5 = 50.5
    // P99: idx=98.01 → sorted[98]=99, sorted[99]=100 → 99 + 0.01 = 99.01
    expect(report.latencyP50Ms).toBeCloseTo(50.5, 1);
    expect(report.latencyP99Ms).toBeCloseTo(99.01, 1);
  });
});

// ─── SloTracker — SLO violations ─────────────────────────────────────────────

describe("SloTracker — SLO violations", () => {
  it("no violations when all SLOs are met", () => {
    const slo = new SloTracker({
      targets: { availabilityTarget: 0.99, errorRateTarget: 0.01, p99LatencyTargetMs: 500 },
    });
    for (let i = 0; i < 100; i++) slo.record({ success: true, latencyMs: 50 });
    expect(slo.report().compliant).toBe(true);
  });

  it("detects availability violation", () => {
    const slo = new SloTracker({
      targets: { availabilityTarget: 0.999 },
    });
    // 5% error rate → availability = 0.95 < 0.999
    for (let i = 0; i < 95; i++) slo.record({ success: true, latencyMs: 10 });
    for (let i = 0; i < 5; i++) slo.record({ success: false, latencyMs: 10 });
    const report = slo.report();
    expect(report.compliant).toBe(false);
    expect(report.violations.some((v) => v.sli === "availability")).toBe(true);
  });

  it("detects error rate violation", () => {
    const slo = new SloTracker({
      targets: { errorRateTarget: 0.001 },
    });
    for (let i = 0; i < 90; i++) slo.record({ success: true, latencyMs: 10 });
    for (let i = 0; i < 10; i++) slo.record({ success: false, latencyMs: 10 });
    const report = slo.report();
    expect(report.violations.some((v) => v.sli === "error_rate")).toBe(true);
  });

  it("detects P99 latency violation", () => {
    const slo = new SloTracker({
      targets: { availabilityTarget: 0.9, errorRateTarget: 0.5, p99LatencyTargetMs: 100 },
    });
    // With 2 samples, P99 idx = 0.99 * 1 = 0.99 → 10 + (5000-10)*0.99 ≈ 4950ms > 100ms
    slo.record({ success: true, latencyMs: 10 });
    slo.record({ success: true, latencyMs: 5000 });
    const report = slo.report();
    expect(report.violations.some((v) => v.sli === "p99_latency")).toBe(true);
  });

  it("calls onViolation callback exactly once per new violation", () => {
    const spy = vi.fn();
    const slo = new SloTracker({
      // Explicit targets so only error_rate fires; availability stays above its target
      targets: { availabilityTarget: 0.5, errorRateTarget: 0.001, p99LatencyTargetMs: 9999 },
      onViolation: spy,
    });

    // Mix successes and failures: errorRate = 5/15 ≈ 0.33 > 0.001 → error_rate fires
    // availability = 10/15 ≈ 0.67 > 0.5 → no availability violation
    for (let i = 0; i < 10; i++) slo.record({ success: true, latencyMs: 10 });
    for (let i = 0; i < 5; i++) slo.record({ success: false, latencyMs: 10 });
    slo.report();
    expect(spy).toHaveBeenCalledOnce();

    // Second report with same violation — should NOT call callback again
    slo.report();
    expect(spy).toHaveBeenCalledOnce();
  });

  it("violation severity is warning when just over threshold", () => {
    const slo = new SloTracker({
      // Disable other SLIs so only p99_latency can fire
      targets: { availabilityTarget: 0, errorRateTarget: 1, p99LatencyTargetMs: 100 },
    });
    // 2 samples: P99 = 10 + (150-10)*0.99 = 148.6ms — over 100ms but under 200ms → warning
    slo.record({ success: true, latencyMs: 10 });
    slo.record({ success: true, latencyMs: 150 });
    const report = slo.report();
    const v = report.violations.find((v) => v.sli === "p99_latency");
    expect(v?.severity).toBe("warning");
  });

  it("violation severity is critical when 2× over threshold", () => {
    const slo = new SloTracker({
      targets: { availabilityTarget: 0, errorRateTarget: 1, p99LatencyTargetMs: 100 },
    });
    // 2 samples: P99 = 10 + (250-10)*0.99 = 247.6ms — over 200ms → critical
    slo.record({ success: true, latencyMs: 10 });
    slo.record({ success: true, latencyMs: 250 });
    const report = slo.report();
    const v = report.violations.find((v) => v.sli === "p99_latency");
    expect(v?.severity).toBe("critical");
  });
});

// ─── SloTracker — rolling window ─────────────────────────────────────────────

describe("SloTracker — rolling window", () => {
  it("reset() clears all samples", () => {
    const slo = new SloTracker();
    for (let i = 0; i < 10; i++) slo.record({ success: true, latencyMs: 10 });
    slo.reset();
    expect(slo.size()).toBe(0);
    expect(slo.report().totalRequests).toBe(0);
  });

  it("size() returns the number of in-window samples", () => {
    const slo = new SloTracker({ windowMs: 10_000 });
    for (let i = 0; i < 5; i++) slo.record({ success: true, latencyMs: 1 });
    expect(slo.size()).toBe(5);
  });
});

// ─── Property-based ───────────────────────────────────────────────────────────

describe("SloTracker — property-based", () => {
  it("availability + errorRate always equals 1.0 (within floating point)", async () => {
    await fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 200 }), (outcomes) => {
        const slo = new SloTracker();
        for (const ok of outcomes) slo.record({ success: ok, latencyMs: 1 });
        const report = slo.report();
        expect(report.availability + report.errorRate).toBeCloseTo(1.0, 10);
      }),
      { numRuns: 100 },
    );
  });

  it("violations always contain valid SLI names", async () => {
    const validSlis = new Set(["availability", "error_rate", "p99_latency"]);
    await fc.assert(
      fc.property(
        fc.array(fc.record({ success: fc.boolean(), latencyMs: fc.nat({ max: 2000 }) }), {
          minLength: 0,
          maxLength: 100,
        }),
        (events) => {
          const slo = new SloTracker({
            targets: { availabilityTarget: 0.95, errorRateTarget: 0.05, p99LatencyTargetMs: 500 },
          });
          for (const e of events) slo.record(e);
          const report = slo.report();
          for (const v of report.violations) {
            expect(validSlis).toContain(v.sli);
          }
        },
      ),
      { numRuns: 80 },
    );
  });

  it("p50 ≤ p95 ≤ p99 always holds", async () => {
    await fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 5000 }), { minLength: 1, maxLength: 100 }),
        (latencies) => {
          const slo = new SloTracker();
          for (const ms of latencies) slo.record({ success: true, latencyMs: ms });
          const report = slo.report();
          expect(report.latencyP50Ms).toBeLessThanOrEqual(report.latencyP95Ms);
          expect(report.latencyP95Ms).toBeLessThanOrEqual(report.latencyP99Ms);
        },
      ),
      { numRuns: 100 },
    );
  });
});
