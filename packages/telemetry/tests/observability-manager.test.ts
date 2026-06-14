// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";

import {
  Histogram,
  MetricsCollector,
  TraceRecorder,
  TelemetryExporter,
  HealthHistory,
  DiagnosticEnricher,
} from "../src/observability-manager.js";

// ─── Histogram ────────────────────────────────────────────────────────────────

describe("Histogram", () => {
  it("starts with zero count", () => {
    const h = new Histogram();
    expect(h.getSnapshot().count).toBe(0);
  });

  it("records values and updates count/sum", () => {
    const h = new Histogram();
    h.record(10);
    h.record(20);
    const snap = h.getSnapshot();
    expect(snap.count).toBe(2);
    expect(snap.sum).toBe(30);
  });

  it("tracks min and max correctly", () => {
    const h = new Histogram();
    h.record(5);
    h.record(50);
    h.record(15);
    expect(h.getSnapshot().min).toBe(5);
    expect(h.getSnapshot().max).toBe(50);
  });

  it("computes mean correctly", () => {
    const h = new Histogram();
    h.record(10);
    h.record(20);
    h.record(30);
    expect(h.getSnapshot().avg).toBeCloseTo(20);
  });

  it("computes p50/p95/p99 from recorded values", () => {
    const h = new Histogram();
    // Spread 100 samples across three distinct buckets so p50/p95/p99 each
    // resolve to a different bucket boundary (50, 100, 250 respectively).
    // Histogram uses predefined bucket boundaries — exact-value storage is
    // not guaranteed, so the dataset must be chosen to exercise bucket
    // boundaries explicitly.
    for (let i = 0; i < 50; i++) h.record(30); // → bucket 50
    for (let i = 0; i < 45; i++) h.record(75); // → bucket 100
    for (let i = 0; i < 5; i++) h.record(200); // → bucket 250
    const snap = h.getSnapshot();
    expect(snap.p50).toBe(50);
    expect(snap.p95).toBe(100);
    expect(snap.p99).toBe(250);
    expect(snap.p95).toBeGreaterThan(snap.p50);
    expect(snap.p99).toBeGreaterThan(snap.p95);
  });

  it("resets all values on reset()", () => {
    const h = new Histogram();
    h.record(100);
    h.reset();
    const snap = h.getSnapshot();
    expect(snap.count).toBe(0);
    expect(snap.sum).toBe(0);
  });
});

// ─── MetricsCollector ─────────────────────────────────────────────────────────

describe("MetricsCollector", () => {
  let mc: MetricsCollector;

  beforeEach(() => {
    mc = new MetricsCollector();
  });

  describe("increment()", () => {
    it("starts counters at 0", () => {
      expect(mc.getCounter("requests")).toBe(0);
    });

    it("increments by 1 by default", () => {
      mc.increment("requests");
      mc.increment("requests");
      expect(mc.getCounter("requests")).toBe(2);
    });

    it("increments by a custom amount", () => {
      mc.increment("bytes", 500);
      mc.increment("bytes", 250);
      expect(mc.getCounter("bytes")).toBe(750);
    });
  });

  describe("recordGauge()", () => {
    it("stores gauge value", () => {
      mc.recordGauge("cpu", 0.75);
      expect(mc.getGauge("cpu")).toBeCloseTo(0.75);
    });

    it("overwrites with the latest value", () => {
      mc.recordGauge("cpu", 0.5);
      mc.recordGauge("cpu", 0.9);
      expect(mc.getGauge("cpu")).toBeCloseTo(0.9);
    });

    it("returns undefined for unrecorded gauges", () => {
      expect(mc.getGauge("nonexistent")).toBeUndefined();
    });
  });

  describe("recordTiming()", () => {
    it("creates a histogram entry", () => {
      mc.recordTiming("latency_ms", 50);
      mc.recordTiming("latency_ms", 150);
      const hist = mc.getHistogram("latency_ms");
      expect(hist).toBeDefined();
      expect(hist?.getSnapshot().count).toBe(2);
    });
  });

  describe("getMetrics()", () => {
    it("includes counter values", () => {
      mc.increment("api_calls", 3);
      const metrics = mc.getMetrics();
      expect(metrics["api_calls"]).toBe(3);
    });

    it("includes histogram snapshots with _histogram suffix", () => {
      mc.recordTiming("response_ms", 100);
      const metrics = mc.getMetrics();
      expect(metrics["response_ms_histogram"]).toBeDefined();
    });
  });

  describe("reset()", () => {
    it("clears all counters, gauges, and histograms", () => {
      mc.increment("x");
      mc.recordGauge("y", 1);
      mc.recordTiming("z", 10);
      mc.reset();
      expect(mc.getCounter("x")).toBe(0);
      expect(mc.getGauge("y")).toBeUndefined();
      expect(mc.getHistogram("z")).toBeUndefined();
    });
  });
});

// ─── TraceRecorder ────────────────────────────────────────────────────────────

