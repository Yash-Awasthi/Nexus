// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/llm-accounts — Multi-account pool + tier ladder for LLM providers.
 *
 * A provider (anthropic, openai, …) may have several credentials of differing
 * value: a paid **subscription** key, a **cheap** pay-as-you-go key, a **free**
 * key. This pool tracks per-account health, cooldown and quota, and routes each
 * request to the healthiest highest-tier account that still fits — falling back
 * down the ladder (sub → cheap → free) as accounts get rate-limited, exhaust
 * their quota, or trip their circuit breaker.
 *
 * Pure and deterministic under injection: pass `now`/`random` to make routing,
 * cooldown backoff and jitter fully testable. No network, no dependencies.
 */

// ── Tiers ──────────────────────────────────────────────────────────────────────

/** Account value tiers, best first. */
export type AccountTier = "sub" | "cheap" | "free";

/** Preference order — lower rank = higher tier. */
const TIER_RANK: Record<AccountTier, number> = { sub: 0, cheap: 1, free: 2 };

/** Routing strategy applied among the eligible candidates. */
export type RouterStrategy =
  | "tier-ladder" // best tier present, then weighted within it (default)
  | "weighted" // weighted random across all eligible (ignores tier)
  | "power-of-2" // pick 2 at random, take the less-loaded (power-of-two-choices)
  | "quota-aware" // most remaining quota
  | "round-robin"; // rotate through eligible accounts

// ── Config + state ─────────────────────────────────────────────────────────────

/** A credential registered with the pool. */
export interface AccountConfig {
  /** Unique id (opaque — never the raw secret). */
  id: string;
  /** Provider this credential belongs to, e.g. "anthropic". */
  provider: string;
  /** Value tier. Defaults to "cheap". */
  tier?: AccountTier;
  /** Relative weight for weighted routing (default 1). */
  weight?: number;
  /** Token quota for the current window; omit for unlimited. */
  quotaLimit?: number;
  /** When the quota window resets (epoch ms); informational + auto-reset. */
  quotaResetAt?: number;
}

export type AccountHealth = "healthy" | "cooldown" | "open";

/** Live routing state for one account. */
export interface AccountState extends AccountConfig {
  tier: AccountTier;
  weight: number;
  /** Consecutive failures since the last success. */
  failures: number;
  /** Soft cooldown (from a 429/auth-fail); unavailable while now < this. */
  cooldownUntil: number;
  /** Circuit-breaker open-until (epoch ms); unavailable while now < this. */
  breakerOpenUntil: number;
  /** How many times the breaker has tripped (drives exponential backoff). */
  breakerTrips: number;
  /** Tokens consumed against the quota this window. */
  quotaUsed: number;
  lastUsedAt?: number;
}

export interface PoolOptions {
  /** Clock injection (default Date.now). */
  now?: () => number;
  /** Randomness injection for jitter + weighted/p2c picks (default Math.random). */
  random?: () => number;
  /** Base soft-cooldown after a 429/auth-fail (default 30s). */
  cooldownMs?: number;
  /** Consecutive failures that trip the circuit breaker (default 5). */
  breakerThreshold?: number;
  /** Base breaker open duration; doubles per trip (default 60s). */
  breakerResetMs?: number;
  /** Max jitter added to every cooldown/backoff to avoid thundering herd (default 1s). */
  jitterMs?: number;
}

export interface PickOptions {
  strategy?: RouterStrategy;
  /** Only consider this tier or better (higher). */
  minTier?: AccountTier;
  /** Estimated tokens the call will consume — an account must have room for it. */
  estTokens?: number;
}

/** Why a failure happened — shapes the cooldown/breaker response. */
export interface FailureInfo {
  /** HTTP status if known (429 / 401 / 403 get an immediate cooldown). */
  status?: number;
}

const DEFAULTS = {
  cooldownMs: 30_000,
  breakerThreshold: 5,
  breakerResetMs: 60_000,
  jitterMs: 1_000,
};

// ── Pool ─────────────────────────────────────────────────────────────────────

export class AccountPool {
  private accounts = new Map<string, AccountState>();
  private rrCursor = new Map<string, number>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly cooldownMs: number;
  private readonly breakerThreshold: number;
  private readonly breakerResetMs: number;
  private readonly jitterMs: number;

  constructor(accounts: AccountConfig[] = [], opts: PoolOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.cooldownMs = opts.cooldownMs ?? DEFAULTS.cooldownMs;
    this.breakerThreshold = opts.breakerThreshold ?? DEFAULTS.breakerThreshold;
    this.breakerResetMs = opts.breakerResetMs ?? DEFAULTS.breakerResetMs;
    this.jitterMs = opts.jitterMs ?? DEFAULTS.jitterMs;
    for (const a of accounts) this.register(a);
  }

  /** Register (or replace) an account. */
  register(cfg: AccountConfig): this {
    this.accounts.set(cfg.id, {
      ...cfg,
      tier: cfg.tier ?? "cheap",
      weight: cfg.weight ?? 1,
      failures: 0,
      cooldownUntil: 0,
      breakerOpenUntil: 0,
      breakerTrips: 0,
      quotaUsed: 0,
    });
    return this;
  }

  get(id: string): AccountState | undefined {
    return this.accounts.get(id);
  }

  all(): AccountState[] {
    return [...this.accounts.values()];
  }

  /** Current health of an account (also rolls over an expired quota window). */
  health(id: string): AccountHealth | undefined {
    const a = this.accounts.get(id);
    if (!a) return undefined;
    this.maybeResetQuota(a);
    const t = this.now();
    if (t < a.breakerOpenUntil) return "open";
    if (t < a.cooldownUntil) return "cooldown";
    return "healthy";
  }

