// SPDX-License-Identifier: Apache-2.0
/**
 * Billing routes — plan info, quota usage, API key management, Stripe webhooks.
 *
 * GET  /api/v1/billing/plan            — current plan definition
 * GET  /api/v1/billing/current-period  — usage for current billing period
 * GET  /api/v1/billing/keys            — list API keys for the authenticated owner
 * POST /api/v1/billing/keys            — create a new API key
 * DELETE /api/v1/billing/keys/:id      — revoke a key
 * POST /api/v1/billing/webhook/stripe  — Stripe webhook handler
 */

import {
  QuotaChecker,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  InMemoryKeyStore,
  InMemoryUsageStore,
} from "@nexus/billing";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── In-memory stores (swap for DB-backed in production) ───────────────────────

const keyStore = new InMemoryKeyStore();
const usageStore = new InMemoryUsageStore();

const quota = new QuotaChecker({
  store: usageStore,
  monthlyTokenLimit: 50_000,
  rpmLimit: 60,
});

// ── Static plan definitions ───────────────────────────────────────────────────

const PLANS = {
  free: {
    name: "Free",
    price: 0,
    period: "month",
    features: ["50K tokens/day", "Groq + Ollama", "Basic API access", "Community support"],
    tokensPerMonth: 1_500_000,
    rpmLimit: 60,
    tier: "free",
  },
  pro: {
    name: "Pro",
    price: 29,
    period: "month",
    features: ["2M tokens/day", "All 15 providers", "Query + JSONL export", "Priority support", "Analytics"],
    tokensPerMonth: 60_000_000,
    rpmLimit: 600,
    tier: "pro",
  },
  enterprise: {
    name: "Enterprise",
    price: 199,
    period: "month",
    features: ["Unlimited tokens", "All 15 providers", "HF corpus push", "SLA guarantee", "SSO + audit logs"],
    tokensPerMonth: -1,
    rpmLimit: 6000,
    tier: "enterprise",
  },
};

type PlanKey = keyof typeof PLANS;

function currentPlanKey(): PlanKey {
  const key = process.env.NEXUS_BILLING_PLAN as PlanKey | undefined;
  return key && PLANS[key] ? key : "free";
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  /** GET /billing/plan */
  app.get("/billing/plan", { preHandler: requireAuth }, async (_req, reply) => {
    const planKey = currentPlanKey();
    return reply.send({ plan: { ...PLANS[planKey], key: planKey } });
  });

  /** GET /billing/current-period */
  app.get("/billing/current-period", { preHandler: requireAuth }, async (_req, reply) => {
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const usage = await usageStore.getMonthlyUsage("global");
    const planKey = currentPlanKey();
    const plan = PLANS[planKey];

    return reply.send({
      period: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        tokensUsed: usage.tokens,
        tokensLimit: plan.tokensPerMonth,
        requestsCount: usage.requests,
        rpmCurrent: usage.rpmCurrent,
        rpmLimit: plan.rpmLimit,
      },
    });
  });

  /** GET /billing/keys */
  app.get("/billing/keys", { preHandler: requireAuth }, async (_req, reply) => {
    const keys = await listApiKeys(keyStore, "global");
    return reply.send({ keys: keys.map((k) => ({ ...k, rawKey: undefined })) });
  });

  /** POST /billing/keys */
  app.post<{ Body: { name: string; scopes?: string[] } }>(
    "/billing/keys",
    { preHandler: requireAuth },
    async (request, reply) => {
      const result = await createApiKey(keyStore, {
        ownerId: "global",
        name: request.body.name,
        scopes: request.body.scopes ?? ["api"],
      });
      return reply.code(201).send({
        id: result.id,
        name: result.name,
        rawKey: result.rawKey,
        keyPrefix: result.keyPrefix,
        createdAt: result.createdAt,
        scopes: result.scopes,
      });
    },
  );

  /** DELETE /billing/keys/:id */
  app.delete<{ Params: { id: string } }>(
    "/billing/keys/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const revoked = await revokeApiKey(keyStore, request.params.id);
      if (!revoked) return reply.code(404).send({ error: "Key not found" });
      return reply.code(204).send();
    },
  );

  /** GET /billing/quota — real-time quota status */
  app.get("/billing/quota", { preHandler: requireAuth }, async (_req, reply) => {
    const check = await quota.check("global", 0);
    return reply.send(check);
  });

  /** POST /billing/webhook/stripe */
  app.post(
    "/billing/webhook/stripe",
    { config: { rawBody: true } },
    async (request, reply) => {
      // Signature verification happens here — skip in dev if no STRIPE_WEBHOOK_SECRET
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret) {
        app.log.warn("STRIPE_WEBHOOK_SECRET not set — skipping signature verification");
      }
      // For now: acknowledge all events (production: use StripeWebhookProcessor)
      app.log.info({ event: "stripe-webhook" }, "Stripe webhook received");
      return reply.code(200).send({ received: true });
    },
  );
}
