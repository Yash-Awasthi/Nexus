// SPDX-License-Identifier: Apache-2.0
/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week):
 * `*`, numbers, `a-b` ranges, `,` lists and `/n` steps; day-of-week 7 is Sunday.
 * No names or `L`/`W`.
 */

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Cron's rule: when both day fields are restricted, a day matching either one runs. */
  dayOr: boolean;
}

function field(spec: string, [lo, hi]: [number, number]): Set<number> | null {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const from = m[1] === "*" ? lo : Number(m[2]);
    const to = m[1] === "*" ? hi : m[3] !== undefined ? Number(m[3]) : m[4] ? hi : from;
    const step = m[4] ? Number(m[4]) : 1;
    if (from < lo || to > hi || from > to || step < 1) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

function compile(expr: string): Cron | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const f = parts.map((p, i) => field(p, RANGES[i]!));
  if (!f.every(Boolean)) return null;
  const [minute, hour, dom, month, dow] = f as Set<number>[];
  if (dow!.delete(7)) dow!.add(0);
  return {
    minute: minute!,
    hour: hour!,
    dom: dom!,
    month: month!,
    dow: dow!,
    dayOr: !parts[2]!.startsWith("*") && !parts[4]!.startsWith("*"),
  };
}

/** Parsed fields, or null when the expression is not valid. */
export function parseCron(expr: string): Set<number>[] | null {
  const c = compile(expr);
  return c ? [c.minute, c.hour, c.dom, c.month, c.dow] : null;
}

function dayMatches(c: Cron, at: Date): boolean {
  if (!c.month.has(at.getMonth() + 1)) return false;
  const dom = c.dom.has(at.getDate());
  const dow = c.dow.has(at.getDay());
  return c.dayOr ? dom || dow : dom && dow;
}

export function cronMatches(expr: string, at: Date): boolean {
  const c = compile(expr);
  return !!c && dayMatches(c, at) && c.hour.has(at.getHours()) && c.minute.has(at.getMinutes());
}

/** The next minute after `from` that the expression matches, within five years (leap days). */
export function nextCronRun(expr: string, from: Date): Date | null {
  const c = compile(expr);
  if (!c) return null;
  const t = new Date(from);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const until = new Date(t);
  until.setFullYear(until.getFullYear() + 5);
  while (t < until) {
    if (!dayMatches(c, t)) {
      t.setHours(0, 0, 0, 0);
      t.setDate(t.getDate() + 1);
    } else if (!c.hour.has(t.getHours())) {
      t.setMinutes(0);
      t.setHours(t.getHours() + 1);
    } else if (!c.minute.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1);
    } else return new Date(t);
  }
  return null;
}
