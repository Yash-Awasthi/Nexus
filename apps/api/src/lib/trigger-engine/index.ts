// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduled triggers: a five-field cron or an interval, fired at most once per minute. The
 * caller runs `isDue` on each tick and records `minuteKey(at)` when it fires.
 *
 * Folded in from `@nexus/trigger-engine` (ADR 0025): no runtime dependency, two importers, both here.
 */
import { cronMatches } from "./cron.ts";

export { cronMatches, nextCronRun, parseCron } from "./cron.ts";

/** The minute a tick falls in, as stored in `lastFiredMinute`. */
export function minuteKey(at: Date): string {
  return at.toISOString().slice(0, 16);
}

export interface Trigger {
  cron?: string | null;
  /** Fire when this long has passed since `since`; ignored when `cron` is set. */
  intervalSec?: number;
  since?: Date | number;
  lastFiredMinute?: string | null;
}

export function isDue(t: Trigger, at: Date): boolean {
  if (t.lastFiredMinute === minuteKey(at)) return false;
  if (t.cron) return cronMatches(t.cron, at);
  if (!t.intervalSec || t.since === undefined) return false;
  return at.getTime() - new Date(t.since).getTime() >= t.intervalSec * 1000;
}
