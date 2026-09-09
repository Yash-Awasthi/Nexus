// SPDX-License-Identifier: Apache-2.0
/**
 * LLM Drift Detection — monitor model output quality over time and detect degradation.
 *
 * Extracted from Arize Phoenix: tracks evaluation metrics over time, detects
 * statistical drift in model outputs (score distributions, latency, error rates),
 * and triggers alerts when quality degrades beyond configurable thresholds.
 */

export interface EvalResult {
  id: string;
  modelId: string;
  timestamp: number;
  scores: Record<string, number>;
  latencyMs: number;
  tokenCount: number;
  errorRate: number;
  metadata?: Record<string, unknown>;
}

export interface DriftConfig {
  /** Number of recent results to use as baseline */
  baselineWindowSize: number;
  /** Number of recent results to compare against */
  testWindowSize: number;
  /** Significance threshold for KS test (p-value) */
  significanceThreshold: number;
  /** Absolute threshold for metric change detection */
  absoluteThreshold: number;
  /** Percentage threshold for metric change detection */
  percentageThreshold: number;
  /** Minimum number of samples before drift detection activates */
  minSamples: number;
}

export interface DriftAlert {
  metric: string;
  type: "statistical" | "absolute" | "percentage";
  baselineMean: number;
  testMean: number;
  change: number;
  pValue?: number;
  severity: "info" | "warning" | "critical";
  timestamp: number;
}

export interface DriftReport {
  modelId: string;
  alerts: DriftAlert[];
  isDrifting: boolean;
  baselineWindow: number;
  testWindow: number;
  timestamp: number;
}

const DEFAULT_CONFIG: DriftConfig = {
  baselineWindowSize: 100,
  testWindowSize: 50,
  significanceThreshold: 0.05,
  absoluteThreshold: 0.1,
  percentageThreshold: 10,
  minSamples: 20,
};

/**
 * Runs a two-sample Kolmogorov-Smirnov test (simplified).
 * Returns the approximate p-value.
 */
function ksTest(baseline: number[], test: number[]): number {
  const sorted = [...baseline].sort((a, b) => a - b);
  const testSorted = [...test].sort((a, b) => a - b);

  let maxD = 0;
  let i = 0,
    j = 0;

  while (i < sorted.length && j < testSorted.length) {
    const bCDF = (i + 1) / sorted.length;
    const tCDF = (j + 1) / testSorted.length;
    const d = Math.abs(bCDF - tCDF);
    maxD = Math.max(maxD, d);

    if ((sorted[i] ?? 0) <= (testSorted[j] ?? 0)) i++;
    else j++;
  }

  // Approximate p-value using asymptotic formula
  const n = (sorted.length * testSorted.length) / (sorted.length + testSorted.length);
  const lambda = (Math.sqrt(n) + 0.12 + 0.11 / Math.sqrt(n)) * maxD;

  // Use a simple approximation
  const pValue = Math.max(0, Math.min(1, 2 * Math.exp(-2 * lambda * lambda)));
  return pValue;
}

/**
 * LLM Drift Detector — monitors evaluation metrics for degradation.
 */
export class DriftDetector {
  private results: Map<string, EvalResult[]> = new Map();
  private config: DriftConfig;

  constructor(config: Partial<DriftConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Record an evaluation result.
   */
  record(result: EvalResult): void {
    const existing = this.results.get(result.modelId) ?? [];
    existing.push(result);
    this.results.set(result.modelId, existing);
  }

  /**
   * Check for drift on a specific model.
   */
  checkDrift(modelId: string): DriftReport {
    const results = this.results.get(modelId) ?? [];
    const alerts: DriftAlert[] = [];

    if (results.length < this.config.minSamples) {
      return {
        modelId,
        alerts: [],
        isDrifting: false,
        baselineWindow: 0,
        testWindow: 0,
        timestamp: Date.now(),
      };
    }

    const baseline = results.slice(
      -this.config.baselineWindowSize - this.config.testWindowSize,
      -this.config.testWindowSize,
    );
    const test = results.slice(-this.config.testWindowSize);

    // Check each numeric metric
    const metrics = ["latencyMs", "tokenCount", "errorRate"];
    const allMetricKeys = new Set<string>();

    // Also collect custom score keys
    for (const r of [...baseline, ...test]) {
      for (const key of Object.keys(r.scores)) {
        allMetricKeys.add(key);
      }
    }

    for (const metric of [...metrics, ...Array.from(allMetricKeys)]) {
      const baselineValues = baseline
        .map((r) => this.extractMetric(r, metric))
        .filter((v) => v !== null) as number[];
      const testValues = test
        .map((r) => this.extractMetric(r, metric))
        .filter((v) => v !== null) as number[];

      if (baselineValues.length < 5 || testValues.length < 5) continue;

      const baselineMean = baselineValues.reduce((a, b) => a + b, 0) / baselineValues.length;
      const testMean = testValues.reduce((a, b) => a + b, 0) / testValues.length;
      const change = testMean - baselineMean;
      const percentageChange =
        baselineMean !== 0 ? (Math.abs(change) / Math.abs(baselineMean)) * 100 : 0;

      // KS test
      const pValue = ksTest(baselineValues, testValues);
      const isStatisticallySignificant = pValue < this.config.significanceThreshold;

      // Absolute threshold
      const exceedsAbsolute = Math.abs(change) > this.config.absoluteThreshold;

      // Percentage threshold
      const exceedsPercentage = percentageChange > this.config.percentageThreshold;

      if (isStatisticallySignificant || exceedsAbsolute || exceedsPercentage) {
        const severity =
          isStatisticallySignificant && exceedsAbsolute
            ? "critical"
            : isStatisticallySignificant || exceedsPercentage
              ? "warning"
              : "info";

        alerts.push({
          metric,
          type: isStatisticallySignificant
            ? "statistical"
            : exceedsAbsolute
              ? "absolute"
              : "percentage",
          baselineMean,
          testMean,
          change,
          pValue,
          severity,
          timestamp: Date.now(),
        });
      }
    }

    return {
      modelId,
      alerts,
      isDrifting: alerts.some((a) => a.severity === "critical"),
      baselineWindow: baseline.length,
      testWindow: test.length,
      timestamp: Date.now(),
    };
  }

  /**
   * Check all models for drift.
   */
  checkAll(): DriftReport[] {
    return Array.from(this.results.keys()).map((modelId) => this.checkDrift(modelId));
  }

  /**
   * Get metrics summary for a model.
   */
  summary(modelId: string): {
    totalResults: number;
    latestTimestamp: number;
    avgLatency: number;
    avgErrorRate: number;
  } {
    const results = this.results.get(modelId) ?? [];
    if (results.length === 0)
      return { totalResults: 0, latestTimestamp: 0, avgLatency: 0, avgErrorRate: 0 };

    return {
      totalResults: results.length,
      latestTimestamp: results[results.length - 1]!.timestamp,
      avgLatency: results.reduce((s, r) => s + r.latencyMs, 0) / results.length,
      avgErrorRate: results.reduce((s, r) => s + r.errorRate, 0) / results.length,
    };
  }

  private extractMetric(result: EvalResult, metric: string): number | null {
    switch (metric) {
      case "latencyMs":
        return result.latencyMs;
      case "tokenCount":
        return result.tokenCount;
      case "errorRate":
        return result.errorRate;
      default:
        return result.scores[metric] ?? null;
    }
  }
}
