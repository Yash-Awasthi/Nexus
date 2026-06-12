// SPDX-License-Identifier: Apache-2.0
export interface ITaskSnapshot {
  id: string;
  status: string;
  priority: string;
  dependencies: string[];
  executionTimeMs?: number;
  retries: number;
}

export interface IQueueSnapshot {
  activeJobsCount: number;
  deadLetterJobsCount: number;
  jobs: { id: string; priority: string; retries: number }[];
}

export interface IEventSnapshot {
  event: string;
  /** ISO string from the event log JSON, or a Date when constructed in-process. */
  timestamp: Date | string;
  payload: unknown;
}

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

export interface ITelemetrySink {
  record(event: string, payload: unknown): void;
  getTelemetry(): unknown[];
}

export interface IRuntimeInspector {
  getHealth(): Promise<any>;
  getMetrics(): Promise<any>;
  getTasks(): Promise<ITaskSnapshot[]>;
  getEvents(): Promise<IEventSnapshot[]>;
  getQueues(): Promise<IQueueSnapshot>;
  getServices(): Promise<any[]>;
  getSnapshots(): Promise<any>;
}