  /**
   * Pick the best account for `provider`, or null if none is currently eligible.
   * Eligible = healthy (past cooldown + breaker) and has quota room for `estTokens`.
   */
  pick(provider: string, opts: PickOptions = {}): AccountState | null {
    const strategy = opts.strategy ?? "tier-ladder";
    const t = this.now();
    let candidates = this.all().filter((a) => {
      if (a.provider !== provider) return false;
      this.maybeResetQuota(a);
      if (t < a.breakerOpenUntil || t < a.cooldownUntil) return false;
      if (opts.minTier && TIER_RANK[a.tier] > TIER_RANK[opts.minTier]) return false;
      return this.hasQuotaRoom(a, opts.estTokens ?? 0);
    });
    if (candidates.length === 0) return null;

    if (strategy === "tier-ladder") {
      const bestRank = Math.min(...candidates.map((a) => TIER_RANK[a.tier]));
      candidates = candidates.filter((a) => TIER_RANK[a.tier] === bestRank);
      return this.weightedPick(candidates);
    }
    if (strategy === "weighted") return this.weightedPick(candidates);
    if (strategy === "quota-aware") return this.quotaAwarePick(candidates);
    if (strategy === "round-robin") return this.roundRobinPick(provider, candidates);
    return this.powerOfTwoPick(candidates); // "power-of-2"
  }

  // ── Outcome recording ────────────────────────────────────────────────────────

  /** Record a successful call — clears failures and closes the breaker. */
  recordSuccess(id: string, tokens = 0): void {
    const a = this.accounts.get(id);
    if (!a) return;
    a.failures = 0;
    a.breakerOpenUntil = 0;
    a.breakerTrips = 0;
    a.cooldownUntil = 0;
    a.lastUsedAt = this.now();
    if (tokens > 0) this.recordUsage(id, tokens);
  }

  /**
   * Record a failed call. 429/401/403 trigger an immediate soft cooldown; the
   * breaker trips (with exponential, jittered backoff) once consecutive failures
   * reach the threshold.
   */
  recordFailure(id: string, info: FailureInfo = {}): void {
    const a = this.accounts.get(id);
    if (!a) return;
    a.failures += 1;
    a.lastUsedAt = this.now();
    const rateLimitedOrAuth =
      info.status === 429 || info.status === 401 || info.status === 403;
    if (rateLimitedOrAuth) {
      a.cooldownUntil = this.now() + this.cooldownMs + this.jitter();
    }
    if (a.failures >= this.breakerThreshold) {
      const backoff = this.breakerResetMs * 2 ** a.breakerTrips;
      a.breakerOpenUntil = this.now() + backoff + this.jitter();
      a.breakerTrips += 1;
      // Reset the counter so the breaker needs another full threshold run to
      // re-trip — giving clean per-round exponential backoff rather than
      // re-tripping on every subsequent failure.
      a.failures = 0;
    }
  }

  /** Charge tokens against an account's quota window. */
  recordUsage(id: string, tokens: number): void {
    const a = this.accounts.get(id);
    if (!a) return;
    this.maybeResetQuota(a);
    a.quotaUsed += Math.max(0, tokens);
  }

  /** Remaining quota for an account (Infinity when unlimited). */
  remainingQuota(id: string): number {
    const a = this.accounts.get(id);
    if (!a || a.quotaLimit === undefined) return Infinity;
    this.maybeResetQuota(a);
    return Math.max(0, a.quotaLimit - a.quotaUsed);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private hasQuotaRoom(a: AccountState, estTokens: number): boolean {
    if (a.quotaLimit === undefined) return true;
    return a.quotaLimit - a.quotaUsed >= estTokens;
  }

  private maybeResetQuota(a: AccountState): void {
    if (a.quotaResetAt !== undefined && this.now() >= a.quotaResetAt) {
      a.quotaUsed = 0;
      a.quotaResetAt = undefined;
    }
  }

  private jitter(): number {
    return Math.floor(this.random() * this.jitterMs);
  }

  private weightedPick(candidates: AccountState[]): AccountState {
    const total = candidates.reduce((s, a) => s + Math.max(0, a.weight), 0);
    if (total <= 0) return candidates[0]!;
    let r = this.random() * total;
    for (const a of candidates) {
      r -= Math.max(0, a.weight);
      if (r < 0) return a;
    }
    return candidates[candidates.length - 1]!;
  }

  private quotaAwarePick(candidates: AccountState[]): AccountState {
    return candidates.reduce((best, a) =>
      this.remainingQuota(a.id) > this.remainingQuota(best.id) ? a : best,
    );
  }

  private powerOfTwoPick(candidates: AccountState[]): AccountState {
    if (candidates.length === 1) return candidates[0]!;
    const i = Math.floor(this.random() * candidates.length);
    let j = Math.floor(this.random() * candidates.length);
    if (j === i) j = (j + 1) % candidates.length;
    const a = candidates[i]!;
    const b = candidates[j]!;
    // Less loaded = fewer failures, then lower quota-usage ratio.
    return this.load(a) <= this.load(b) ? a : b;
  }

  private load(a: AccountState): number {
    const usageRatio = a.quotaLimit ? a.quotaUsed / a.quotaLimit : 0;
    return a.failures + usageRatio;
  }

  private roundRobinPick(provider: string, candidates: AccountState[]): AccountState {
    const next = (this.rrCursor.get(provider) ?? 0) % candidates.length;
    this.rrCursor.set(provider, next + 1);
    return candidates[next]!;
  }
}
