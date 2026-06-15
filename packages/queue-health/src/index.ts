// SPDX-License-Identifier: Apache-2.0
/**
 * queue-health — BullMQ named job-lane health monitor.
 *
 * Pure logic layer (no BullMQ runtime imported) — BullMQ Queue objects are
 * passed in via an injectable interface so the module is fully testable.
 *
 * Provides:
 *   • QueueMetrics        — per-queue counts snapshot
 *   • QueueLane           — injectable queue adapter interface
 *   • InMemoryQueueLane   — in-memory lane for tests
 *   • LaneRegistry        — named lane registry
 *   • HealthMonitor       — poll all lanes and produce health snapshots
 *   • HealthAggregator    — aggregate across lanes + detect anomalies
 *   • AlertPolicy         — threshold-based alert rules
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QueueMetrics {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  stalled: number;
  paused: boolean;
  unavailable: boolean;
  snapshotAt: string;
}

/** Lane status type alias. */
export type LaneStatus = "healthy" | "degraded" | "unavailable" | "unknown";

/** Lane health interface definition. */
export interface LaneHealth {
  name: string;
  status: LaneStatus;
  metrics: QueueMetrics;
  alerts: string[];
  latencyMs: number;
}

// ── QueueLane interface ───────────────────────────────────────────────────────

export interface QueueLane {
  name: string;
  getMetrics(): Promise<Omit<QueueMetrics, "name" | "snapshotAt">>;
}

// ── InMemoryQueueLane ─────────────────────────────────────────────────────────

export interface InMemoryLaneState {
  waiting?: number;
  active?: number;
  completed?: number;
  failed?: number;
  delayed?: number;
  stalled?: number;
  paused?: boolean;
  unavailable?: boolean;
  throwOnGet?: boolean;
}

/** In memory queue lane. */
export class InMemoryQueueLane implements QueueLane {
  private state: InMemoryLaneState;

  constructor(public readonly name: string, state: InMemoryLaneState = {}) {
    this.state = { ...state };
  }

  setState(state: Partial<InMemoryLaneState>): void {
    this.state = { ...this.state, ...state };
  }

  async getMetrics(): Promise<Omit<QueueMetrics, "name" | "snapshotAt">> {
    if (this.state.throwOnGet) throw new Error("Queue unavailable");
    return {
      waiting: this.state.waiting ?? 0,
      active: this.state.active ?? 0,
      completed: this.state.completed ?? 0,
      failed: this.state.failed ?? 0,
      delayed: this.state.delayed ?? 0,
      stalled: this.state.stalled ?? 0,
      paused: this.state.paused ?? false,
      unavailable: this.state.unavailable ?? false,
    };
  }
}

// ── LaneRegistry ─────────────────────────────────────────────────────────────

export class LaneRegistry {
  private lanes = new Map<string, QueueLane>();

  register(lane: QueueLane): this {
    this.lanes.set(lane.name, lane);
    return this;
  }

  unregister(name: string): boolean {
    return this.lanes.delete(name);
  }

  get(name: string): QueueLane | undefined {
    return this.lanes.get(name);
  }

  list(): QueueLane[] {
    return [...this.lanes.values()];
  }

  names(): string[] {
    return [...this.lanes.keys()];
  }

  count(): number { return this.lanes.size; }
}

// ── AlertPolicy ───────────────────────────────────────────────────────────────

export interface AlertThresholds {
  maxWaiting?: number;
  maxFailed?: number;
  maxStalled?: number;
  maxActive?: number;
  maxDelayed?: number;
}

/** Default thresholds. */
export const DEFAULT_THRESHOLDS: AlertThresholds = {
  maxWaiting: 1000,
  maxFailed: 50,
  maxStalled: 10,
  maxActive: 500,
  maxDelayed: 200,
};

/** Alert policy. */
export class AlertPolicy {
  private thresholds: AlertThresholds;

