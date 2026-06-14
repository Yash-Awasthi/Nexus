// SPDX-License-Identifier: Apache-2.0
/**
 * Billing routes — plan info, quota usage, API key management, Stripe webhooks.
 *
 * API key CRUD is backed by Drizzle ORM → Neon Postgres (via @nexus/billing).
 * When DATABASE_URL is not set the key endpoints return 503 with a clear error.
 *
 * GET  /api/v1/billing/plan            — current plan definition
 * GET  /api/v1/billing/current-period  — usage for current billing period
 * GET  /api/v1/billing/keys            — list API keys for the authenticated owner
 * POST /api/v1/billing/keys            — create a new API key
 * DELETE /api/v1/billing/keys/:id      — revoke a key
 * GET  /api/v1/billing/quota           — current quota status
 * POST /api/v1/billing/webhook/stripe  — Stripe webhook handler
 */

import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── DB availability flag ──────────────────────────────────────────────────────

const DB_AVAILABLE = !!process.env.DATABASE_URL;

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
} as const;

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
    const planKey = currentPlanKey();
    const plan = PLANS[planKey];

    // Real usage aggregation when DB is available
    let tokensUsed = 0;
    let requestsCount = 0;

    if (DB_AVAILABLE) {
      try {
        const { db } = await import("@nexus/db");
        const { usageEvents } = await import("@nexus/db/schema");
        const { sql } = await import("drizzle-orm");
        const periodStart = startDate.toISOString();
        const [row] = await db
          .select({
            total: sql<number>`coalesce(sum(${usageEvents.costUnits}), 0)`,
            count: sql<number>`count(*)`,
          })
          .from(usageEvents)
          .where(sql`${usageEvents.createdAt} >= ${periodStart}`);
        tokensUsed = Number(row?.total ?? 0);
        requestsCount = Number(row?.count ?? 0);
      } catch {
        // DB query failed — serve zeros rather than 500
      }
    }

    return reply.send({
      period: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        tokensUsed,
        tokensLimit: plan.tokensPerMonth,
        requestsCount,
        rpmLimit: plan.rpmLimit,
      },
    });
  });

  /** GET /billing/keys */
  app.get("/billing/keys", { preHandler: requireAuth }, async (_req, reply) => {
    if (!DB_AVAILABLE) {
      return reply.code(503).send({ error: "Database not configured — API key management requires DATABASE_URL" });
    }
    const { listApiKeys } = await import("@nexus/billing");
    const keys = await listApiKeys("global");
    // Strip keyHash from the response — never expose it
    return reply.send({
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        plan: k.plan,
        monthlyQuota: k.monthlyQuota,
        rpmLimit: k.rpmLimit,
        createdAt: k.createdAt,
        revokedAt: k.revokedAt,
      })),
    });
  });

  /** POST /billing/keys */
  app.post<{ Body: { name: string; plan?: "free" | "pro" | "enterprise"; monthlyQuota?: number; rpmLimit?: number } }>(
    "/billing/keys",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!DB_AVAILABLE) {
        return reply.code(503).send({ error: "Database not configured — API key management requires DATABASE_URL" });
      }
      const { createApiKey } = await import("@nexus/billing");
      try {
        const { rawKey, apiKey } = await createApiKey({
          ownerId: "global",
          name: request.body.name,
          plan: request.body.plan ?? "free",
          monthlyQuota: request.body.monthlyQuota,
          rpmLimit: request.body.rpmLimit,
        });
        return reply.code(201).send({
          id: apiKey.id,
          name: apiKey.name,
          rawKey,            // Only shown once at creation time
          keyPrefix: apiKey.keyPrefix,
          plan: apiKey.plan,
          createdAt: apiKey.createdAt,
        });
      } catch (err: unknown) {
        const e = err as { message?: string };
        return reply.code(400).send({ error: e.message });
      }
    },
  );

  /** DELETE /billing/keys/:id */
  app.delete<{ Params: { id: string } }>(
    "/billing/keys/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!DB_AVAILABLE) {
        return reply.code(503).send({ error: "Database not configured — API key management requires DATABASE_URL" });
      }
      const { revokeApiKey } = await import("@nexus/billing");
      try {
        await revokeApiKey(request.params.id);
        return reply.code(204).send();
      } catch (err: unknown) {
        const e = err as { message?: string };
        return reply.code(404).send({ error: e.message ?? "Key not found" });
      }
    },
  );

  /** GET /billing/quota — plan limits + live usage summary */
  app.get("/billing/quota", { preHandler: requireAuth }, async (_req, reply) => {
    const planKey = currentPlanKey();
    const plan = PLANS[planKey];

    let monthlyUsed = 0;
    if (DB_AVAILABLE) {
      try {
        const { db } = await import("@nexus/db");
        const { usageEvents } = await import("@nexus/db/schema");
        const { sql } = await import("drizzle-orm");
        const periodStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
        const [row] = await db
          .select({ total: sql<number>`coalesce(sum(${usageEvents.costUnits}), 0)` })
          .from(usageEvents)
          .where(sql`${usageEvents.createdAt} >= ${periodStart}`);
        monthlyUsed = Number(row?.total ?? 0);
      } catch {
        // serve best-effort zeros
      }
    }

    return reply.send({
      allowed: plan.tokensPerMonth < 0 || monthlyUsed < plan.tokensPerMonth,
      plan: planKey,
      tokensPerMonth: plan.tokensPerMonth,
      tokensUsed: monthlyUsed,
      tokensRemaining: plan.tokensPerMonth < 0 ? null : Math.max(0, plan.tokensPerMonth - monthlyUsed),
      rpmLimit: plan.rpmLimit,
    });
  });

  /** POST /billing/webhook/stripe */
  app.post(
    "/billing/webhook/stripe",
    { config: { rawBody: true } },
    async (request, reply) => {
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret) {
        app.log.warn("STRIPE_WEBHOOK_SECRET not set — skipping signature verification");
      }

      if (DB_AVAILABLE && secret) {
        try {
          const { StripeWebhookProcessor } = await import("@nexus/billing");
          const { db } = await import("@nexus/db");
          const { stripeWebhookEvents } = await import("@nexus/db/schema");
          const processor = new StripeWebhookProcessor({ secret, db, stripeWebhookEvents });
          const rawBody = (request as { rawBody?: string | Buffer }).rawBody ?? JSON.stringify(request.body);
          const sig = request.headers["stripe-signature"] as string | undefined ?? "";
          const result = await processor.process(rawBody.toString(), sig);
          return reply.code(200).send(result);
        } catch (err: unknown) {
          const e = err as { name?: string; message?: string };
          if (e.name === "StripeSignatureError") {
            return reply.code(400).send({ error: "Invalid Stripe signature" });
          }
          app.log.error({ err }, "Stripe webhook processing error");
        }
      }

      // Acknowledge all events when DB or secret is unavailable
      app.log.info({ event: "stripe-webhook" }, "Stripe webhook received (passthrough)");
      return reply.code(200).send({ received: true });
    },
  );
}
