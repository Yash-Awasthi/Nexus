// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/proxy-rotation — Proxy management and rotation layer.
 *
 * IProxyRotator   — core interface.
 *
 * RoundRobinRotator  — cycles through the pool in order, skipping banned proxies.
 * RandomRotator      — picks randomly on each call, skipping banned proxies.
 * LeastUsedRotator   — always picks the proxy with the fewest successful uses.
 * StickyRotator      — assigns a stable proxy per session key; falls back to
 *                      round-robin for new keys. Sticky mapping released when
 *                      a proxy is banned.
 *
 * All implementations share:
 *  • Health tracking (failCount, lastUsedAt, lastFailAt, avgLatencyMs via EMA)
 *  • Auto-ban after `maxConsecutiveFails` consecutive failures (default: 3)
 *  • Auto-recovery: banned proxies re-enter the pool after `banTtlMs` (default: 5 min)
 *  • Injectable `now` for deterministic tests
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProxyProtocol = "http" | "https" | "socks5";

/** Proxy interface definition. */
export interface Proxy {
  /** Full proxy URL, e.g. "http://user:pass@1.2.3.4:8080" */
  url: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  auth?: { username: string; password: string };
  /** Arbitrary labels for filtering. */
  tags?: string[];
  /** Relative weight (used by WeightedRotator). Default 1. */
  weight?: number;
}

/** Proxy health interface definition. */
export interface ProxyHealth {
  proxy: Proxy;
  /** Total successful uses. */
  useCount: number;
  /** Consecutive failures since last success. */
  consecutiveFails: number;
  /** Total failure count. */
  totalFails: number;
  lastUsedAt?: number;
  lastFailAt?: number;
  /** Whether this proxy is currently banned. */
  banned: boolean;
  /** Timestamp when the ban will auto-lift (if banTtlMs was set). */
  bannedUntil?: number;
  /** EMA of latency across successful calls. */
  avgLatencyMs?: number;
}

// ── Error ──────────────────────────────────────────────────────────────────────

export class ProxyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

// ── IProxyRotator ─────────────────────────────────────────────────────────────

export interface IProxyRotator {
  /** Add one or more proxies to the pool. Duplicates (by URL) are ignored. */
  add(proxy: Proxy | Proxy[]): void;
  /** Remove a proxy by URL. Returns true if it existed. */
  remove(url: string): boolean;
  /** Pick the next proxy. Returns undefined if pool is empty or all banned. */
  next(sessionKey?: string): Proxy | undefined;
  /** Record a successful request through this proxy. */
  markSuccess(proxy: Proxy, latencyMs?: number): void;
  /** Record a failed request. Auto-bans after maxConsecutiveFails. */
  markFail(proxy: Proxy): void;
  /** Immediately ban a proxy (e.g. on 403/captcha). */
  markBanned(proxy: Proxy): void;
  /** Return health records for all proxies (including banned). */
  health(): ProxyHealth[];
  /** Total proxies (including banned). */
  size(): number;
  /** Active (non-banned) proxy count. */
  activeSize(): number;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface RotatorConfig {
  /** Ban after this many consecutive failures. Default: 3 */
  maxConsecutiveFails?: number;
  /** Auto-lift ban after this many ms. Omit for permanent ban. */
  banTtlMs?: number;
  now?: () => number;
}

// ── Base class ────────────────────────────────────────────────────────────────

abstract class BaseRotator implements IProxyRotator {
  protected readonly pool = new Map<string, ProxyHealth>();
  protected readonly maxFails: number;
  protected readonly banTtlMs?: number;
  protected readonly now: () => number;

  constructor(config: RotatorConfig = {}) {
    this.maxFails = config.maxConsecutiveFails ?? 3;
    this.banTtlMs = config.banTtlMs;
    this.now = config.now ?? (() => Date.now());
  }

  add(proxy: Proxy | Proxy[]): void {
    const list = Array.isArray(proxy) ? proxy : [proxy];
    for (const p of list) {
      if (!this.pool.has(p.url)) {
        this.pool.set(p.url, {
          proxy: p,
          useCount: 0,
          consecutiveFails: 0,
          totalFails: 0,
          banned: false,
        });
      }
    }
  }

  remove(url: string): boolean {
    return this.pool.delete(url);
  }

  markSuccess(proxy: Proxy, latencyMs?: number): void {
    const h = this.pool.get(proxy.url);
    if (!h) return;
    h.useCount++;
    h.consecutiveFails = 0;
    h.banned = false;
    h.bannedUntil = undefined;
    h.lastUsedAt = this.now();
    if (latencyMs !== undefined) {
      h.avgLatencyMs =
        h.avgLatencyMs === undefined ? latencyMs : h.avgLatencyMs * 0.8 + latencyMs * 0.2;
    }
  }

