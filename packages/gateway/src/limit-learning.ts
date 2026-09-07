// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/gateway — learned rate-limit ceilings + 429 cooldown bench.
 *
 * Faithful port of FreeLLMAPI's rate-limit learning (row 212) — the
 * "self-correcting" half that adapts to observed 429/limit responses instead
 * of trusting fixed ceilings:
 *
 *   1. **CeilingStore** — learn a provider's real per-key-per-model ceiling
 *      (RPM/RPD/TPM/TPD) from the *text of a rate-limit response* (e.g. Groq's
 *      `413 ... Limit 30000, Requested 33476`). Learning is conservative by
 *      construction: a new observation fills an unknown ceiling or LOWERS one
 *      that proved too high, and never raises one — hitting a ceiling means
 *      the pre-check already let too much through. Ported from
 *      ratelimit.ts `parseProviderLimit`/`learnLimitFromError`.
 *   2. **CooldownTracker** — decide how long a provider+model+key is benched
 *      after an upstream 429. Escalating ladder (2m → 10m → 1h → 24h within a
 *      rolling 24h) for daily-exhausted routes; a short fixed bench for
 *      transient per-minute 429s; a capped 10-minute guess when limits are
 *      unknown (2+ hits/hour heuristic); an explicit Retry-After header is
 *      authoritative and overrides the ladder. A successful request clears the
 *      hit history so the next 429 restarts the ladder short (reversibility —
 *      a served request proves the quota is not exhausted right now). Ported
 *      from ratelimit.ts escalation ladder + base.ts `parseRetryAfterMs`.
 *
 * Divergences (documented, not hidden): FreeLLMAPI persists ceilings and
 * daily counters in SQLite and observes `x-ratelimit-*` headers with
 * confidence weighting — those DB-backed halves (quota observation rows,
 * header confidence, canMakeRequest/canUseTokens pre-checks) are server
 * machinery and stay out. The in-process store here is the conservative
 * learning rule and the bench decisions only.
 */

// ── 1. Error-body limit learning ─────────────────────────────────────────────

export type LimitAxis = "rpm" | "rpd" | "tpm" | "tpd";

export interface LearnedLimit {
  axis: LimitAxis;
  limit: number;
}

// Order matters, per the source: check the per-DAY axes before per-MINUTE so
// "tokens per day" is not shadowed by the "tpm" word boundary, and tokens
// before requests so a body mentioning both lands on the token ceiling.
const LIMIT_AXIS_PATTERNS: Array<{ axis: LimitAxis; re: RegExp }> = [
  { axis: "tpd", re: /tokens?\s*per\s*day|\btpd\b/i },
  { axis: "tpm", re: /tokens?\s*per\s*min(?:ute)?|\btpm\b/i },
  { axis: "rpd", re: /requests?\s*per\s*day|\brpd\b/i },
  { axis: "rpm", re: /requests?\s*per\s*min(?:ute)?|\brpm\b/i },
];

/**
 * Pure parser: pull a provider-reported ceiling out of an error message.
 * Returns null unless BOTH a numeric "Limit N" and a confident axis are
 * present — guessing the axis would write the wrong ceiling and mis-route
 * every future request, so we refuse to guess.
 */
export function parseProviderLimit(message: string | null | undefined): LearnedLimit | null {
  if (!message) return null;
  const m = message.match(/\blimit[:,\s]+([\d,]+)/i);
  if (!m) return null;
  const limit = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(limit) || limit <= 0) return null;
  for (const { axis, re } of LIMIT_AXIS_PATTERNS) {
    if (re.test(message)) return { axis, limit };
  }
  return null;
}

/** Route key — one learning/bench domain per provider+model+key. */
export function routeKey(provider: string, model: string, key: string): string {
  return `${provider}:${model}:${key}`;
}

export type CeilingScope = { provider: string; model: string; key: string };

/**
 * In-memory conservative ceiling store, keyed per provider+model+key.
 * `observe` learns from a rate-limit response body; `apply` is the raw
 * conservative rule (fill unknown / lower too-high, never raise).
 */
