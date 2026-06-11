// SPDX-License-Identifier: Apache-2.0
/**
 * SloTracker — Service Level Objective / Service Level Indicator tracking.
 *
 * Tracks three SLIs over a configurable rolling window:
 *   1. Availability   — fraction of successful requests
 *   2. Error rate     — fraction of failed requests
 *   3. Latency P99    — 99th percentile request latency
 *
 * Each SLI has an SLO target. When the SLI breaches the SLO, the tracker
 * emits an error budget burn alert (callbacks, not throws).
 *
 * Error budget:
 *   The 30-day error budget = (1 - target) × total_requests.
 *   Budget burn rate = actual_error_rate / allowed_error_rate.
 *   Burn rate ≥ 1.0 means you are burning budget exactly on target.
 *   Burn rate > 14.4 triggers a critical page (Google SRE heuristic).
 *
 * Usage:
 *   const slo = new SloTracker({ window: 5 * 60 * 1000 });
 *   slo.record({ success: true, latencyMs: 45 });
 *   const report = slo.report();
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SloTargets {
  /** Minimum availability ratio [0, 1] (default: 0.999 = 99.9%) */
  availabilityTarget?: number;
  /** Maximum error rate ratio [0, 1] (default: 0.001 = 0.1%) */
  errorRateTarget?: number;
  /** Maximum P99 latency in ms (default: 1000ms) */
  p99LatencyTargetMs?: number;
}

export interface RequestEvent {
  success: boolean;
  latencyMs: number;
  /** Optional category tag for per-operation breakdown */
  operation?: string;
}

export interface SloReport {
  windowMs: number;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  availability: number;
  errorRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  latencyMaxMs: number;
  /** How fast the error budget is burning (1.0 = exactly on target) */
  budgetBurnRate: number;
  /** Remaining error budget as a fraction of the 30-day budget */
  budgetRemaining: number;
  /** Whether all SLOs are currently met */
  compliant: boolean;
  violations: SloViolation[];
  computedAt: Date;
}

export interface SloViolation {
  sli: "availability" | "error_rate" | "p99_latency";
  target: number;
  actual: number;
  severity: "warning" | "critical";
}

// ─── Rolling window sample ─────────────────────────────────────────────────────

interface Sample {
  ts: number;          // timestamp ms
  success: boolean;
  latencyMs: number;
  operation?: string;
}

// ─── SloTracker ───────────────────────────────────────────────────────────────

export interface SloTrackerConfig {
  /** Rolling window duration in ms (default: 5 minutes) */
  windowMs?: number;
  /** SLO targets */
  targets?: SloTargets;
  /** Called whenever a violation is first detected */
  onViolation?: (violation: SloViolation) => void;
  /** Budget burn rate threshold for critical alert (default: 14.4 per Google SRE) */
  criticalBurnRateThreshold?: number;
}

export class SloTracker {
  private readonly samples: Sample[] = [];
  private readonly windowMs: number;
  private readonly targets: Required<SloTargets>;
  private readonly onViolation?: (v: SloViolation) => void;
  private readonly criticalBurnRateThreshold: number;
  /** Track which SLIs are currently violated to avoid duplicate callbacks */
  private activeViolations = new Set<string>();

  constructor(config: SloTrackerConfig = {}) {
    this.windowMs = config.windowMs ?? 5 * 60 * 1000;
    this.targets = {
      availabilityTarget: config.targets?.availabilityTarget ?? 0.999,
      errorRateTarget: config.targets?.errorRateTarget ?? 0.001,
      p99LatencyTargetMs: config.targets?.p99LatencyTargetMs ?? 1000,
    };
    this.onViolation = config.onViolation;
    this.criticalBurnRateThreshold = config.criticalBurnRateThreshold ?? 14.4;
  }

  /** Record a single request outcome */
  record(event: RequestEvent): void {
    const now = Date.now();
    this.samples.push({ ts: now, ...event });
    // Trim samples outside the window (amortised cleanup)
    if (this.samples.length % 100 === 0) this.trim(now);
  }

