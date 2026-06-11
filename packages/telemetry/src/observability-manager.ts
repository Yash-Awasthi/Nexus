import { IMetricsCollector, ITraceRecorder, ITraceSpan } from "./interfaces/observability.interface";

// ─── Histogram for percentile calculations ───────────────────────────

export class Histogram {
  private buckets: Map<number, number> = new Map();
  private count = 0;
  private sum = 0;
  private minVal = Infinity;
  private maxVal = -Infinity;

  constructor(private readonly bucketDefs: number[] = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]) {
    for (const b of bucketDefs) {
      this.buckets.set(b, 0);
    }
  }

  record(value: number): void {
    this.count++;
    this.sum += value;
    if (value < this.minVal) this.minVal = value;
    if (value > this.maxVal) this.maxVal = value;
    for (const [boundary, _] of this.buckets) {
      if (value <= boundary) {
        this.buckets.set(boundary, this.buckets.get(boundary)! + 1);
        break;
      }
    }
  }

  getSnapshot(): {
    count: number;
    sum: number;
    min: number;
    max: number;
    avg: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    buckets: Record<string, number>;
  } {
    const sorted = Array.from(this.buckets.entries()).sort((a, b) => a[0] - b[0]);
    const bucketObj: Record<string, number> = {};
    for (const [boundary, count] of sorted) {
      bucketObj[`le_${boundary}`] = count;
    }

    return {
      count: this.count,
      sum: this.sum,
      min: this.count > 0 ? this.minVal : 0,
      max: this.count > 0 ? this.maxVal : 0,
      avg: this.count > 0 ? this.sum / this.count : 0,
      p50: this.percentile(50),
      p90: this.percentile(90),
      p95: this.percentile(95),
      p99: this.percentile(99),
      buckets: bucketObj
    };
  }

  private percentile(p: number): number {
    if (this.count === 0) return 0;
    const target = Math.ceil((p / 100) * this.count);
    let cumulative = 0;
    for (const [boundary, count] of Array.from(this.buckets.entries()).sort((a, b) => a[0] - b[0])) {
      cumulative += count;
      if (cumulative >= target) return boundary;
    }
    return this.maxVal;
  }

  reset(): void {
    this.count = 0;
    this.sum = 0;
    this.minVal = Infinity;
    this.maxVal = -Infinity;
    for (const [boundary] of this.buckets) {
      this.buckets.set(boundary, 0);
    }
  }
}

// ─── Enhanced Metrics Collector ──────────────────────────────────────

export class MetricsCollector implements IMetricsCollector {
  private counters: Record<string, number> = {};
  private gauges: Record<string, number> = {};
  private histograms: Record<string, Histogram> = {};
  private timestamps: Record<string, number> = {};

  increment(metricName: string, amount: number = 1, _tags?: Record<string, string>): void {
    if (!this.counters[metricName]) {
      this.counters[metricName] = 0;
    }
    this.counters[metricName] += amount;
  }

  recordGauge(metricName: string, value: number, _tags?: Record<string, string>): void {
    this.gauges[metricName] = value;
    this.timestamps[metricName] = Date.now();
  }

  recordTiming(metricName: string, durationMs: number, _tags?: Record<string, string>): void {
    if (!this.histograms[metricName]) {
      this.histograms[metricName] = new Histogram();
    }
    this.histograms[metricName].record(durationMs);
  }

  getMetrics(): Record<string, any> {
    const result: Record<string, any> = {};

    // Counters
    for (const [name, value] of Object.entries(this.counters)) {
      result[name] = value;
    }

    // Gauges
    for (const [name, value] of Object.entries(this.gauges)) {
      result[name] = value;
    }

    // Histogram snapshots
    for (const [name, hist] of Object.entries(this.histograms)) {
      if (hist.getSnapshot().count > 0) {
        result[`${name}_histogram`] = hist.getSnapshot();
      }
    }

    return result;
  }

  getHistogram(name: string): Histogram | undefined {
    return this.histograms[name];
  }

  getCounter(name: string): number {
    return this.counters[name] || 0;
  }

  getGauge(name: string): number | undefined {
    return this.gauges[name];
  }

  reset(): void {
    this.counters = {};
    this.gauges = {};
    this.histograms = {};
    this.timestamps = {};
  }
}

// ─── Enhanced Trace Recorder ─────────────────────────────────────────

export class TraceRecorder implements ITraceRecorder {
  private spans: ITraceSpan[] = [];

