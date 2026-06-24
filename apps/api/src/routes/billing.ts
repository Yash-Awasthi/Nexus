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

import type { FastifyInstance, FastifyReply } from "fastify";

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
    features: [
      "2M tokens/day",
      "All 15 providers",
      "Query + JSONL export",
      "Priority support",
      "Analytics",
    ],
    tokensPerMonth: 60_000_000,
    rpmLimit: 600,
    tier: "pro",
  },
  enterprise: {
    name: "Enterprise",
    price: 199,
    period: "month",
    features: [
      "Unlimited tokens",
      "All 15 providers",
      "HF corpus push",
      "SLA guarantee",
      "SSO + audit logs",
    ],
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
  app.get(
    "/billing/plan",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_req, reply) => {
      const planKey = currentPlanKey();
      return reply.send({ plan: { ...PLANS[planKey], key: planKey } });
    },
  );

  /** GET /billing/current-period */
  app.get(
    "/billing/current-period",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_req, reply) => {
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
          tokensUsed = row?.total ?? 0;
          requestsCount = row?.count ?? 0;
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
    },
  );

  /** GET /billing/keys */
  app.get(
    "/billing/keys",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_req, reply) => {
      if (!DB_AVAILABLE) {
        return (reply as FastifyReply)
          .code(503)
          .send({ error: "Database not configured — API key management requires DATABASE_URL" });
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
    },
  );

  /** POST /billing/keys */
  app.post<{
    Body: {
      name: string;
      plan?: "free" | "pro" | "enterprise";
      monthlyQuota?: number;
      rpmLimit?: number;
    };
  }>(
    "/billing/keys",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            plan: { type: "string", enum: ["free", "pro", "enterprise"] },
            monthlyQuota: { type: "number", minimum: 0 },
            rpmLimit: { type: "number", minimum: 1, maximum: 10_000 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!DB_AVAILABLE) {
        return (reply as FastifyReply)
          .code(503)
          .send({ error: "Database not configured — API key management requires DATABASE_URL" });
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
          rawKey, // Only shown once at creation time
          keyPrefix: apiKey.keyPrefix,
          plan: apiKey.plan,
          createdAt: apiKey.createdAt,
        });
      } catch (err: unknown) {
        const e = err as { message?: string };
        return (reply as FastifyReply).code(400).send({ error: e.message });
      }
    },
  );

  /** DELETE /billing/keys/:id */
  app.delete<{ Params: { id: string } }>(
    "/billing/keys/:id",
    {
      schema: {
        response: { 200: { type: "object", additionalProperties: true }, 204: { type: "null" } },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      if (!DB_AVAILABLE) {
        return (reply as FastifyReply)
          .code(503)
          .send({ error: "Database not configured — API key management requires DATABASE_URL" });
      }
      const { revokeApiKey } = await import("@nexus/billing");
      try {
        await revokeApiKey(request.params.id);
        return (reply as FastifyReply).code(204).send();
      } catch (err: unknown) {
        const e = err as { message?: string };
        return (reply as FastifyReply).code(404).send({ error: e.message ?? "Key not found" });
      }
    },
  );

  /** GET /billing/quota — plan limits + live usage summary */
  app.get(
    "/billing/quota",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_req, reply) => {
      const planKey = currentPlanKey();
      const plan = PLANS[planKey];

      let monthlyUsed = 0;
      if (DB_AVAILABLE) {
        try {
          const { db } = await import("@nexus/db");
          const { usageEvents } = await import("@nexus/db/schema");
          const { sql } = await import("drizzle-orm");
          const periodStart = new Date(
            new Date().getFullYear(),
            new Date().getMonth(),
            1,
          ).toISOString();
          const [row] = await db
            .select({ total: sql<number>`coalesce(sum(${usageEvents.costUnits}), 0)` })
            .from(usageEvents)
            .where(sql`${usageEvents.createdAt} >= ${periodStart}`);
          monthlyUsed = row?.total ?? 0;
        } catch {
          // serve best-effort zeros
        }
      }

      return reply.send({
        allowed: plan.tokensPerMonth < 0 || monthlyUsed < plan.tokensPerMonth,
        plan: planKey,
        tokensPerMonth: plan.tokensPerMonth,
        tokensUsed: monthlyUsed,
        tokensRemaining:
          plan.tokensPerMonth < 0 ? null : Math.max(0, plan.tokensPerMonth - monthlyUsed),
        rpmLimit: plan.rpmLimit,
      });
    },
  );

  // ── Stripe Checkout + Portal ──────────────────────────────────────────────

  /**
   * POST /billing/checkout
   *
   * Creates a Stripe Checkout Session for upgrading to the requested plan.
   * Returns { url } — the frontend must redirect to it.
   *
   * Body: { plan: "pro" | "enterprise"; successUrl?: string; cancelUrl?: string }
   */
  app.post<{
    Body: {
      plan: "pro" | "enterprise";
      successUrl?: string;
      cancelUrl?: string;
    };
  }>(
    "/billing/checkout",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          required: ["plan"],
          properties: {
            plan: { type: "string", enum: ["pro", "enterprise"] },
            successUrl: { type: "string", format: "uri" },
            cancelUrl: { type: "string", format: "uri" },
          },
        },
      },
    },
    async (request, reply) => {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeKey) {
        return (reply as FastifyReply)
          .code(503)
          .send({ error: "Stripe not configured — set STRIPE_SECRET_KEY" });
      }

      // Price IDs from env (set in Stripe dashboard → Product catalog)
      const priceIds: Record<"pro" | "enterprise", string | undefined> = {
        pro: process.env.STRIPE_PRICE_PRO,
        enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
      };
      const priceId = priceIds[request.body.plan];
      if (!priceId) {
        return (reply as FastifyReply).code(503).send({
          error: `STRIPE_PRICE_${request.body.plan.toUpperCase()} env var not set`,
        });
      }

      const origin = process.env.OAUTH_REDIRECT_BASE_URL ?? "http://localhost:5173";
      const successUrl =
        request.body.successUrl ?? `${origin}/billing?session_id={CHECKOUT_SESSION_ID}`;
      const cancelUrl = request.body.cancelUrl ?? `${origin}/billing`;

      try {
        // Lightweight Stripe REST call — no SDK dependency needed
        const body = new URLSearchParams({
          mode: "subscription",
          "line_items[0][price]": priceId,
          "line_items[0][quantity]": "1",
          success_url: successUrl,
          cancel_url: cancelUrl,
          allow_promotion_codes: "true",
          billing_address_collection: "auto",
          customer_email: request.nexusUserId ?? "",
          "subscription_data[metadata][plan]": request.body.plan,
          "subscription_data[metadata][userId]": request.nexusUserId ?? "anon",
        });

        const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${stripeKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        });

        if (!res.ok) {
          const err = (await res.json()) as { error?: { message?: string } };
          return (reply as FastifyReply).code(502).send({
            error: `Stripe error: ${err.error?.message ?? res.statusText}`,
          });
        }

        const session = (await res.json()) as { id: string; url: string };
        return reply.send({ sessionId: session.id, url: session.url });
      } catch (err: unknown) {
        const e = err as { message?: string };
        return (reply as FastifyReply)
          .code(500)
          .send({ error: e.message ?? "Checkout session creation failed" });
      }
    },
  );

  /**
   * POST /billing/portal
   *
   * Creates a Stripe Customer Portal session for managing subscriptions.
   * Requires the user's Stripe customer ID (looked up from DB via userId).
   * Returns { url } — the frontend must redirect to it.
   *
   * Body: { returnUrl?: string }
   */
  app.post<{ Body: { returnUrl?: string } }>(
    "/billing/portal",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          properties: {
            returnUrl: { type: "string", format: "uri" },
          },
        },
      },
    },
    async (request, reply) => {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeKey) {
        return (reply as FastifyReply)
          .code(503)
          .send({ error: "Stripe not configured — set STRIPE_SECRET_KEY" });
      }

      const origin = process.env.OAUTH_REDIRECT_BASE_URL ?? "http://localhost:5173";
      const returnUrl = request.body.returnUrl ?? `${origin}/billing`;

      // Resolve Stripe customer ID from DB
      let customerId: string | undefined;
      if (DB_AVAILABLE && request.nexusUserId) {
        try {
          const { db } = await import("@nexus/db");
          const { subscriptions } = await import("@nexus/db/schema");
          const { eq } = await import("drizzle-orm");
          const [row] = await db
            .select({ stripeCustomerId: subscriptions.stripeCustomerId })
            .from(subscriptions)
            .where(eq(subscriptions.ownerId, request.nexusUserId))
            .limit(1);
          customerId = row?.stripeCustomerId ?? undefined;
        } catch {
          // DB lookup failed — fall through to 503
        }
      }

      if (!customerId) {
        return (reply as FastifyReply).code(404).send({
          error: "No Stripe customer linked to this account. Complete a checkout first.",
        });
      }

      try {
        const body = new URLSearchParams({
          customer: customerId,
          return_url: returnUrl,
        });

        const res = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${stripeKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        });

        if (!res.ok) {
          const err = (await res.json()) as { error?: { message?: string } };
          return (reply as FastifyReply).code(502).send({
            error: `Stripe error: ${err.error?.message ?? res.statusText}`,
          });
        }

        const session = (await res.json()) as { url: string };
        return reply.send({ url: session.url });
      } catch (err: unknown) {
        const e = err as { message?: string };
        return (reply as FastifyReply)
          .code(500)
          .send({ error: e.message ?? "Portal session creation failed" });
      }
    },
  );

  // ── Subscription / Usage / Cancel ──────────────────────────────────────────

  app.get<{ Params: { tenantId: string } }>(
    "/billing/subscription/:tenantId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { tenantId } = request.params;
      if (!DB_AVAILABLE) {
        return reply.send({ id: null, tenantId, planId: "free", status: "active" });
      }
      try {
        const { db: billingDb } = await import("@nexus/db");
        const { subscriptions } = await import("@nexus/db/schema");
        const { eq } = await import("drizzle-orm");
        const [sub] = await billingDb
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.ownerId, tenantId))
          .limit(1);
        if (!sub) return reply.send({ id: null, tenantId, planId: "free", status: "active" });
        return reply.send({
          id: sub.id,
          tenantId: sub.ownerId,
          planId: sub.plan,
          status: sub.status,
          currentPeriodEnd: sub.currentPeriodEnd
            ? new Date(sub.currentPeriodEnd as unknown as number * 1000).toISOString()
            : undefined,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          stripeCustomerId: sub.stripeCustomerId,
        });
      } catch (err: unknown) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { tenantId: string } }>(
    "/billing/usage/:tenantId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString();
      if (!DB_AVAILABLE) {
        return reply.send({ requests: 0, tokensIn: 0, tokensOut: 0, cost: 0, periodStart, periodEnd });
      }
      try {
        const { db: billingDb } = await import("@nexus/db");
        const { usageEvents } = await import("@nexus/db/schema");
        const { sql } = await import("drizzle-orm");
        const [row] = await billingDb
          .select({
            requests: sql<number>`count(*)`,
            cost: sql<number>`coalesce(sum(${usageEvents.costUnits}), 0)`,
          })
          .from(usageEvents)
          .where(sql`${usageEvents.createdAt} >= ${periodStart}`);
        return reply.send({
          requests: row?.requests ?? 0,
          tokensIn: 0,
          tokensOut: 0,
          cost: (row?.cost ?? 0) / 1_000_000,
          periodStart,
          periodEnd,
        });
      } catch (err: unknown) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { tenantId: string } }>(
    "/billing/cancel/:tenantId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { tenantId } = request.params;
      if (!DB_AVAILABLE) return reply.code(503).send({ error: "Database not configured" });
      try {
        const { db: billingDb } = await import("@nexus/db");
        const { subscriptions } = await import("@nexus/db/schema");
        const { eq } = await import("drizzle-orm");
        const [sub] = await billingDb
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.ownerId, tenantId))
          .limit(1);
        if (!sub) return reply.code(404).send({ error: "No subscription found" });
        await billingDb
          .update(subscriptions)
          .set({ cancelAtPeriodEnd: true })
          .where(eq(subscriptions.id, sub.id));
        return reply.send({ ok: true, cancelAtPeriodEnd: true });
      } catch (err: unknown) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    },
  );

  /** POST /billing/webhook/stripe */
  app.post(
    "/billing/webhook/stripe",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      config: { rawBody: true },
    },
    async (request, reply) => {
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret) {
        app.log.warn("STRIPE_WEBHOOK_SECRET not set — skipping signature verification");
      }

      if (DB_AVAILABLE && secret) {
        try {
          const { StripeWebhookProcessor } = await import("@nexus/billing");
          const processor = new StripeWebhookProcessor(secret);
          const rawBody =
            (request as { rawBody?: string | Buffer }).rawBody ?? JSON.stringify(request.body);
          const sig = (request.headers["stripe-signature"] as string | undefined) ?? "";
          const result = await processor.process(rawBody.toString(), sig);
          return reply.code(200).send(result);
        } catch (err: unknown) {
          const e = err as { name?: string; message?: string };
          if (e.name === "StripeSignatureError") {
            return (reply as FastifyReply).code(400).send({ error: "Invalid Stripe signature" });
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
