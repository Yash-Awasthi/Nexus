// SPDX-License-Identifier: Apache-2.0
export interface IMetricsCollector {
  increment(metricName: string, amount?: number, tags?: Record<string, string>): void;
  recordGauge(metricName: string, value: number, tags?: Record<string, string>): void;
  recordTiming(metricName: string, durationMs: number, tags?: Record<string, string>): void;
  getMetrics(): Record<string, unknown>;
  reset(): void;
}

export interface ITraceSpan {
  spanId: string;
  parentId?: string;
  name: string;
  startTime: Date;
  endTime?: Date;
  metadata?: Record<string, unknown>;
}

export interface ITraceRecorder {
  startSpan(name: string, parentId?: string, metadata?: Record<string, unknown>): ITraceSpan;
  endSpan(spanId: string, metadata?: Record<string, unknown>): void;
  getSpans(): ITraceSpan[];
  clear(): void;
}
