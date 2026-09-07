/**
 * @nexus/rate-limiter — Multi-dimensional sliding window rate limiting.
 *
 * Production-ready rate limiting using sliding window algorithm with:
 *   - Endpoint tier classification (CRITICAL / HIGH / MEDIUM / LOW)
 *   - Multi-dimensional limiting (IP → User → Team)
 *   - Lockout after excessive violations
 *   - Per-tool plugin bindings with error modes
 *
 * Inspired by ContextForge's rate_limit_middleware.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type EndpointTier = "critical" | "high" | "medium" | "low";

export interface RateLimitResult {
  allowed: boolean;
  tier: EndpointTier;
  dimension: "ip" | "user" | "team";
  current: number;
  limit: number;
  retryAfterMs?: number;
  lockedOut?: boolean;
  lockoutExpiresAt?: string;
}

export interface TierConfig {
  tier: EndpointTier;
  /** Requests per minute */
  rpm: number;
  /** Burst size (max single-window spike) */
  burst?: number;
}

export interface LockoutConfig {
  enabled: boolean;
  /** Violations before lockout */
  threshold: number;
  /** Lockout duration in ms */
  durationMs: number;
}

export interface RateLimiterConfig {
  /** Per-tier RPM limits */
  tiers: Record<EndpointTier, TierConfig>;
  /** IP → User → Team dimensional limits (override per tier) */
  dimensionalLimits?: {
    ip?: Record<EndpointTier, number>;
    user?: Record<EndpointTier, number>;
    team?: Record<EndpointTier, number>;
  };
  /** Lockout configuration */
  lockout?: LockoutConfig;
  /** Sliding window size in ms (default: 60000 = 1 min) */
  windowMs?: number;
}

// ─── Sliding Window Counter ──────────────────────────────────────────────────

interface WindowEntry {
  timestamps: number[];
}

class SlidingWindowCounter {
  private windows = new Map<string, WindowEntry>();
  private windowMs: number;

  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
  }

  /** Record a request and return the current count in the window. */
  record(key: string, now = Date.now()): number {
    let entry = this.windows.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.windows.set(key, entry);
    }

    // Prune expired entries
    const windowStart = now - this.windowMs;
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
    entry.timestamps.push(now);

    return entry.timestamps.length;
  }

  /** Get current count without recording. */
  count(key: string, now = Date.now()): number {
    const entry = this.windows.get(key);
    if (!entry) return 0;
    const windowStart = now - this.windowMs;
    return entry.timestamps.filter((t) => t > windowStart).length;
  }

  /** Get the oldest entry time in the window (for retry-after). */
  oldestInWindow(key: string, now = Date.now()): number | null {
    const entry = this.windows.get(key);
    if (!entry || entry.timestamps.length === 0) return null;
    const windowStart = now - this.windowMs;
    const inWindow = entry.timestamps.filter((t) => t > windowStart);
    return inWindow.length > 0 ? inWindow[0] : null;
  }

  /** Reset a key. */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /** Cleanup all expired windows. */
  cleanup(now = Date.now()): number {
    let cleaned = 0;
    const windowStart = now - this.windowMs;
    for (const [key, entry] of this.windows) {
      entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
      if (entry.timestamps.length === 0) {
        this.windows.delete(key);
        cleaned++;
      }
    }
    return cleaned;
  }
}

// ─── Lockout Tracker ─────────────────────────────────────────────────────────

interface LockoutEntry {
  lockedAt: number;
  expiresAt: number;
}

class LockoutTracker {
  private lockouts = new Map<string, LockoutEntry>();
  private violations = new Map<string, number>();

  constructor(
    private threshold: number,
    private durationMs: number,
  ) {}

  /** Record a rate limit violation. Returns true if lockout should trigger. */
  recordViolation(key: string, now = Date.now()): boolean {
    // Check if already locked out
    if (this.isLockedOut(key, now)) return true;

    const count = (this.violations.get(key) ?? 0) + 1;
    this.violations.set(key, count);

    if (count >= this.threshold) {
      this.lockouts.set(key, {
        lockedAt: now,
        expiresAt: now + this.durationMs,
      });
      this.violations.delete(key);
      return true;
    }

    return false;
  }