  /** Compute the current SLO report over the rolling window */
  report(): SloReport {
    const now = Date.now();
    this.trim(now);

    const total = this.samples.length;
    const successCount = this.samples.filter((s) => s.success).length;
    const errorCount = total - successCount;

    const availability = total === 0 ? 1 : successCount / total;
    const errorRate = total === 0 ? 0 : errorCount / total;

    const latencies = this.samples.map((s) => s.latencyMs).sort((a, b) => a - b);
    const p50 = percentile(latencies, 0.5);
    const p95 = percentile(latencies, 0.95);
    const p99 = percentile(latencies, 0.99);
    const latencyMax = latencies.length ? (latencies[latencies.length - 1] ?? 0) : 0;

    // Error budget burn rate
    const allowedErrorRate = this.targets.errorRateTarget;
    const budgetBurnRate = allowedErrorRate === 0 ? 0 : errorRate / allowedErrorRate;
    // Remaining budget approximation: 1 - (errors_in_window / 30d_budget)
    const windowsIn30d = (30 * 24 * 60 * 60 * 1000) / this.windowMs;
    const total30d = total * windowsIn30d;
    const budget30d = total30d * allowedErrorRate;
    const errors30dEstimate = errorCount * windowsIn30d;
    const budgetRemaining = budget30d === 0 ? 1 : Math.max(0, 1 - errors30dEstimate / budget30d);

    const violations = this.computeViolations(availability, errorRate, p99, budgetBurnRate);
    this.notifyViolations(violations);

    return {
      windowMs: this.windowMs,
      totalRequests: total,
      successCount,
      errorCount,
      availability,
      errorRate,
      latencyP50Ms: p50,
      latencyP95Ms: p95,
      latencyP99Ms: p99,
      latencyMaxMs: latencyMax,
      budgetBurnRate,
      budgetRemaining,
      compliant: violations.length === 0,
      violations,
      computedAt: new Date(now),
    };
  }

  /** Reset all samples (e.g. for tests or after an incident) */
  reset(): void {
    this.samples.length = 0;
    this.activeViolations.clear();
  }

  /** Number of samples currently in the window */
  size(): number {
    this.trim(Date.now());
    return this.samples.length;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private trim(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.samples.length && (this.samples[i]?.ts ?? 0) < cutoff) i++;
    if (i > 0) this.samples.splice(0, i);
  }

  private computeViolations(
    availability: number,
    errorRate: number,
    p99: number,
    burnRate: number,
  ): SloViolation[] {
    const violations: SloViolation[] = [];

    if (availability < this.targets.availabilityTarget) {
      violations.push({
        sli: "availability",
        target: this.targets.availabilityTarget,
        actual: availability,
        severity: availability < this.targets.availabilityTarget * 0.99 ? "critical" : "warning",
      });
    }

    if (errorRate > this.targets.errorRateTarget) {
      violations.push({
        sli: "error_rate",
        target: this.targets.errorRateTarget,
        actual: errorRate,
        severity: burnRate >= this.criticalBurnRateThreshold ? "critical" : "warning",
      });
    }

    if (p99 > this.targets.p99LatencyTargetMs) {
      violations.push({
        sli: "p99_latency",
        target: this.targets.p99LatencyTargetMs,
        actual: p99,
        severity: p99 > this.targets.p99LatencyTargetMs * 2 ? "critical" : "warning",
      });
    }

    return violations;
  }

  private notifyViolations(violations: SloViolation[]): void {
    if (!this.onViolation) return;

    const currentKeys = new Set(violations.map((v) => v.sli));

    for (const v of violations) {
      if (!this.activeViolations.has(v.sli)) {
        this.activeViolations.add(v.sli);
        this.onViolation(v);
      }
    }

    // Clear resolved violations
    for (const key of this.activeViolations) {
      if (!currentKeys.has(key)) this.activeViolations.delete(key);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Compute the p-th percentile of a sorted array (linear interpolation). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}
