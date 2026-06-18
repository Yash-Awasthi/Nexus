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

import { metricsToPrometheus, formatMetricLine, SloTracker } from "@nexus/telemetry";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

import { gatewayLog, _costStore } from "./gateway.js";
import { getConductorMetrics } from './conductor-route.js';

// ── SLO tracker singleton (records HTTP 2xx vs 5xx) ──────────────────────────
// Available for other routes to call sloTracker.record() on each response.
export const sloTracker = new SloTracker({
  windowMs: 5 * 60_000,
  targets: { availabilityTarget: 0.999, errorRateTarget: 0.001, p99LatencyTargetMs: 2_000 },
  onViolation: (v) => {
    process.stderr.write(`[SLO VIOLATION] sli=${v.sli} actual=${v.actual} target=${v.target}\n`);
  },
});

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
        const runs = await _costStore.list();
        const totalCost = runs.reduce(
          (s, r) => s + r.steps.reduce((a, st) => a + (st.costUsd ?? 0), 0),
          0,
        );
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

      // ── Conductor orchestration metrics ────────────────────────────────────
      try {
        const gs = await getConductorMetrics();
        lines.push("# TYPE nexus_conductor_jobs_total counter");
        lines.push(formatMetricLine("nexus_conductor_jobs_total", gs.jobsTotal, { status: "all" }));
        lines.push(formatMetricLine("nexus_conductor_jobs_total", gs.jobsDone, { status: "done" }));
        lines.push(formatMetricLine("nexus_conductor_jobs_total", gs.jobsFailed, { status: "failed" }));
        lines.push(formatMetricLine("nexus_conductor_jobs_total", gs.jobsBlocked, { status: "blocked" }));
        lines.push(formatMetricLine("nexus_conductor_jobs_total", gs.jobsRunning, { status: "running" }));
        lines.push("# TYPE nexus_conductor_queue_depth gauge");
        lines.push(formatMetricLine("nexus_conductor_queue_depth", gs.queueLength, { queue: "main" }));
        lines.push(formatMetricLine("nexus_conductor_queue_depth", gs.activeJobs, { queue: "active" }));
        lines.push(formatMetricLine("nexus_conductor_queue_depth", gs.deadLetterCount, { queue: "dead_letter" }));
        lines.push("# TYPE nexus_conductor_initialised gauge");
        lines.push(formatMetricLine("nexus_conductor_initialised", gs.initialised ? 1 : 0));
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
