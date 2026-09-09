// SPDX-License-Identifier: Apache-2.0
/**
 * Costs surface OWNER — extracted from api-bridge.ts (§16.7).
 *
 * Real usage/cost analytics derived from the in-process cost log
 * (`costLogStore.entries`, the same array api-bridge's `_llm()` records into —
 * durable via lib/cost-log.ts write-behind). Response shapes are byte-identical
 * to the pre-extraction /api/costs/* handlers.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import type { FastifyInstance } from "fastify";

import {
  costLogStore,
  MODEL_PRICES,
  scopeCostEntriesToUser,
  type CostEntry,
} from "../lib/cost-log.js";

/** Same in-memory array every api-bridge read touches — never reassigned. */
const _costLog: readonly CostEntry[] = costLogStore.entries;

/** Register the /costs/* surface. Called from apiBridgeRoutes. */
export async function costsRoutes(app: FastifyInstance): Promise<void> {
  // Personal scope: every /costs/* surface is framed as the caller's own
  // spend (the UI shows "your usage"), so reads filter to the caller's
  // entries. Server-global views stay on /analytics/*.
  const mine = (req: { nexusUserId?: string }, days?: number) => {
    const scoped = scopeCostEntriesToUser(_costLog, req.nexusUserId);
    return days === undefined ? scoped : scoped.filter((e) => new Date(e.ts).getTime() >= Date.now() - days * 86_400_000);
  };

  app.get<{ Querystring: { days?: string } }>("/costs/dashboard", async (req, reply) => {
    const days = parseInt(req.query.days ?? "30", 10);
    const entries = mine(req, days);
    const totalUsd = entries.reduce((s, e) => s + e.costUsd, 0);
    const totalTokens = entries.reduce((s, e) => s + e.inputTokens + e.outputTokens, 0);
    // Group by day
    const byDay: Record<string, number> = {};
    for (const e of entries) {
      const d = e.ts.slice(0, 10);
      byDay[d] = (byDay[d] ?? 0) + e.costUsd;
    }
    // Group by model
    const byModel: Record<string, number> = {};
    for (const e of entries) byModel[e.model] = (byModel[e.model] ?? 0) + e.costUsd;
    return reply.send({
      totalUsd: Math.round(totalUsd * 10_000) / 10_000,
      totalTokens,
      byDay,
      byModel,
      period: `${days} days`,
      requests: entries.length,
    });
  });

  app.get("/costs/breakdown", async (req, reply) => {
    const breakdown = Object.entries(
      mine(req).reduce<Record<string, { calls: number; tokens: number; usd: number }>>((acc, e) => {
        if (!acc[e.model]) acc[e.model] = { calls: 0, tokens: 0, usd: 0 };
        acc[e.model]!.calls += 1;
        acc[e.model]!.tokens += e.inputTokens + e.outputTokens;
        acc[e.model]!.usd += e.costUsd;
        return acc;
      }, {}),
    ).map(([model, stats]) => ({ model, ...stats, usd: Math.round(stats.usd * 10_000) / 10_000 }));
    return reply.send({
      breakdown,
      totalUsd: Math.round(mine(req).reduce((s, e) => s + e.costUsd, 0) * 10_000) / 10_000,
    });
  });

  app.get("/costs/per-provider", async (req, reply) => {
    const map: Record<string, number> = {};
    for (const e of mine(req)) {
      const provider = e.model.split("/")[0] ?? e.model;
      map[provider] = (map[provider] ?? 0) + e.costUsd;
    }
    const providers = Object.entries(map).map(([name, usd]) => ({
      name,
      usd: Math.round(usd * 10_000) / 10_000,
    }));
    return reply.send({ providers });
  });

  app.get("/costs/efficiency", async (req, reply) => {
    // Tokens per dollar for each model
    const stats: Record<string, { tokens: number; usd: number }> = {};
    for (const e of mine(req)) {
      if (!stats[e.model]) stats[e.model] = { tokens: 0, usd: 0 };
      stats[e.model]!.tokens += e.inputTokens + e.outputTokens;
      stats[e.model]!.usd += e.costUsd;
    }
    const efficiency = Object.entries(stats).map(([model, { tokens, usd }]) => ({
      model,
      tokensPerDollar: usd > 0 ? Math.round(tokens / usd) : 0,
    }));
    return reply.send({ efficiency });
  });

  app.get("/costs/organization", async (req, reply) => {
    const totalUsd = mine(req).reduce((s, e) => s + e.costUsd, 0);
    return reply.send({
      totalUsd: Math.round(totalUsd * 10_000) / 10_000,
      seats: 1,
      perSeatUsd: Math.round(totalUsd * 10_000) / 10_000,
    });
  });

  app.get("/costs/limits", async (req, reply) => {
    const monthly = process.env.NEXUS_MONTHLY_LIMIT_USD
      ? Number(process.env.NEXUS_MONTHLY_LIMIT_USD)
      : null;
    const daily = process.env.NEXUS_DAILY_LIMIT_USD
      ? Number(process.env.NEXUS_DAILY_LIMIT_USD)
      : null;
    // Real spend from the cost log (ts is ISO-8601, so prefix-match the period).
    const monthPrefix = new Date().toISOString().slice(0, 7); // YYYY-MM
    const dayPrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const round = (n: number) => Math.round(n * 10_000) / 10_000;
    const spentMonth = round(
      mine(req)
        .filter((e) => e.ts.startsWith(monthPrefix))
        .reduce((s, e) => s + e.costUsd, 0),
    );
    const spentToday = round(
      mine(req)
        .filter((e) => e.ts.startsWith(dayPrefix))
        .reduce((s, e) => s + e.costUsd, 0),
    );
    return reply.send({
      limits: { monthly_usd: monthly, daily_usd: daily },
      spent: { monthly_usd: spentMonth, daily_usd: spentToday },
      remaining: {
        monthly_usd: monthly !== null ? round(Math.max(0, monthly - spentMonth)) : null,
        daily_usd: daily !== null ? round(Math.max(0, daily - spentToday)) : null,
      },
      enforced: false,
      note: "Limits are reported, not hard-enforced. Set NEXUS_MONTHLY_LIMIT_USD / NEXUS_DAILY_LIMIT_USD.",
    });
  });

  app.get("/costs/pricing", async (_req, reply) => {
    const models = Object.entries(MODEL_PRICES).map(([model, [input, output]]) => ({
      model,
      inputPer1MTokens: input,
      outputPer1MTokens: output,
    }));
    return reply.send({ models });
  });
}