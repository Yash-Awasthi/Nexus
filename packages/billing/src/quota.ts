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

// ── Result types ──────────────────────────────────────────────────────────────

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: "monthly_quota_exceeded" | "rpm_limit_exceeded";
  /** Current monthly usage (only populated for monthly checks) */
  monthlyUsage?: number;
  /** Remaining monthly quota (null if unlimited) */
  monthlyRemaining?: number | null;
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
   */
  async check(apiKey: ApiKey): Promise<QuotaCheckResult> {
    // RPM check first — fast, in-process
    if (apiKey.rpmLimit !== null && apiKey.rpmLimit > 0) {
      const allowed = checkRpm(apiKey.id, apiKey.rpmLimit);
      if (!allowed) {
        return { allowed: false, reason: "rpm_limit_exceeded" };
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
   * Record one (or more cost units of) usage for metering.
   * Call this after the handler succeeds — fire-and-forget is fine.
   */
  async recordUsage(apiKeyId: string, endpoint: string, costUnits = 1): Promise<void> {
    await db.insert(usageEvents).values({ apiKeyId, endpoint, costUnits });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function startOfCurrentMonth(): Date {
  const now = new Date();
  return new Date(now.getUTCFullYear(), now.getUTCMonth(), 1);
}
