// SPDX-License-Identifier: Apache-2.0
/**
 * Weekly digest — the "worth returning to" mechanic for the dashboard.
 *
 * Delivered as a normal notification through the live tray (createNotification
 * publishes on the SSE bus, so it pops as a toast on first access of a new
 * week — no scheduler, no cron).
 *
 * Semantics (compute-on-read):
 *   - On the first dashboard load of a new week (Monday-start week key), the
 *     stats for the most recently COMPLETED calendar week (Monday–Sunday) are
 *     rolled up and emitted ONCE — e.g. activity from Aug 31–Sep 6 is reported
 *     by the first load after Mon Sep 7. The week key is recorded BEFORE
 *     computing so repeated loads can never double-emit.
 *   - A week with zero activity is marked silently (no "nothing happened"
 *     noise) — the digest only reports when there is something to report.
 *
 * Scope note: the underlying stores (_costLog, research jobs, autopilot runs)
 * are workspace-level, so the digest rolls up the workspace and delivers the
 * notification per user. That matches the product's actual shape (one
 * workspace per install); a per-user cost log would be the follow-up.
 */

import { createNotification, userIdFor, type AppNotification } from "./notifications-store.js";
import { getSharedKV } from "./shared-kv.js";

export interface WeeklyStats {
  requests: number;
  tokens: number;
  costUsd: number;
  /** Model with the highest spend in the window, if any. */
  topModel?: string;
  researchCount: number;
  autopilotRuns: number;
}

/** Monday-start week key, e.g. "2026-08-31". Stable weekly boundary. */
export function weekKey(d: Date = new Date()): string {
  const date = new Date(d);
  // getDay(): 0=Sun..6=Sat → shift so 0=Mon, then subtract to Monday.
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

const DIGEST_MARKER_TTL_MS = 90 * 24 * 60 * 60 * 1000; // a stale marker is never equal to the current week anyway

function fmtTokens(t: number): string {
  if (t >= 1_000_000) return `${(t / 1_000_000).toFixed(1)}M`;
  if (t >= 1_000) return `${(t / 1_000).toFixed(1)}k`;
  return String(t);
}

/**
 * Emit the weekly digest at most once per calendar week, on first access of a
 * new week. Stats cover the most recently completed calendar week
 * (weekKey(now) − 7 days … weekKey(now)). `now` is injectable for tests.
 *
 * Returns the created notification, or null when the week was already handled
 * or there was nothing to report.
 */
export async function maybeEmitWeeklyDigest(
  userId: string | undefined,
  computeStats: (startDate: string, endDate: string) => Promise<WeeklyStats>,
  now: Date = new Date(),
): Promise<AppNotification | null> {
  const kv = getSharedKV();
  const markerKey = `notif:digest:${userIdFor(userId)}`;
  const currentWeek = weekKey(now);
  const last = await kv.get<string>(markerKey);
  if (last === currentWeek) return null;

  // Record the week BEFORE computing: even a quiet or failed week counts as
  // handled, so a later mid-week load cannot emit a partial-week digest.
  await kv.set(markerKey, currentWeek, DIGEST_MARKER_TTL_MS);

  const start = new Date(currentWeek + "T00:00:00Z");
  start.setUTCDate(start.getUTCDate() - 7);
  const weekStart = start.toISOString().slice(0, 10);

  const stats = await computeStats(weekStart, currentWeek);
  if (
    stats.requests === 0 &&
    stats.researchCount === 0 &&
    stats.autopilotRuns === 0
  ) {
    return null; // quiet week — marked, but no noise
  }

  const parts: string[] = [];
  if (stats.requests > 0) parts.push(`${stats.requests} request${stats.requests > 1 ? "s" : ""}`);
  if (stats.researchCount > 0) parts.push(`${stats.researchCount} deep research run${stats.researchCount > 1 ? "s" : ""}`);
  if (stats.autopilotRuns > 0)
    parts.push(`${stats.autopilotRuns} autopilot run${stats.autopilotRuns > 1 ? "s" : ""}`);
  if (stats.tokens > 0) parts.push(`${fmtTokens(stats.tokens)} tokens`);
  if (stats.costUsd > 0) parts.push(`$${stats.costUsd.toFixed(2)}`);
  let message = parts.join(" · ");
  if (stats.topModel) message += ` — top model ${stats.topModel}`;

  return createNotification(userId, {
    type: "digest",
    title: "Your week in Nexus",
    message,
    link: "/",
  });
}