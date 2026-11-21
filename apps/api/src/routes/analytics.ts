// SPDX-License-Identifier: Apache-2.0
/**
 * Analytics + dashboard surface OWNER — extracted from api-bridge.ts.
 *
 * Instance-wide admin analytics (cost log + gateway log + account count) and the
 * per-account dashboard aggregate with its weekly digest. The cost log stays
 * bridge-owned (the gateway writes through the bridge tracker), so it is injected
 * as a snapshot.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import { db } from "@nexus/db";
import { users } from "@nexus/db/schema";
import { isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { ANON_OWNER } from "../lib/archetype-store.ts";
import { scopeCostEntriesToUser, type CostEntry } from "../lib/cost-log.ts";
import { pendingCount } from "../lib/org-approvals.ts";
import { allRuns } from "../lib/org-runtime.ts";
import { maybeEmitWeeklyDigest } from "../lib/weekly-digest.ts";
import { requireAuthWithTier } from "../middleware/auth.ts";

import { requireAdminRole as requireAdminRoleBridge } from "./admin-users.ts";

interface AnalyticsRoutesDeps {
  /** In-process cost log; the array identity is stable across requests. */
  costLog: readonly CostEntry[];
  /** Gateway log surface; its stats() is awaited per request. */
  gatewayLog: { stats(): Promise<GatewayStats> };
}

interface GatewayStats {
  totalRequests: number;
  totalTokens: number;
  errorRequests: number;
  p50LatencyMs: number;
  p99LatencyMs: number;
}