  /** Check if a key is currently locked out. */
  isLockedOut(key: string, now = Date.now()): boolean {
    const entry = this.lockouts.get(key);
    if (!entry) return false;
    if (now >= entry.expiresAt) {
      this.lockouts.delete(key);
      return false;
    }
    return true;
  }

  /** Get lockout expiry for a key. */
  getExpiry(key: string): Date | null {
    const entry = this.lockouts.get(key);
    return entry ? new Date(entry.expiresAt) : null;
  }

  /** Manually clear a lockout. */
  clear(key: string): void {
    this.lockouts.delete(key);
    this.violations.delete(key);
  }
}

// ─── Endpoint Tier Matcher ───────────────────────────────────────────────────

interface TierPattern {
  pattern: RegExp;
  tier: EndpointTier;
}

function buildTierPatterns(): TierPattern[] {
  return [
    // Critical: auth endpoints
    { pattern: /^\/auth\/(login|register|forgot-password|reset-password)/i, tier: "critical" },
    { pattern: /^\/api\/v1\/(admin|delete|destroy)/i, tier: "critical" },
    // High: write operations
    { pattern: /^\/api\/v1\/(write|create|update|put|post|patch)/i, tier: "high" },
    { pattern: /\bcreate\b|\bupdate\b|\bdelete\b|\bexecute\b/i, tier: "high" },
    // Medium: read operations
    { pattern: /^\/api\/v1\/(read|get|list|search|query)/i, tier: "medium" },
    { pattern: /\bget\b|\blist\b|\bsearch\b|\bquery\b/i, tier: "medium" },
    // Low: health/info endpoints
    { pattern: /^\/(health|status|info|metrics|docs)/i, tier: "low" },
  ];
}