export class CeilingStore {
  private readonly _limits = new Map<string, Partial<Record<LimitAxis, number>>>();

  /** Learn a ceiling from a rate-limit/413 error body. No-op unless parseable. */
  observe(scope: CeilingScope, message: string | null | undefined): LearnedLimit | null {
    const parsed = parseProviderLimit(message);
    if (!parsed) return null;
    return this.apply(scope, parsed.axis, parsed.limit);
  }

  /**
   * Apply a learned ceiling conservatively: fills a NULL (unknown) limit or
   * lowers an existing one that was too high. Never raises — hitting a
   * ceiling means the pre-check already let too much through, so the true
   * limit is at or below what was used. Returns the change when applied.
   */
  apply(scope: CeilingScope, axis: LimitAxis, limit: number): LearnedLimit | null {
    if (!Number.isFinite(limit) || limit <= 0) return null;
    const k = routeKey(scope.provider, scope.model, scope.key);
    const entry = this._limits.get(k) ?? {};
    const existing = entry[axis];
    if (existing !== undefined && existing <= limit) return null; // never raise
    entry[axis] = limit;
    this._limits.set(k, entry);
    return { axis, limit };
  }

  /** Current known ceiling, or null when unknown (starts conservative: no ceiling assumed). */
  get(scope: CeilingScope, axis: LimitAxis): number | null {
    return this._limits.get(routeKey(scope.provider, scope.model, scope.key))?.[axis] ?? null;
  }

  /** Ceiling for a route, or a caller-supplied default when never learned. */
  getOrDefault(scope: CeilingScope, axis: LimitAxis, fallback: number): number {
    return this.get(scope, axis) ?? fallback;
  }

  clear(scope: CeilingScope): void {
    this._limits.delete(routeKey(scope.provider, scope.model, scope.key));
  }
}

// ── 2. 429 cooldown bench ────────────────────────────────────────────────────

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Transient per-minute 429 → short fixed bench, recovers within ~one window. */
const TRANSIENT_COOLDOWN_MS = 90_000;

/** Guessed (unknown-limits) verdicts cap at the ladder's 10-minute step. */
const UNKNOWN_LIMIT_MAX_COOLDOWN_MS = 10 * MINUTE_MS;

/** Unknown-limit heuristic: 2+ 429s within this rolling window = "effectively exhausted". */
const NULL_LIMIT_HIT_THRESHOLD = 2;
const NULL_LIMIT_HIT_WINDOW_MS = HOUR_MS;

/** Escalating ladder: daily-quota exhaustion quarantines instead of looping 90s benches. */
const COOLDOWN_DURATIONS_MS = [
  2 * MINUTE_MS, // 1st escalation-grade hit in 24h
  10 * MINUTE_MS, // 2nd
  HOUR_MS, // 3rd
  DAY_MS, // 4th and beyond
];

export type BenchGrade = "transient" | "exhausted" | "unknown";

export type BenchSource = "heuristic" | "authoritative";

export interface BenchVerdict {
  durationMs: number;
  source: BenchSource;
}

export interface RateLimitedInput {
  /** Retry-After header value (seconds or HTTP-date). When present it is authoritative. */
  retryAfterMs?: number;
  /**
   * Why this 429 occurred: 'transient' (per-minute jitter, limits known and
   * daily counters healthy → short bench, no escalation), 'exhausted'
   * (measured daily-quota exhaustion → escalation ladder), 'unknown'
   * (provider publishes no limits → 2+/hour hit heuristic, capped guess).
   */
  grade: BenchGrade;
}

interface RouteState {
  hits: number[]; // timestamps of escalation-grade 429s, rolling 24h
  nullHits: number[]; // timestamps of unknown-grade 429s, rolling 1h
  benchUntil: number;
}

/**
 * Decides and remembers how long a provider+model+key stays benched after an
 * upstream 429. Retry-After is authoritative; otherwise the verdict is a
 * heuristic (transient 90s, escalation ladder, or capped unknown-limit guess).
 * A successful request clears the hit history and the bench.
 */
