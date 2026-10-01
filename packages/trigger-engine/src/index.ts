// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduled triggers: a five-field cron or an interval, fired at most once per minute. The
 * caller runs `isDue` on each tick and records `minuteKey(at)` when it fires.
 */
import { cronMatches } from "./cron.js";

export { cronMatches, nextCronRun, parseCron } from "./cron.js";

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
