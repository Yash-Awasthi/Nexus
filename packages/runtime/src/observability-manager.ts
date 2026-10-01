// SPDX-License-Identifier: Apache-2.0
/**
 * Observability manager — MetricsCollector, TraceRecorder, DiagnosticEnricher.
 *
 * Concrete implementations of the IMetricsCollector, ITraceRecorder interfaces
 * defined in interfaces/observability.interface.ts.
 */

import type {
  IMetricsCollector,
  ITraceRecorder,
  ITraceSpan,
} from "./interfaces/observability.interface.js";

// ── MetricsCollector ─────────────────────────────────────────────────────────

interface MetricEntry {
  value: number;
  tags: Record<string, string>;
}

export class MetricsCollector implements IMetricsCollector {
  private counters = new Map<string, MetricEntry>();
  private gauges = new Map<string, MetricEntry>();
  private timings = new Map<string, MetricEntry[]>();

  increment(metricName: string, amount = 1, tags: Record<string, string> = {}): void {
    const existing = this.counters.get(metricName);
    this.counters.set(metricName, { value: (existing?.value ?? 0) + amount, tags });
  }

  recordGauge(metricName: string, value: number, tags: Record<string, string> = {}): void {
    this.gauges.set(metricName, { value, tags });
  }

  recordTiming(metricName: string, durationMs: number, tags: Record<string, string> = {}): void {
    const existing = this.timings.get(metricName) ?? [];
    existing.push({ value: durationMs, tags });
    this.timings.set(metricName, existing);
  }

  getMetrics(): Record<string, unknown> {
    const counters: Record<string, unknown> = {};
    for (const [k, v] of this.counters) counters[k] = v;
    const gauges: Record<string, unknown> = {};
    for (const [k, v] of this.gauges) gauges[k] = v;
    const timings: Record<string, unknown> = {};
    for (const [k, v] of this.timings) timings[k] = v;
    return { counters, gauges, timings };
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.timings.clear();
  }
}

// ── TraceRecorder ─────────────────────────────────────────────────────────────

export class TraceRecorder implements ITraceRecorder {
  private spans = new Map<string, ITraceSpan>();
  private counter = 0;

  startSpan(name: string, parentId?: string, metadata?: Record<string, unknown>): ITraceSpan {
    const spanId = `span-${++this.counter}-${Date.now()}`;
    const span: ITraceSpan = { spanId, parentId, name, startTime: new Date(), metadata };
    this.spans.set(spanId, span);
    return span;
  }

  endSpan(spanId: string, metadata?: Record<string, unknown>): void {
    const span = this.spans.get(spanId);
    if (span) {
      span.endTime = new Date();
      if (metadata) span.metadata = { ...span.metadata, ...metadata };
    }
  }

  getSpans(): ITraceSpan[] {
    return Array.from(this.spans.values());
  }

  clear(): void {
    this.spans.clear();
    this.counter = 0;
  }
}

// ── DiagnosticEnricher ────────────────────────────────────────────────────────

export class DiagnosticEnricher {
  constructor(
    private readonly metrics: IMetricsCollector,
    private readonly tracer: ITraceRecorder,
  ) {}

  enrichDiagnostic(label: string, data: Record<string, unknown>): Record<string, unknown> {
    this.metrics.increment(`diagnostic.${label}`);
    return {
      label,
      data,
      metrics: this.metrics.getMetrics(),
      spans: this.tracer.getSpans().length,
      enrichedAt: new Date().toISOString(),
    };
  }

  getSnapshot(): Record<string, unknown> {
    return {
      metrics: this.metrics.getMetrics(),
      traces: this.tracer.getSpans(),
    };
  }

  getRichDiagnostics(): Record<string, unknown> {
    return {
      metrics: this.metrics.getMetrics(),
      spans: this.tracer.getSpans(),
      snapshot: this.getSnapshot(),
      generatedAt: new Date().toISOString(),
    };
  }

  getHealthHistory(): Record<string, unknown>[] {
    return this.tracer
      .getSpans()
      .filter((s) => s.name.startsWith("health."))
      .map((s) => ({
        spanId: s.spanId,
        name: s.name,
        startTime: s.startTime.toISOString(),
        endTime: s.endTime?.toISOString(),
        metadata: s.metadata,
      }));
  }
}