describe("TraceRecorder", () => {
  let tr: TraceRecorder;

  beforeEach(() => {
    tr = new TraceRecorder();
  });

  it("startSpan creates a span with a unique spanId", () => {
    const s1 = tr.startSpan("op1");
    const s2 = tr.startSpan("op2");
    expect(s1.spanId).not.toBe(s2.spanId);
  });

  it("endSpan sets an endTime on the span", () => {
    const span = tr.startSpan("my-op");
    tr.endSpan(span.spanId);
    const recorded = tr.getSpans().find((s) => s.spanId === span.spanId);
    expect(recorded?.endTime).toBeInstanceOf(Date);
  });

  it("endSpan merges metadata", () => {
    const span = tr.startSpan("my-op");
    tr.endSpan(span.spanId, { status: "ok" });
    const recorded = tr.getSpans().find((s) => s.spanId === span.spanId);
    expect(recorded?.metadata?.status).toBe("ok");
  });

  it("getSpanTree returns root-level spans (no parentId)", () => {
    tr.startSpan("root");
    const tree = tr.getSpanTree();
    expect(tree.length).toBeGreaterThan(0);
  });

  it("getTraceSummary counts spans and errors", () => {
    const _s1 = tr.startSpan("a");
    const s2 = tr.startSpan("b");
    tr.endSpan(s2.spanId, { status: "failed" });
    const summary = tr.getTraceSummary();
    expect(summary.totalSpans).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.spanNames).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("clear() empties all spans", () => {
    tr.startSpan("x");
    tr.clear();
    expect(tr.getSpans()).toHaveLength(0);
  });
});

// ─── TelemetryExporter ────────────────────────────────────────────────────────

describe("TelemetryExporter", () => {
  it("records events and returns them on flush()", () => {
    const exporter = new TelemetryExporter(0); // 0 = no auto-flush timer
    exporter.record("metric", { value: 42 });
    exporter.record("trace", { spanId: "abc" });
    const batch = exporter.flush();
    expect(batch).toHaveLength(2);
    expect(batch[0]?.type).toBe("metric");
    expect(batch[1]?.type).toBe("trace");
  });

  it("clears queue after flush()", () => {
    const exporter = new TelemetryExporter(0);
    exporter.record("x", {});
    exporter.flush();
    expect(exporter.getQueueLength()).toBe(0);
  });

  it("getQueueLength() reflects current queue size", () => {
    const exporter = new TelemetryExporter(0);
    expect(exporter.getQueueLength()).toBe(0);
    exporter.record("a", {});
    exporter.record("b", {});
    expect(exporter.getQueueLength()).toBe(2);
  });
});

// ─── HealthHistory ────────────────────────────────────────────────────────────

describe("HealthHistory", () => {
  it("getStats() returns 100% uptime when empty", () => {
    const hh = new HealthHistory();
    const stats = hh.getStats();
    expect(stats.totalRecords).toBe(0);
    expect(stats.uptimePercent).toBe(100);
  });

  it("records entries and computes stats correctly", () => {
    const hh = new HealthHistory();
    hh.record({ status: "healthy", servicesCount: 3 });
    hh.record({ status: "healthy", servicesCount: 3 });
    hh.record({ status: "unhealthy", servicesCount: 3 });
    const stats = hh.getStats();
    expect(stats.totalRecords).toBe(3);
    expect(stats.healthyCount).toBe(2);
    expect(stats.unhealthyCount).toBe(1);
    expect(stats.uptimePercent).toBeCloseTo(67);
  });

  it("getLatest() returns the most recent record", () => {
    const hh = new HealthHistory();
    hh.record({ status: "healthy", servicesCount: 1 });
    hh.record({ status: "degraded", servicesCount: 2 });
    expect(hh.getLatest()?.status).toBe("degraded");
  });

  it("respects maxRecords by evicting oldest", () => {
    const hh = new HealthHistory(3);
    for (let i = 0; i < 5; i++) {
      hh.record({ status: "healthy", servicesCount: i });
    }
    expect(hh.getHistory()).toHaveLength(3);
  });

  it("clear() removes all records", () => {
    const hh = new HealthHistory();
    hh.record({ status: "healthy", servicesCount: 1 });
    hh.clear();
    expect(hh.getHistory()).toHaveLength(0);
  });
});

// ─── DiagnosticEnricher ───────────────────────────────────────────────────────

describe("DiagnosticEnricher", () => {
  it("getRichDiagnostics() returns a composed diagnostic object", () => {
    const mc = new MetricsCollector();
    const tr = new TraceRecorder();
    const enricher = new DiagnosticEnricher(mc, tr);

    mc.increment("calls", 5);
    const span = tr.startSpan("test-op");
    tr.endSpan(span.spanId);

    const diag = enricher.getRichDiagnostics();
    expect(diag.metrics["calls"]).toBe(5);
    expect(diag.traces.totalSpans).toBe(1);
    expect(typeof diag.system.uptimeSeconds).toBe("number");
    expect(diag.system.nodeVersion).toMatch(/^v/);
  });

  it("recordHealthCheck() delegates to HealthHistory", () => {
    const enricher = new DiagnosticEnricher(new MetricsCollector(), new TraceRecorder());
    enricher.recordHealthCheck({ status: "healthy", servicesCount: 4 });
    const latest = enricher.getHealthHistory().getLatest();
    expect(latest?.status).toBe("healthy");
    expect(latest?.servicesCount).toBe(4);
  });
});