function classifyEndpoint(path: string, method: string): EndpointTier {
  const patterns = buildTierPatterns();
  const combined = `${method} ${path}`;

  for (const { pattern, tier } of patterns) {
    if (pattern.test(combined)) return tier;
  }

  // Default based on HTTP method
  if (method === "POST" || method === "PUT" || method === "DELETE") return "high";
  return "medium";
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────

export class MultiDimensionalRateLimiter {
  private config: RateLimiterConfig;
  private windows: SlidingWindowCounter;
  private lockout?: LockoutTracker;

  constructor(config: RateLimiterConfig) {
    this.config = config;
    this.windows = new SlidingWindowCounter(config.windowMs ?? 60_000);

    if (config.lockout?.enabled) {
      this.lockout = new LockoutTracker(
        config.lockout.threshold,
        config.lockout.durationMs,
      );
    }
  }

  /**
   * Check if a request is allowed.
   *
   * Checks dimensions in order: IP → User → Team.
   * Block if ANY dimension exceeds its limit.
   */
  check(params: {
    path: string;
    method: string;
    ip?: string;
    userId?: string;
    teamId?: string;
    tier?: EndpointTier;
  }): RateLimitResult {
    const now = Date.now();
    const tier = params.tier ?? classifyEndpoint(params.path, params.method);
    const tierConfig = this.config.tiers[tier];
    if (!tierConfig) {
      return { allowed: true, tier, dimension: "ip", current: 0, limit: Infinity };
    }

    const limit = tierConfig.rpm;
    const dimensions: Array<{ key: string; dim: "ip" | "user" | "team" }> = [];

    if (params.ip) dimensions.push({ key: `ip:${tier}:${params.ip}`, dim: "ip" });
    if (params.userId) dimensions.push({ key: `user:${tier}:${params.userId}`, dim: "user" });
    if (params.teamId) dimensions.push({ key: `team:${tier}:${params.teamId}`, dim: "team" });

    // If no dimensions, allow (can't rate-limit without identity)
    if (dimensions.length === 0) {
      return { allowed: true, tier, dimension: "ip", current: 0, limit: Infinity };
    }

    for (const { key, dim } of dimensions) {
      // Check lockout first
      if (this.lockout?.isLockedOut(key, now)) {
        return {
          allowed: false,
          tier,
          dimension: dim,
          current: limit,
          limit,
          lockedOut: true,
          lockoutExpiresAt: this.lockout.getExpiry(key)?.toISOString(),
        };
      }

      // Check dimensional override
      const dimLimit = this.config.dimensionalLimits?.[dim]?.[tier];
      const effectiveLimit = dimLimit ?? limit;

      const current = this.windows.record(key, now);

      if (current > effectiveLimit) {
        // Record violation for lockout
        this.lockout?.recordViolation(key, now);

        const oldest = this.windows.oldestInWindow(key, now);
        const retryAfterMs = oldest ? oldest + (this.config.windowMs ?? 60_000) - now : undefined;

        return {
          allowed: false,
          tier,
          dimension: dim,
          current,
          limit: effectiveLimit,
          retryAfterMs,
        };
      }
    }

    return {
      allowed: true,
      tier,
      dimension: dimensions[0].dim,
      current: this.windows.count(dimensions[0].key, now),
      limit,
    };
  }

  /** Manually clear rate limit state for a key. */
  clear(key: string): void {
    this.windows.reset(key);
    this.lockout?.clear(key);
  }

  /** Cleanup expired windows. */
  cleanup(): number {
    return this.windows.cleanup();
  }

  /** Get current stats for a key. */
  stats(key: string): { count: number; lockedOut: boolean; lockoutExpires?: Date } {
    const count = this.windows.count(key);
    const lockedOut = this.lockout?.isLockedOut(key) ?? false;
    const lockoutExpires = this.lockout?.getExpiry(key) ?? undefined;
    return { count, lockedOut, lockoutExpires };
  }
}

// ─── Middleware Helper ────────────────────────────────────────────────────────

export interface MiddlewareRequest {
  path: string;
  method: string;
  ip?: string;
  userId?: string;
  teamId?: string;
}

/**
 * Create a rate limiting middleware function for any HTTP framework.
 */
export function createRateLimitMiddleware(config: RateLimiterConfig) {
  const limiter = new MultiDimensionalRateLimiter(config);

  return (req: MiddlewareRequest): { allowed: boolean; headers: Record<string, string>; result: RateLimitResult } => {
    const result = limiter.check({
      path: req.path,
      method: req.method,
      ip: req.ip,
      userId: req.userId,
      teamId: req.teamId,
    });

    const headers: Record<string, string> = {
      "X-RateLimit-Limit": String(result.limit),
      "X-RateLimit-Remaining": String(Math.max(0, result.limit - result.current)),
      "X-RateLimit-Tier": result.tier,
    };

    if (result.retryAfterMs) {
      headers["Retry-After"] = String(Math.ceil(result.retryAfterMs / 1000));
      headers["X-RateLimit-Reset"] = String(
        Math.ceil((Date.now() + result.retryAfterMs) / 1000),
      );
    }

    if (result.lockedOut) {
      headers["X-RateLimit-Locked"] = "true";
      if (result.lockoutExpiresAt) {
        headers["X-RateLockout-Expires"] = result.lockoutExpiresAt;
      }
    }

    return { allowed: result.allowed, headers, result };
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createDefaultRateLimiter(): MultiDimensionalRateLimiter {
  return new MultiDimensionalRateLimiter({
    tiers: {
      critical: { tier: "critical", rpm: 10 },
      high: { tier: "high", rpm: 60 },
      medium: { tier: "medium", rpm: 120 },
      low: { tier: "low", rpm: 300 },
    },
    lockout: {
      enabled: true,
      threshold: 5,
      durationMs: 15 * 60_000, // 15 minutes
    },
    windowMs: 60_000,
  });
}
