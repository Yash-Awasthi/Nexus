// SPDX-License-Identifier: Apache-2.0
/**
 * Billing routes — plan info, usage metering, API key management.
 *
 * Nexus is free and open to all: there is no paid plan and no payment provider.
 * These endpoints only report the single open plan and meter usage of the user's
 * own BYOK keys. API key CRUD is backed by Drizzle ORM → Neon Postgres (via
 * @nexus/billing). When DATABASE_URL is not set the key endpoints return 503.
 *
 * GET  /api/v1/billing/plan            — the open plan definition
 * GET  /api/v1/billing/current-period  — usage for current period
 * GET  /api/v1/billing/keys            — list API keys for the authenticated owner
 * POST /api/v1/billing/keys            — create a new API key
 * DELETE /api/v1/billing/keys/:id      — revoke a key
 * GET  /api/v1/billing/quota           — current quota status
 */

import type { FastifyInstance, FastifyReply } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── DB availability flag ──────────────────────────────────────────────────────

const DB_AVAILABLE = !!process.env.DATABASE_URL;

// ── Static plan definitions ───────────────────────────────────────────────────

// Nexus is free and open to all — a single, unlimited plan. No paid tiers.
// tokensPerMonth: -1 and rpmLimit: 0 are both treated as "unlimited" downstream.
const PLANS = {
  free: {
    name: "Open",
    price: 0,
    period: "month",
    features: [
      "Unlimited tokens",
      "All providers (bring your own keys)",
      "Full API access",
      "Community support",
    ],
    tokensPerMonth: -1,
    rpmLimit: 0,
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

  // ── Usage ──────────────────────────────────────────────────────────────────

  app.get<{ Params: { tenantId: string } }>(
    "/billing/usage/:tenantId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString();
      if (!DB_AVAILABLE) {
        return reply.send({
          requests: 0,
          tokensIn: 0,
          tokensOut: 0,
          cost: 0,
          periodStart,
          periodEnd,
        });
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
}
