import { metricsToPrometheus } from "../orchestration/prometheus-format";

describe("prometheus-format", () => {
  it("exports gauges and timing summaries", () => {
    const text = metricsToPrometheus({
      "task.success": 3,
      "task.latency": [10, 20, 30]
    });
    expect(text).toContain("task_success 3");
    expect(text).toContain("task_latency_count 3");
    expect(text).toContain("process_heap_bytes");
  });
});
