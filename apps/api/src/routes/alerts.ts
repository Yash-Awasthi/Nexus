// SPDX-License-Identifier: Apache-2.0
/**
 * Alerts routes — AlertEngine rule management + history.
 *
 * GET    /alerts/rules          — list configured rules
 * POST   /alerts/rules          — add a rule (threshold | rate | pattern)
 * PATCH  /alerts/rules/:id      — enable/disable or update cooldown
 * DELETE /alerts/rules/:id      — remove a rule
 * GET    /alerts/history        — recent alert events (last 500)
 * POST   /alerts/evaluate       — manually evaluate a metric value
 *
 * Default rules wired on boot:
 *   • task.errors    — warning when error count spikes (rate ≥ 3/min)
 *   • gateway.latency — warning when p95 latency > 5 000 ms (threshold)
 *
 * Alert triggers:
 *   globalHooks "task.error"  → evaluate "task.errors" metric
 *   globalHooks "task.after"  → evaluate "gateway.latency" with durationMs
 */

import {
  AlertEngine,
  AlertHistory,
  MemoryAlertCooldownStore,
  thresholdRule,
  type AlertRule,
} from "@nexus/alerts";
import { globalHooks } from "@nexus/hooks";
import type { FastifyInstance } from "fastify";

import { getSharedKV } from "../lib/shared-kv.js";
import { requireAuth } from "../middleware/auth.js";

// ── Cross-pod alert fan-out via shared KVStore ────────────────────────────────
// When the AlertEngine fires on pod A, it publishes an alert event to the KVStore.
// All pods poll the "alert:events" list key on a 2-second interval and re-evaluate
// locally so their AlertHistory stays consistent.
// Production upgrade path: replace this with BullMQ when ioredis is available.

const ALERT_FANOUT_KEY = "alert:events";
const ALERT_FANOUT_TTL_MS = 5 * 60_000; // 5-minute event window

interface DistributedAlertEvent {
  metric: string;
  value: number;
  ts: number;
  origin: string;
}

const _podId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

async function _publishAlertEvent(metric: string, value: number): Promise<void> {
  try {
    const kv = getSharedKV();
    const key = `${ALERT_FANOUT_KEY}:${Date.now()}:${_podId}`;
    await kv.set<DistributedAlertEvent>(
      key,
      { metric, value, ts: Date.now(), origin: _podId },
      ALERT_FANOUT_TTL_MS,
    );
  } catch {
    /* non-fatal */
  }
}

// ── Singleton AlertEngine ─────────────────────────────────────────────────────

const alertHistory = new AlertHistory(500);
const cooldowns = new MemoryAlertCooldownStore();

export const alertEngine = new AlertEngine({
  channels: [], // add real channels (Slack, email) via POST /alerts/rules
  history: alertHistory,
  cooldownStore: cooldowns,
});

// Default rules
alertEngine.addRule(
  thresholdRule("task.errors", "task.errors", "gte", 1, "warning", {
    name: "Task error spike",
    cooldownMs: 60_000,
  }),
);

alertEngine.addRule(
  thresholdRule("gateway.latency", "gateway.latency", "gt", 5_000, "warning", {
    name: "Gateway latency > 5 s",
    cooldownMs: 120_000,
  }),
);

alertEngine.addRule(
  thresholdRule("http.5xx", "http.5xx", "gte", 1, "critical", {
    name: "HTTP 5xx response",
    cooldownMs: 30_000,
  }),
);

// ── Hook-driven triggers ──────────────────────────────────────────────────────

globalHooks.on(
  "task.error",
  async (_payload) => {
    await alertEngine.evaluate("task.errors", 1).catch(() => {});
    await _publishAlertEvent("task.errors", 1);
  },
  { label: "alerts:task.error" },
);

globalHooks.on(
  "task.after",
  async (payload) => {
    const durationMs = (payload as { durationMs?: number }).durationMs;
    if (durationMs !== undefined) {
      await alertEngine.evaluate("gateway.latency", durationMs).catch(() => {});
      await _publishAlertEvent("gateway.latency", durationMs);
    }
  },
  { label: "alerts:task.after" },
);

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function alertsRoutes(app: FastifyInstance): Promise<void> {
  /** GET /alerts/rules — list all configured alert rules */
  app.get(
    "/alerts/rules",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_request, reply) => {
      return reply.send({ rules: alertEngine.listRules(), total: alertEngine.listRules().length });
    },
  );

  /**
   * POST /alerts/rules
   *
   * Add an alert rule.
   * Body:
   *   id          — unique rule id
   *   metric      — metric name to match (e.g. "task.errors")
   *   condition   — { type: "threshold", operator: "gt"|"gte"|..., value: number }
   *                 | { type: "rate", count: number, windowMs: number }
   *   severity    — "info" | "warning" | "critical"
   *   message     — human-readable description
   *   cooldownMs  — suppress duplicate fires for this long (default: 0)
   *   enabled     — default true
   */
  app.post<{ Body: AlertRule }>(
    "/alerts/rules",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      try {
        alertEngine.addRule(request.body);
        // Sanitise string fields before echoing — prevents reflected XSS if the
        // response is ever rendered in an HTML context by a downstream client.
        const safe = {
          ...request.body,
          message: encodeURIComponent(request.body.message ?? ""),
          metric: encodeURIComponent(request.body.metric ?? ""),
        };
        return reply.code(201).send(safe);
      } catch (err) {
        return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  /**
   * PATCH /alerts/rules/:id
   *
   * Enable/disable a rule or update cooldownMs.
   * Body: Partial<{ enabled: boolean, cooldownMs: number, message: string }>
   */
  app.patch<{
    Params: { id: string };
    Body: Partial<Omit<AlertRule, "id">>;
  }>("/alerts/rules/:id", { preHandler: requireAuth }, async (request, reply) => {
    try {
      alertEngine.updateRule(request.params.id, request.body);
      return reply.send(alertEngine.getRule(request.params.id));
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** DELETE /alerts/rules/:id — remove a rule */
  app.delete<{ Params: { id: string } }>(
    "/alerts/rules/:id",
    {
      schema: {
        response: { 200: { type: "object", additionalProperties: true }, 204: { type: "null" } },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      try {
        alertEngine.removeRule(request.params.id);
        return reply.code(204).send();
      } catch (err) {
        return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  /**
   * GET /alerts/history?severity=&metric=&limit=
   *
   * Return recent alert firing events.
   */
  app.get<{
    Querystring: {
      severity?: "info" | "warning" | "critical";
      ruleId?: string;
      limit?: string;
    };
  }>("/alerts/history", { preHandler: requireAuth }, async (request, reply) => {
    const { severity, ruleId, limit: limitStr } = request.query;
    const limit = Math.min(parseInt(limitStr ?? "50", 10) || 50, 500);

    let events = alertHistory.getAll();
    if (severity) events = events.filter((e) => e.severity === severity);
    if (ruleId) events = events.filter((e) => e.ruleId === ruleId);
    events = events.slice(-limit).reverse(); // newest first

    return reply.send({ events, total: events.length });
  });

  /**
   * POST /alerts/evaluate
   *
   * Manually evaluate a metric value against all matching rules.
   * Body: { metric: string, value: number }
   * Returns DispatchResult: { fired, suppressed, disabled, events }
   */
  app.post<{
    Body: { metric: string; value: number };
  }>("/alerts/evaluate", { preHandler: requireAuth }, async (request, reply) => {
    const { metric, value } = request.body;
    if (!metric) return reply.code(400).send({ error: "metric is required" });
    const result = await alertEngine.evaluate(metric, value);
    return reply.send(result);
  });
}