/** Register /analytics/* and /dashboard. */
export async function analyticsRoutes(
  app: FastifyInstance,
  deps: AnalyticsRoutesDeps,
): Promise<void> {
  /**
   * Roll deps.costLog into a zero-filled per-day series for the last `days` days.
   * Single implementation shared by /costs-style analytics, the /dashboard
   * aggregate, and /analytics/daily (which renames the keys for its consumers).
   */
  function dailyUsageSeries(days: number, entries: readonly CostEntry[] = deps.costLog) {
    const byDay: Record<string, { requests: number; tokens: number; costUsd: number }> = {};
    for (const e of entries) {
      const d = e.ts.slice(0, 10);
      if (!byDay[d]) byDay[d] = { requests: 0, tokens: 0, costUsd: 0 };
      byDay[d]!.tokens += e.inputTokens + e.outputTokens;
      byDay[d]!.costUsd += e.costUsd ?? 0;
      byDay[d]!.requests += 1;
    }
    const series: { date: string; requests: number; tokens: number; costUsd: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      series.push({ date: d, ...(byDay[d] ?? { requests: 0, tokens: 0, costUsd: 0 }) });
    }
    return series;
  }

  // -- ANALYTICS -------------------------------------------------------------

  app.get("/analytics/overview", { preHandler: requireAdminRoleBridge }, async (_req, reply) => {
    // Instance-wide: accounts, spend from the cost log, traffic from the gateway log.
    const totalUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(isNull(users.deletedAt))
      .then((r) => r.length)
      .catch(() => null);
    const costUsd = deps.costLog.reduce((sum, e) => sum + e.costUsd, 0);
    try {
      const s = await deps.gatewayLog.stats();
      const requests = s.totalRequests;
      const tokens =
        s.totalTokens || deps.costLog.reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0);
      const errorRate = requests > 0 ? s.errorRequests / requests : 0;
      return reply.send({
        totalUsers,
        costUsd,
        requests,
        tokens,
        latencyP50ms: Math.round(s.p50LatencyMs),
        latencyP99ms: Math.round(s.p99LatencyMs),
        errorRate: Math.round(errorRate * 10000) / 10000,
        source: "gateway-log",
      });
    } catch {
      // Gateway log unavailable (no KV) — report token totals from deps.costLog only.
      const tokens = deps.costLog.reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0);
      return reply.send({
        totalUsers,
        costUsd,
        requests: deps.costLog.length,
        tokens,
        latencyP50ms: 0,
        latencyP99ms: 0,
        errorRate: 0,
        source: "cost-log",
      });
    }
  });

  // -- DASHBOARD — aggregate for the home page --------------------------------
  // One authenticated round-trip powers the dashboard's usage surface: live
  // stats, a 7-day usage series, and recent research. The notification tray is
  // deliberately NOT here — it has a single owner (routes/notifications.ts + the
  // client NotificationsContext) so the badge never disagrees with the bell.

  app.get<{ Querystring: { days?: string } }>(
    "/dashboard",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      // Weekly digest — compute-on-read: on the first dashboard load of a new
      // week, roll up the most recently completed calendar week and drop the
      // result in the live tray (createNotification → SSE → toast). No
      // scheduler, no extra client code.
      await maybeEmitWeeklyDigest(request.nexusUserId, async (weekStart, weekEnd) => {
        const inWeek = (iso: string) => iso >= weekStart && iso < weekEnd;
        const entries = scopeCostEntriesToUser(deps.costLog, request.nexusUserId).filter((e) =>
          inWeek(e.ts.slice(0, 10)),
        );
        const byModel = new Map<string, number>();
        let tokens = 0;
        let costUsd = 0;
        for (const e of entries) {
          tokens += e.inputTokens + e.outputTokens;
          costUsd += e.costUsd ?? 0;
          byModel.set(e.model, (byModel.get(e.model) ?? 0) + (e.costUsd ?? 0));
        }
        let topModel: string | undefined;
        for (const [model, spent] of byModel) {
          if (topModel === undefined || spent > (byModel.get(topModel) ?? 0)) topModel = model;
        }
        const agentRuns = allRuns().filter(
          (r) =>
            r.ownerId === (request.nexusUserId ?? ANON_OWNER) &&
            r.finishedAt !== null &&
            inWeek(r.finishedAt.slice(0, 10)),
        ).length;
        return {
          requests: entries.length,
          tokens,
          costUsd,
          topModel,
          agentRuns,
          pendingApprovals: pendingCount(request.nexusUserId ?? ANON_OWNER),
        };
      });

      // Window length for the series (1–90, default 7); the client picks how
      // many points it needs for its Today/7d/30d summaries.
      const days = Math.min(Math.max(parseInt(request.query.days ?? "7", 10) || 7, 1), 90);
      // Personal scope: the dashboard says "your usage", so it must sum only
      // the caller's own entries — the raw deps.costLog is server-global (a fresh
      // account showed every user's spend as its own). Gateway-log stats are
      // likewise unattributed (identity = token slice), so the operator-global
      // latency/error enrichment stays on /analytics/overview only.
      const myEntries = scopeCostEntriesToUser(deps.costLog, request.nexusUserId);
      const tokens = myEntries.reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0);
      const costUsd = myEntries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
      const stats: Record<string, unknown> = {
        requests: myEntries.length,
        tokens,
        costUsd: Math.round(costUsd * 10000) / 10000,
        latencyP50ms: 0,
        latencyP99ms: 0,
        errorRate: 0,
        source: "cost-log",
      };

      return reply.send({
        stats,
        series: dailyUsageSeries(days, myEntries),
        generatedAt: new Date().toISOString(),
      });
    },
  );

  // ── analytics/daily + providers + models ──────────────────────────────────
  // Used by admin-analytics charts (lazy-loaded via analytics-charts.tsx).
  // Derives data from the in-process deps.costLog; returns deterministic empty
  // shapes when the log is empty so charts render without errors.

  app.get<{ Querystring: { days?: string } }>(
    "/analytics/daily",
    { preHandler: requireAdminRoleBridge },
    async (request, reply) => {
      const days = Math.min(Math.max(parseInt(request.query.days ?? "7") || 7, 1), 90);
      // Same rollup as /dashboard; /analytics/daily keeps its historical key names
      // (conversations/cost) for the admin charts that consume them.
      const result = dailyUsageSeries(days).map((r) => ({
        date: r.date,
        conversations: r.requests,
        tokens: r.tokens,
        cost: r.costUsd,
      }));
      return reply.send({ data: result });
    },
  );

  app.get("/analytics/providers", { preHandler: requireAdminRoleBridge }, async (_req, reply) => {
    const byProvider: Record<string, number> = {};
    for (const e of deps.costLog) {
      const p = e.model?.split("/")[0] ?? "unknown";
      byProvider[p] = (byProvider[p] ?? 0) + 1;
    }
    const data = Object.entries(byProvider).map(([provider, requests]) => ({ provider, requests }));
    return reply.send({ data });
  });

  app.get<{ Querystring: { limit?: string } }>(
    "/analytics/models",
    { preHandler: requireAdminRoleBridge },
    async (request, reply) => {
      const limit = parseInt(request.query.limit ?? "5") || 5;
      const byModel: Record<string, { requests: number; tokens: number; cost: number }> = {};
      for (const e of deps.costLog) {
        if (!byModel[e.model]) byModel[e.model] = { requests: 0, tokens: 0, cost: 0 };
        byModel[e.model]!.requests += 1;
        byModel[e.model]!.tokens += e.inputTokens + e.outputTokens;
        byModel[e.model]!.cost += e.costUsd ?? 0;
      }
      const data = Object.entries(byModel)
        .sort(([, a], [, b]) => b.requests - a.requests)
        .slice(0, limit)
        .map(([model, stats]) => ({ model, ...stats }));
      return reply.send({ data });
    },
  );
}
