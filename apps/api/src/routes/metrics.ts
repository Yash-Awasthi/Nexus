// SPDX-License-Identifier: Apache-2.0
/**
 * Metrics routes — Prometheus text exposition for scraping.
 *
 * GET /metrics — returns text/plain Prometheus scrape endpoint.
 *
 * Exposed metrics:
 *   nexus_gateway_requests_total{status,provider,model}  counter
 *   nexus_gateway_latency_ms{provider}                  gauge (last observed)
 *   nexus_gateway_tokens_total{type}                    counter (input/output)
 *   nexus_gateway_cost_usd_total                        counter
 *   nexus_memory_entries_total                          gauge
 *   nexus_drive_total                                   gauge
 *   nexus_drive_bytes_used                              gauge
 *   nexus_drive_files                                   gauge
 *   nexus_drive_over_quota                              gauge
 *   nexus_alert_events_total{severity}                  counter
 *   process_heap_bytes                                  gauge
 *   process_uptime_seconds                              gauge
 *
 * Scrape this endpoint from your Prometheus config:
 *   - job_name: nexus-api
 *     static_configs: [{targets: ["nexus-api:3000"]}]
 *     metrics_path: /api/v1/metrics
 *
 * NOTE: /metrics is intentionally mounted under /api/v1 (auth required).
 * For unauthenticated scraping, set METRICS_NO_AUTH=true and add an
 * additional no-auth route in server.ts.
 */

import { DRIVE_QUOTA_BYTES, listDrives, statDrive } from "@nexus/sandbox";
import { metricsToPrometheus, formatMetricLine, SloTracker } from "@nexus/telemetry";
import type { FastifyInstance } from "fastify";

import { costLogStore } from "../lib/cost-log.js";
import { requireAuth } from "../middleware/auth.js";

import { gatewayLog } from "./gateway.js";

// ── SLO tracker singleton (records HTTP 2xx vs 5xx) ──────────────────────────
// Available for other routes to call sloTracker.record() on each response.
export const sloTracker = new SloTracker({
  windowMs: 5 * 60_000,
  targets: { availabilityTarget: 0.999, errorRateTarget: 0.001, p99LatencyTargetMs: 2_000 },
  onViolation: (v) => {
    process.stderr.write(`[SLO VIOLATION] sli=${v.sli} actual=${v.actual} target=${v.target}\n`);
  },
});

/**
 * Drive totals, recomputed at most once a minute.
 *
 * Answering a scrape means walking every drive on disk, which is far more
 * expensive than the scrape interval warrants; a minute-old number is the
 * right trade for a gauge Prometheus samples every fifteen seconds.
 */
const DRIVE_METRICS_TTL_MS = 60_000;
let driveMetricsCache: { at: number; value: DriveMetrics } | null = null;

interface DriveMetrics {
  drives: number;
  bytes: number;
  files: number;
  overQuota: number;
}

