// SPDX-License-Identifier: Apache-2.0
/**
 * Bridge billing surface OWNER — extracted from api-bridge.ts.
 *
 * The /api/billing/* aliases for the Judica frontend. Nexus is free + BYOK:
 * there are no plans to buy, no checkout and no subscription to cancel. Usage
 * is real and comes from the cost log, scoped to the caller. The cost log stays
 * bridge-owned, so it is injected.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks). The
 * admin billing surface (/api/v1/billing/*) is routes/billing.ts.
 */

import type { FastifyInstance } from "fastify";

import { scopeCostEntriesToUser, type CostEntry } from "../lib/cost-log.ts";

interface BillingBridgeDeps {
  /** In-process cost log; the array identity is stable across requests. */
  costLog: readonly CostEntry[];
}

/** Register the free + BYOK billing aliases. */
export async function billingBridgeRoutes(
  app: FastifyInstance,
  deps: BillingBridgeDeps,
): Promise<void> {
  app.get("/billing/plans", async (_req, reply) => {
    return reply.send({
      model: "free+byok",
      plans: [
        {
          id: "free",
          name: "Free",
          price: 0,
          features: ["Unlimited usage", "All features included", "Self-hosted or cloud"],
        },
        {
          id: "byok",
          name: "BYOK",
          price: 0,
          features: [
            "Bring your own OpenAI / Anthropic / Groq key",
            "Full cost control",
            "Zero markup",
          ],
        },
      ],
      current: "free",
      note: "Nexus is free. Add your own provider keys under /user/provider-keys to unlock LLM features.",
    });
  });

  app.post("/billing/checkout", async (_req, reply) => {
    return reply.send({
      ok: true,
      message: "No checkout needed — Nexus is free. Use /user/provider-keys to add your LLM keys.",
    });
  });

  // No subscriptions exist (free + BYOK is a locked decision) — the old synthetic
  // store invented a "pro" plan per tenant and fabricated usage from the tenant
  // id, which a real user saw as their own spend.
  app.get<{ Params: { tid: string } }>("/billing/subscription/:tid", async (_req, reply) => {
    return reply.send({
      planId: "free",
      status: "active",
      note: "Nexus is free — no subscriptions exist.",
    });
  });

  app.get<{ Params: { tid: string } }>("/billing/usage/:tid", async (req, reply) => {
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - 30);
    const entries = scopeCostEntriesToUser(deps.costLog, req.nexusUserId).filter(
      (e) => new Date(e.ts).getTime() >= periodStart.getTime(),
    );
    return reply.send({
      periodStart: periodStart.toISOString(),
      periodEnd: new Date().toISOString(),
      requests: entries.length,
      tokensIn: entries.reduce((s, e) => s + e.inputTokens, 0),
      tokensOut: entries.reduce((s, e) => s + e.outputTokens, 0),
      cost: Math.round(entries.reduce((s, e) => s + e.costUsd, 0) * 10_000) / 10_000,
      byModel: entries.reduce<Record<string, { requests: number; cost: number }>>((acc, e) => {
        const m = (acc[e.model] ??= { requests: 0, cost: 0 });
        m.requests++;
        m.cost = Math.round((m.cost + e.costUsd) * 10_000) / 10_000;
        return acc;
      }, {}),
    });
  });

  app.post<{ Params: { tid: string } }>("/billing/cancel/:tid", async (_req, reply) => {
    return reply.code(400).send({
      error: "no_subscription",
      message: "Nexus is free — there is no subscription to cancel.",
    });
  });
}
