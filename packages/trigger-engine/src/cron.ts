// SPDX-License-Identifier: Apache-2.0
/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week):
 * `*`, numbers, `a-b` ranges, `,` lists and `/n` steps. No names or `L`/`W`.
 */

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

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

/** Parsed fields, or null when the expression is not valid. */
export function parseCron(expr: string): Set<number>[] | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = parts.map((p, i) => field(p, RANGES[i]!));
  return fields.every(Boolean) ? (fields as Set<number>[]) : null;
}

export function cronMatches(expr: string, at: Date): boolean {
  const f = parseCron(expr);
  if (!f) return false;
  return (
    f[0]!.has(at.getMinutes()) &&
    f[1]!.has(at.getHours()) &&
    f[2]!.has(at.getDate()) &&
    f[3]!.has(at.getMonth() + 1) &&
    f[4]!.has(at.getDay())
  );
}

/** The next minute after `from` that the expression matches, within a year. */
export function nextCronRun(expr: string, from: Date): Date | null {
  if (!parseCron(expr)) return null;
  const t = new Date(from);
  t.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    t.setMinutes(t.getMinutes() + 1);
    if (cronMatches(expr, t)) return new Date(t);
  }
  return null;
}
