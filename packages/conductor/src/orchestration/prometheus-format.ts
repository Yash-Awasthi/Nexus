// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal Prometheus text exposition from in-process MetricsCollector output.
 */

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export function metricsToPrometheus(metrics: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const [name, value] of Object.entries(metrics)) {
    const safeName = name.replace(/[^a-zA-Z0-9_:]/g, "_");
    if (typeof value === "number") {
      lines.push(`# TYPE ${safeName} gauge`);
      lines.push(`${safeName} ${value}`);
    } else if (Array.isArray(value) && value.every((v) => typeof v === "number")) {
      const arr = value as number[];
      const sum = arr.reduce((a, b) => a + b, 0);
      const count = arr.length;
      const max = count ? Math.max(...arr) : 0;
      lines.push(`# TYPE ${safeName} summary`);
      lines.push(`${safeName}_count ${count}`);
      lines.push(`${safeName}_sum ${sum}`);
      lines.push(`${safeName}_max ${max}`);
    }
  }

  lines.push("# TYPE process_heap_bytes gauge");
  lines.push(`process_heap_bytes ${process.memoryUsage().heapUsed}`);

  return lines.join("\n") + "\n";
}

export function formatMetricLine(
  name: string,
  value: number,
  labels?: Record<string, string>,
): string {
  if (!labels || Object.keys(labels).length === 0) {
    return `${name} ${value}`;
  }
  const labelStr = Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(",");
  return `${name}{${labelStr}} ${value}`;
}