export class CooldownTracker {
  private readonly _routes = new Map<string, RouteState>();

  private state(route: string): RouteState {
    let s = this._routes.get(route);
    if (!s) {
      s = { hits: [], nullHits: [], benchUntil: 0 };
      this._routes.set(route, s);
    }
    return s;
  }

  /** Current bench remaining (ms) for the route, 0 when not benched. */
  benchRemainingMs(route: string, now = Date.now()): number {
    const s = this._routes.get(route);
    if (!s) return 0;
    return Math.max(0, s.benchUntil - now);
  }

  isBenched(route: string, now = Date.now()): boolean {
    return this.benchRemainingMs(route, now) > 0;
  }

  /**
   * Record an upstream 429 and return how long the route is benched.
   * Re-escalates on repeated calls while benched (each 429 after expiry that
   * is still failing re-climbs the ladder, matching the source).
   */
  recordRateLimited(route: string, input: RateLimitedInput, now = Date.now()): BenchVerdict {
    const s = this.state(route);

    // Authoritative retry time wins: not a guess, never escalated past it.
    if (input.retryAfterMs !== undefined && input.retryAfterMs > 0) {
      s.benchUntil = now + input.retryAfterMs;
      return { durationMs: input.retryAfterMs, source: "authoritative" };
    }

    if (input.grade === "transient") {
      // Healthy daily counters + a per-minute blip: short bench, no escalation.
      s.benchUntil = now + TRANSIENT_COOLDOWN_MS;
      return { durationMs: TRANSIENT_COOLDOWN_MS, source: "heuristic" };
    }

    if (input.grade === "unknown") {
      // No published limits: escalate only after 2+ 429s within the window,
      // and never beyond the capped guess (a genuinely dead route just
      // re-benches every 10 minutes instead of hammering the 90s loop).
      s.nullHits.push(now);
      s.nullHits = s.nullHits.filter((t) => t > now - NULL_LIMIT_HIT_WINDOW_MS);
      if (s.nullHits.length < NULL_LIMIT_HIT_THRESHOLD) {
        s.benchUntil = now + TRANSIENT_COOLDOWN_MS;
        return { durationMs: TRANSIENT_COOLDOWN_MS, source: "heuristic" };
      }
      const durationMs = Math.min(this.recordEscalationHit(s, now), UNKNOWN_LIMIT_MAX_COOLDOWN_MS);
      s.benchUntil = now + durationMs;
      return { durationMs, source: "heuristic" };
    }

    // 'exhausted' — measured daily-quota exhaustion: climb the full ladder.
    const durationMs = this.recordEscalationHit(s, now);
    s.benchUntil = now + durationMs;
    return { durationMs, source: "heuristic" };
  }

  /**
   * A successful request proves the quota is NOT exhausted right now: clears
   * the hit history so the next failure starts the ladder over instead of
   * inheriting up-to-24h steps from stale hits.
   */
  onSuccess(route: string): void {
    const s = this._routes.get(route);
    if (!s) return;
    s.hits = [];
    s.nullHits = [];
    s.benchUntil = 0;
  }

  clear(route: string): void {
    this._routes.delete(route);
  }

  /** Record an escalation-grade hit and return the ladder step for the rolling 24h window. */
  private recordEscalationHit(s: RouteState, now: number): number {
    const fresh = [...s.hits.filter((t) => t > now - DAY_MS), now];
    s.hits = fresh;
    const idx = Math.min(fresh.length - 1, COOLDOWN_DURATIONS_MS.length - 1);
    return COOLDOWN_DURATIONS_MS[idx]!;
  }
}

// ── 3. Retry-After parsing (header) ──────────────────────────────────────────

/** Clamp like the source: no single retry hint benches longer than a day. */
export const MAX_RETRY_AFTER_MS = DAY_MS;

/**
 * Parse a Retry-After header value — either integer seconds or an HTTP-date —
 * into clamped milliseconds. Returns undefined for anything else.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) {
    return Math.min(Math.max(0, when - Date.now()), MAX_RETRY_AFTER_MS);
  }
  return undefined;
}
