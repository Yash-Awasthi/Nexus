// SPDX-License-Identifier: Apache-2.0
/**
 * Quota enforcement — framework-agnostic.
 *
 * QuotaChecker answers two questions:
 *   1. Has the API key exceeded its monthly request quota?
 *   2. Has the API key exceeded its per-minute rate limit (RPM)?
 *
 * It reads from usage_events for monthly quota and a lightweight in-process
 * sliding window for RPM (good enough for single-instance deployments; swap
 * to Redis for multi-instance).
 */

import { db } from "@nexus/db";
import type { ApiKey } from "@nexus/db/schema";
import { usageEvents } from "@nexus/db/schema";
import { sql } from "drizzle-orm";

import { BillingLedger, QuotaExceededError, computeCost, type TokenUsage } from "./cost.js";

// ── Result types ──────────────────────────────────────────────────────────────

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: "monthly_quota_exceeded" | "rpm_limit_exceeded" | "monthly_cost_cap_exceeded";
  /** Current monthly usage (only populated for monthly checks) */
  monthlyUsage?: number;
  /** Remaining monthly quota (null if unlimited) */
  monthlyRemaining?: number | null;
  /** Month-to-date BYOK spend in USD (only populated for cost-cap checks) */
  monthlyCostUsd?: number;
  /** The configured monthly USD cap (only populated for cost-cap checks) */
  monthlyCostCapUsd?: number;
}

/** Optional per-request detail for {@link QuotaChecker.recordUsage}. */
export interface UsageDetail {
  /** Logical cost units (default 1). */
  costUnits?: number;
  /** Model id the call hit — priced via provider-registry when given. */
  model?: string;
  /** Token breakdown (input/output/cache) for this request. */
  usage?: TokenUsage;
  /** Pre-computed USD cost; overrides the model-derived price when set. */
  costUsd?: number;
}

// ── RPM sliding window (in-process) ──────────────────────────────────────────

const rpmWindows = new Map<string, number[]>();

function checkRpm(apiKeyId: string, limit: number): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const timestamps = (rpmWindows.get(apiKeyId) ?? []).filter((t) => now - t < windowMs);
  if (timestamps.length >= limit) return false;
  timestamps.push(now);
  rpmWindows.set(apiKeyId, timestamps);
  return true;
}

// ── QuotaChecker ──────────────────────────────────────────────────────────────

export class QuotaChecker {
  /**
   * Check whether the given API key may make another request.
   *
   * This does NOT record usage — call recordUsage() after the request
   * completes to keep metering accurate.
   *
   * `estimatedUsd` is the worst-case price of the upcoming call (see
   * estimateMaxCost). When given alongside a per-key USD cap, the ledger
   * reserves it pre-call so an over-cap request is rejected before any provider
   * call is made; omit it to only reject keys already at/over their cap.
   */
  async check(apiKey: ApiKey, estimatedUsd?: number): Promise<QuotaCheckResult> {
    // RPM check first — fast, in-process
    if (apiKey.rpmLimit !== null && apiKey.rpmLimit > 0) {
      const allowed = checkRpm(apiKey.id, apiKey.rpmLimit);
      if (!allowed) {
        return { allowed: false, reason: "rpm_limit_exceeded" };
      }
    }

    // BYOK USD spend-cap check — seed a ledger with month-to-date spend and
    // reserve the estimate against the cap (the pre-call ledger gate).
    const cap = apiKey.monthlyCostCapUsd;
    if (cap !== null && cap !== undefined && cap > 0) {
      const monthlyCostUsd = await this.monthToDateCostUsd(apiKey.id);
      const ledger = new BillingLedger(cap, `api_key:${apiKey.id}`);
      ledger.settle("mtd", monthlyCostUsd); // register committed spend
      try {
        ledger.reserve("next", estimatedUsd ?? 0);
        // reserve(0) passes when exactly at cap — treat depleted headroom as exceeded.
        if (ledger.remaining !== null && ledger.remaining <= 0) {
          return {
            allowed: false,
            reason: "monthly_cost_cap_exceeded",
            monthlyCostUsd,
            monthlyCostCapUsd: cap,
          };
        }
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          return {
            allowed: false,
            reason: "monthly_cost_cap_exceeded",
            monthlyCostUsd,
            monthlyCostCapUsd: cap,
          };
        }
        throw err;
      }
    }

    // Monthly quota check — DB query
    if (apiKey.monthlyQuota !== null && apiKey.monthlyQuota > 0) {
      const periodStart = startOfCurrentMonth();

      const [row] = await db
        .select({ total: sql<number>`coalesce(sum(${usageEvents.costUnits}), 0)` })
        .from(usageEvents)
        .where(
          sql`${usageEvents.apiKeyId} = ${apiKey.id}
              AND ${usageEvents.createdAt} >= ${periodStart.toISOString()}`,
        );

      const monthlyUsage = row?.total ?? 0;
      const monthlyRemaining = apiKey.monthlyQuota - monthlyUsage;

      if (monthlyRemaining <= 0) {
        return {
          allowed: false,
          reason: "monthly_quota_exceeded",
          monthlyUsage,
          monthlyRemaining: 0,
        };
      }

      return { allowed: true, monthlyUsage, monthlyRemaining };
    }

    return { allowed: true };
  }

  /**
   * Record one usage event for metering. Call after the handler succeeds —
   * fire-and-forget is fine.
   *
   * `detail` is back-compat: a bare number is the legacy `costUnits`; an object
   * carries the token breakdown + model, and the USD cost is priced from the
   * provider-registry (or taken from `detail.costUsd` when supplied).
   */
  async recordUsage(
    apiKeyId: string,
    endpoint: string,
    detail: number | UsageDetail = {},
  ): Promise<void> {
    const d: UsageDetail = typeof detail === "number" ? { costUnits: detail } : detail;
    const usage = d.usage;
    const costUsd = d.costUsd ?? (d.model ? computeCost(d.model, usage ?? {}).totalCost : 0);
    await db.insert(usageEvents).values({
      apiKeyId,
      endpoint,
      costUnits: d.costUnits ?? 1,
      model: d.model ?? null,
      promptTokens: usage?.inputTokens ?? 0,
      completionTokens: usage?.outputTokens ?? 0,
      cacheReadTokens: usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
      costUsd,
    });
  }

  /** Sum of priced USD spend for an API key since the start of this month. */
  async monthToDateCostUsd(apiKeyId: string): Promise<number> {
    const periodStart = startOfCurrentMonth();
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)` })
      .from(usageEvents)
      .where(
        sql`${usageEvents.apiKeyId} = ${apiKeyId}
            AND ${usageEvents.createdAt} >= ${periodStart.toISOString()}`,
      );
    return row?.total ?? 0;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function startOfCurrentMonth(): Date {
  const now = new Date();
  return new Date(now.getUTCFullYear(), now.getUTCMonth(), 1);
}