  startSpan(name: string, parentId?: string, metadata?: Record<string, any>): ITraceSpan {
    const span: ITraceSpan = {
      spanId: `${name}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      parentId,
      name,
      startTime: new Date(),
      metadata: metadata ? { ...metadata } : {}
    };
    this.spans.push(span);
    return span;
  }

  endSpan(spanId: string, metadata?: Record<string, any>): void {
    const span = this.spans.find((s) => s.spanId === spanId);
    if (span) {
      span.endTime = new Date();
      if (metadata) {
        span.metadata = { ...span.metadata, ...metadata };
      }
    }
  }

  getSpans(): ITraceSpan[] {
    return [...this.spans];
  }

  getSpanTree(): any[] {
    const buildTree = (parentId?: string): any[] => {
      return this.spans
        .filter((s) => s.parentId === parentId)
        .map((s) => ({
          ...s,
          durationMs: s.endTime ? s.endTime.getTime() - s.startTime.getTime() : undefined,
          children: buildTree(s.spanId)
        }));
    };
    return buildTree();
  }

  getTraceSummary(): {
    totalSpans: number;
    totalDurationMs: number;
    spanNames: string[];
    errors: number;
  } {
    let totalDuration = 0;
    let errors = 0;
    const names = new Set<string>();
    for (const span of this.spans) {
      names.add(span.name);
      if (span.endTime) {
        totalDuration += span.endTime.getTime() - span.startTime.getTime();
      }
      if (span.metadata?.status === "failed" || span.metadata?.status === "error") {
        errors++;
      }
    }
    return {
      totalSpans: this.spans.length,
      totalDurationMs: totalDuration,
      spanNames: Array.from(names),
      errors
    };
  }

  clear(): void {
    this.spans = [];
  }
}

// ─── Telemetry Exporter ──────────────────────────────────────────────

export class TelemetryExporter {
  private exportQueue: Array<{ timestamp: Date; type: string; payload: unknown }> = [];

  constructor(private exportIntervalMs: number = 60000) {
    if (exportIntervalMs > 0) {
      const timer = setInterval(() => this.flush(), exportIntervalMs);
      timer.unref();
    }
  }

  record(type: string, payload: unknown): void {
    this.exportQueue.push({ timestamp: new Date(), type, payload });
  }

  flush(): Array<{ timestamp: Date; type: string; payload: unknown }> {
    const batch = this.exportQueue;
    this.exportQueue = [];
    return batch;
  }

  getQueueLength(): number {
    return this.exportQueue.length;
  }
}

// ─── Health History ──────────────────────────────────────────────────
// Tracks a rolling window of health check results with timestamps

export interface HealthRecord {
  timestamp: Date;
  status: "healthy" | "degraded" | "unhealthy";
  servicesCount: number;
  latencyMs?: number;
  detail?: string;
}

export class HealthHistory {
  private records: HealthRecord[] = [];
  private readonly maxRecords: number;

  constructor(maxRecords = 100) {
    this.maxRecords = maxRecords;
  }

  record(entry: Omit<HealthRecord, "timestamp">): void {
    this.records.push({ ...entry, timestamp: new Date() });
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }

  getHistory(): HealthRecord[] {
    return [...this.records];
  }

  getLatest(): HealthRecord | undefined {
    return this.records.length > 0 ? this.records[this.records.length - 1] : undefined;
  }

  getStats(): {
    totalRecords: number;
    healthyCount: number;
    degradedCount: number;
    unhealthyCount: number;
    uptimePercent: number;
  } {
    const total = this.records.length;
    if (total === 0) {
      return { totalRecords: 0, healthyCount: 0, degradedCount: 0, unhealthyCount: 0, uptimePercent: 100 };
    }
    const healthyCount = this.records.filter((r) => r.status === "healthy").length;
    const degradedCount = this.records.filter((r) => r.status === "degraded").length;
    const unhealthyCount = this.records.filter((r) => r.status === "unhealthy").length;
    return {
      totalRecords: total,
      healthyCount,
      degradedCount,
      unhealthyCount,
      uptimePercent: Math.round((healthyCount / total) * 100)
    };
  }

  clear(): void {
    this.records = [];
  }
}

// ─── Diagnostic Enricher ─────────────────────────────────────────────

export class DiagnosticEnricher {
  private healthHistory: HealthHistory;

  constructor(
    private metrics: MetricsCollector,
    private tracer: TraceRecorder,
    healthHistory?: HealthHistory
  ) {
    this.healthHistory = healthHistory ?? new HealthHistory();
  }

  getHealthHistory(): HealthHistory {
    return this.healthHistory;
  }

  recordHealthCheck(entry: Omit<HealthRecord, "timestamp">): void {
    this.healthHistory.record(entry);
  }

  getRichDiagnostics(): {
    metrics: Record<string, any>;
    traces: ReturnType<TraceRecorder["getTraceSummary"]>;
    spanTree: any[];
    healthHistory: {
      stats: ReturnType<HealthHistory["getStats"]>;
      latest: HealthRecord | undefined;
      recent: HealthRecord[];
    };
    system: {
      memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
      uptimeSeconds: number;
      nodeVersion: string;
      platform: string;
    };
  } {
    return {
      metrics: this.metrics.getMetrics(),
      traces: this.tracer.getTraceSummary(),
      spanTree: this.tracer.getSpanTree(),
      healthHistory: {
        stats: this.healthHistory.getStats(),
        latest: this.healthHistory.getLatest(),
        recent: this.healthHistory.getHistory().slice(-20)
      },
      system: {
        memoryUsage: {
          heapUsed: process.memoryUsage().heapUsed,
          heapTotal: process.memoryUsage().heapTotal,
          rss: process.memoryUsage().rss
        },
        uptimeSeconds: process.uptime(),
        nodeVersion: process.version,
        platform: process.platform
      }
    };
  }
}