  constructor(thresholds: AlertThresholds = DEFAULT_THRESHOLDS) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  evaluate(metrics: QueueMetrics): string[] {
    const alerts: string[] = [];

    if (metrics.unavailable) {
      alerts.push(`Queue '${metrics.name}' is unavailable`);
      return alerts;
    }

    if (metrics.paused) alerts.push(`Queue '${metrics.name}' is paused`);

    if (this.thresholds.maxWaiting !== undefined && metrics.waiting > this.thresholds.maxWaiting) {
      alerts.push(`Queue '${metrics.name}' has ${metrics.waiting} waiting jobs (threshold: ${this.thresholds.maxWaiting})`);
    }
    if (this.thresholds.maxFailed !== undefined && metrics.failed > this.thresholds.maxFailed) {
      alerts.push(`Queue '${metrics.name}' has ${metrics.failed} failed jobs (threshold: ${this.thresholds.maxFailed})`);
    }
    if (this.thresholds.maxStalled !== undefined && metrics.stalled > this.thresholds.maxStalled) {
      alerts.push(`Queue '${metrics.name}' has ${metrics.stalled} stalled jobs (threshold: ${this.thresholds.maxStalled})`);
    }
    if (this.thresholds.maxActive !== undefined && metrics.active > this.thresholds.maxActive) {
      alerts.push(`Queue '${metrics.name}' has ${metrics.active} active jobs (threshold: ${this.thresholds.maxActive})`);
    }
    if (this.thresholds.maxDelayed !== undefined && metrics.delayed > this.thresholds.maxDelayed) {
      alerts.push(`Queue '${metrics.name}' has ${metrics.delayed} delayed jobs (threshold: ${this.thresholds.maxDelayed})`);
    }

    return alerts;
  }

  deriveStatus(metrics: QueueMetrics, alerts: string[]): LaneStatus {
    if (metrics.unavailable) return "unavailable";
    if (alerts.length > 0) return "degraded";
    return "healthy";
  }
}

// ── HealthMonitor ─────────────────────────────────────────────────────────────

export interface MonitorOptions {
  policy?: AlertPolicy;
  timeoutMs?: number;
}

/** Health monitor. */
export class HealthMonitor {
  private registry: LaneRegistry;
  private policy: AlertPolicy;
  private timeoutMs: number;

  constructor(registry: LaneRegistry, opts: MonitorOptions = {}) {
    this.registry = registry;
    this.policy = opts.policy ?? new AlertPolicy();
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  async checkLane(lane: QueueLane): Promise<LaneHealth> {
    const t0 = Date.now();
    let metrics: QueueMetrics;

    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), this.timeoutMs)
      );
      const raw = await Promise.race([lane.getMetrics(), timeoutPromise]);
      metrics = { name: lane.name, snapshotAt: new Date().toISOString(), ...raw };
    } catch {
      metrics = {
        name: lane.name,
        waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, stalled: 0,
        paused: false, unavailable: true,
        snapshotAt: new Date().toISOString(),
      };
    }

    const alerts = this.policy.evaluate(metrics);
    const status = this.policy.deriveStatus(metrics, alerts);
    return { name: lane.name, status, metrics, alerts, latencyMs: Date.now() - t0 };
  }

  async checkAll(): Promise<LaneHealth[]> {
    const lanes = this.registry.list();
    return Promise.all(lanes.map((l) => this.checkLane(l)));
  }

  async checkByName(name: string): Promise<LaneHealth | undefined> {
    const lane = this.registry.get(name);
    if (!lane) return undefined;
    return this.checkLane(lane);
  }
}

// ── HealthAggregator ──────────────────────────────────────────────────────────

export interface AggregatedHealth {
  timestamp: string;
  laneCount: number;
  healthyCount: number;
  degradedCount: number;
  unavailableCount: number;
  overallStatus: LaneStatus;
  totalWaiting: number;
  totalFailed: number;
  totalActive: number;
  totalCompleted: number;
  allAlerts: string[];
  lanes: LaneHealth[];
}

/** Health aggregator. */
export class HealthAggregator {
  aggregate(healths: LaneHealth[]): AggregatedHealth {
    const healthyCount = healths.filter((h) => h.status === "healthy").length;
    const degradedCount = healths.filter((h) => h.status === "degraded").length;
    const unavailableCount = healths.filter((h) => h.status === "unavailable").length;

    let overallStatus: LaneStatus = "healthy";
    if (unavailableCount > 0) overallStatus = "unavailable";
    else if (degradedCount > 0) overallStatus = "degraded";

    const totalWaiting = healths.reduce((s, h) => s + h.metrics.waiting, 0);
    const totalFailed = healths.reduce((s, h) => s + h.metrics.failed, 0);
    const totalActive = healths.reduce((s, h) => s + h.metrics.active, 0);
    const totalCompleted = healths.reduce((s, h) => s + h.metrics.completed, 0);
    const allAlerts = healths.flatMap((h) => h.alerts);

    return {
      timestamp: new Date().toISOString(),
      laneCount: healths.length,
      healthyCount,
      degradedCount,
      unavailableCount,
      overallStatus,
      totalWaiting,
      totalFailed,
      totalActive,
      totalCompleted,
      allAlerts,
      lanes: healths,
    };
  }

  /** Identify lanes with the highest failure rate relative to total jobs. */
  hotspots(health: AggregatedHealth, topK = 3): LaneHealth[] {
    return [...health.lanes]
      .filter((h) => h.metrics.failed > 0)
      .sort((a, b) => b.metrics.failed - a.metrics.failed)
      .slice(0, topK);
  }
}