  markFail(proxy: Proxy): void {
    const h = this.pool.get(proxy.url);
    if (!h) return;
    h.consecutiveFails++;
    h.totalFails++;
    h.lastFailAt = this.now();
    if (h.consecutiveFails >= this.maxFails) {
      this._ban(h);
    }
  }

  markBanned(proxy: Proxy): void {
    const h = this.pool.get(proxy.url);
    if (!h) return;
    this._ban(h);
  }

  private _ban(h: ProxyHealth): void {
    h.banned = true;
    if (this.banTtlMs) {
      h.bannedUntil = this.now() + this.banTtlMs;
    }
  }

  protected _isAvailable(h: ProxyHealth): boolean {
    if (!h.banned) return true;
    if (h.bannedUntil !== undefined && this.now() >= h.bannedUntil) {
      // Auto-recover
      h.banned = false;
      h.bannedUntil = undefined;
      h.consecutiveFails = 0;
      return true;
    }
    return false;
  }

  protected _active(): ProxyHealth[] {
    return [...this.pool.values()].filter((h) => this._isAvailable(h));
  }

  health(): ProxyHealth[] {
    return [...this.pool.values()];
  }

  size(): number {
    return this.pool.size;
  }

  activeSize(): number {
    return this._active().length;
  }

  abstract next(sessionKey?: string): Proxy | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// RoundRobinRotator
// ─────────────────────────────────────────────────────────────────────────────

export class RoundRobinRotator extends BaseRotator {
  private _idx = 0;

  next(): Proxy | undefined {
    const active = this._active();
    if (active.length === 0) return undefined;
    const entry = active[this._idx % active.length];
    this._idx = (this._idx + 1) % active.length;
    return entry?.proxy;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RandomRotator
// ─────────────────────────────────────────────────────────────────────────────

export class RandomRotator extends BaseRotator {
  private readonly rand: () => number;

  constructor(config: RotatorConfig & { rand?: () => number } = {}) {
    super(config);
    this.rand = config.rand ?? Math.random;
  }

  next(): Proxy | undefined {
    const active = this._active();
    if (active.length === 0) return undefined;
    const idx = Math.floor(this.rand() * active.length);
    return active[idx]?.proxy;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LeastUsedRotator
// ─────────────────────────────────────────────────────────────────────────────

export class LeastUsedRotator extends BaseRotator {
  next(): Proxy | undefined {
    const active = this._active();
    if (active.length === 0) return undefined;
    let best = active[0];
    for (const h of active) {
      if (h.useCount < (best?.useCount ?? Infinity)) best = h;
    }
    return best?.proxy;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// StickyRotator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maintains a stable proxy per session key.
 * Falls back to round-robin for new sessions.
 * Releases sticky assignment when the proxy is banned.
 */
export class StickyRotator extends BaseRotator {
  private readonly stickyMap = new Map<string, string>(); // sessionKey → proxyUrl
  private _rrIdx = 0;

  next(sessionKey?: string): Proxy | undefined {
    const active = this._active();
    if (active.length === 0) return undefined;

    if (sessionKey) {
      const assignedUrl = this.stickyMap.get(sessionKey);
      if (assignedUrl) {
        const h = this.pool.get(assignedUrl);
        if (h && this._isAvailable(h)) return h.proxy;
        // Assigned proxy is banned — clear assignment and pick new
        this.stickyMap.delete(sessionKey);
      }
      // Assign a new proxy for this session via round-robin
      const entry = active[this._rrIdx % active.length];
      this._rrIdx = (this._rrIdx + 1) % active.length;
      if (entry) {
        this.stickyMap.set(sessionKey, entry.proxy.url);
        return entry.proxy;
      }
      return undefined;
    }

    // No session key — plain round-robin
    const entry = active[this._rrIdx % active.length];
    this._rrIdx = (this._rrIdx + 1) % active.length;
    return entry?.proxy;
  }

  /** Clear all sticky session assignments. */
  clearSessions(): void {
    this.stickyMap.clear();
  }

  /** Number of active sticky session assignments. */
  sessionCount(): number {
    return this.stickyMap.size;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a proxy URL string into a Proxy object.
 * Supports: http://user:pass@host:port, socks5://host:port, etc.
 */
export function parseProxyUrl(raw: string): Proxy {
  try {
    const u = new URL(raw);
    const protocol = (u.protocol.replace(":", "") || "http") as ProxyProtocol;
    const port = parseInt(u.port, 10) || (protocol === "https" ? 443 : 80);
    const proxy: Proxy = { url: raw, protocol, host: u.hostname, port };
    if (u.username) {
      proxy.auth = {
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
      };
    }
    return proxy;
  } catch {
    throw new ProxyError(`Invalid proxy URL: ${raw}`, "INVALID_URL", { raw });
  }
}

/**
 * Build a pool from a newline/comma-separated list of proxy URLs.
 */
export function parseProxyList(raw: string): Proxy[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((url) => parseProxyUrl(url));
}