async function driveMetrics(): Promise<DriveMetrics> {
  if (driveMetricsCache && Date.now() - driveMetricsCache.at < DRIVE_METRICS_TTL_MS) {
    return driveMetricsCache.value;
  }
  const value: DriveMetrics = { drives: 0, bytes: 0, files: 0, overQuota: 0 };
  for (const drive of await listDrives()) {
    const stat = await statDrive(drive.dir);
    value.drives += 1;
    value.bytes += stat.bytes;
    value.files += stat.files;
    if (stat.bytes > DRIVE_QUOTA_BYTES) value.overQuota += 1;
  }
  driveMetricsCache = { at: Date.now(), value };
  return value;
}

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /metrics
   *
   * Prometheus text format scrape endpoint.
   * Access: Bearer auth required (set METRICS_NO_AUTH=true to bypass).
   */
  app.get(
    "/metrics",
    {
      preHandler: process.env.METRICS_NO_AUTH === "true" ? undefined : requireAuth,
    },
    async (_request, reply) => {
      const lines: string[] = [];

      // ── Gateway log metrics ─────────────────────────────────────────────────
      try {
        const entries = await gatewayLog.query({ limit: 10_000 });
        const totalReqs = entries.length;
        const successReqs = entries.filter((e) => e.status === "success").length;
        const errorReqs = entries.filter((e) => e.status === "error").length;
        const totalInput = entries.reduce((s, e) => s + (e.usage?.promptTokens ?? 0), 0);
        const totalOutput = entries.reduce((s, e) => s + (e.usage?.completionTokens ?? 0), 0);
        const lastLatency = entries[0]?.latencyMs ?? 0;

        lines.push("# TYPE nexus_gateway_requests_total counter");
        lines.push(formatMetricLine("nexus_gateway_requests_total", totalReqs, { status: "all" }));
        lines.push(
          formatMetricLine("nexus_gateway_requests_total", successReqs, { status: "success" }),
        );
        lines.push(
          formatMetricLine("nexus_gateway_requests_total", errorReqs, { status: "error" }),
        );

        lines.push("# TYPE nexus_gateway_latency_ms gauge");
        lines.push(formatMetricLine("nexus_gateway_latency_ms", lastLatency));

        lines.push("# TYPE nexus_gateway_tokens_total counter");
        lines.push(formatMetricLine("nexus_gateway_tokens_total", totalInput, { type: "input" }));
        lines.push(formatMetricLine("nexus_gateway_tokens_total", totalOutput, { type: "output" }));
      } catch {
        /* gate log unavailable */
      }

      // ── Run-cost metrics ────────────────────────────────────────────────────
      try {
        const totalCost = costLogStore.entries.reduce((s, e) => s + e.costUsd, 0);
        lines.push("# TYPE nexus_gateway_cost_usd_total counter");
        lines.push(formatMetricLine("nexus_gateway_cost_usd_total", totalCost));
      } catch {
        /* non-fatal */
      }

      // ── SLO metrics ─────────────────────────────────────────────────────────
      try {
        const slo = sloTracker.report();
        lines.push("# TYPE nexus_slo_availability gauge");
        lines.push(formatMetricLine("nexus_slo_availability", slo.availability));
        lines.push("# TYPE nexus_slo_error_rate gauge");
        lines.push(formatMetricLine("nexus_slo_error_rate", slo.errorRate));
        lines.push("# TYPE nexus_slo_p99_latency_ms gauge");
        lines.push(formatMetricLine("nexus_slo_p99_latency_ms", slo.latencyP99Ms));
        lines.push("# TYPE nexus_slo_total_requests counter");
        lines.push(formatMetricLine("nexus_slo_total_requests", slo.totalRequests));
      } catch {
        /* non-fatal */
      }

      // ── Drive metrics (§8.4) ────────────────────────────────────────────────
      try {
        const drive = await driveMetrics();
        lines.push("# TYPE nexus_drive_total gauge");
        lines.push(formatMetricLine("nexus_drive_total", drive.drives));
        lines.push("# TYPE nexus_drive_bytes_used gauge");
        lines.push(formatMetricLine("nexus_drive_bytes_used", drive.bytes));
        lines.push("# TYPE nexus_drive_files gauge");
        lines.push(formatMetricLine("nexus_drive_files", drive.files));
        lines.push("# TYPE nexus_drive_over_quota gauge");
        lines.push(formatMetricLine("nexus_drive_over_quota", drive.overQuota));
        lines.push("# TYPE nexus_drive_quota_bytes gauge");
        lines.push(formatMetricLine("nexus_drive_quota_bytes", DRIVE_QUOTA_BYTES));
      } catch {
        /* non-fatal */
      }

      // ── Process metrics ─────────────────────────────────────────────────────
      const mem = process.memoryUsage();
      lines.push(
        metricsToPrometheus({
          process_heap_bytes: mem.heapUsed,
          process_rss_bytes: mem.rss,
          process_uptime_seconds: process.uptime(),
        }),
      );

      const body = lines.join("\n") + "\n";
      return reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8").send(body);
    },
  );
}
