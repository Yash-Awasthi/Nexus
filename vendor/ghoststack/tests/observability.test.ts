import { MetricsCollector, TraceRecorder } from "../orchestration/observability-manager";

describe("Milestone 1: Observability Core (Metrics & Tracing)", () => {
  describe("MetricsCollector", () => {
    it("should increment counters, record gauges, and track latency timing metrics correctly", () => {
      const collector = new MetricsCollector();

      collector.increment("task.executed");
      collector.increment("task.executed", 2);
      expect(collector.getMetrics()["task.executed"]).toBe(3);

      collector.recordGauge("queue.size", 5);
      expect(collector.getMetrics()["queue.size"]).toBe(5);

      collector.recordTiming("execution.duration", 120);
      const metrics = collector.getMetrics();
      // Timing metrics are now stored as Histograms with percentile snapshots
      expect(metrics["execution.duration_histogram"]).toBeDefined();
      expect(metrics["execution.duration_histogram"].count).toBe(1);
      expect(metrics["execution.duration_histogram"].sum).toBe(120);
      expect(metrics["execution.duration_histogram"].avg).toBe(120);
      expect(metrics["execution.duration_histogram"].min).toBe(120);
      expect(metrics["execution.duration_histogram"].max).toBe(120);

      // Also verify getCounter and recordGauge paths
      expect(collector.getCounter("task.executed")).toBe(3);
      expect(collector.getGauge("queue.size")).toBe(5);
    });
  });

  describe("TraceRecorder", () => {
    it("should start and end spans with proper parent-child hierarchy tracing", () => {
      const recorder = new TraceRecorder();

      const spanA = recorder.startSpan("orchestrator.boot", undefined, { version: "1.0" });
      expect(spanA.spanId).toBeDefined();
      expect(spanA.name).toBe("orchestrator.boot");

      const spanB = recorder.startSpan("service.health", spanA.spanId, { service: "floci" });
      expect(spanB.parentId).toBe(spanA.spanId);

      recorder.endSpan(spanB.spanId, { status: "success" });
      recorder.endSpan(spanA.spanId, { status: "success" });

      const spans = recorder.getSpans();
      expect(spans.length).toBe(2);

      const retrievedB = spans.find((s) => s.spanId === spanB.spanId);
      expect(retrievedB?.endTime).toBeDefined();
      expect(retrievedB?.metadata?.status).toBe("success");
    });
  });
});
