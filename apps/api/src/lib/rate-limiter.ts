// SPDX-License-Identifier: Apache-2.0
/**
 * Lightweight fixed-window rate limiter backed by Redis (Upstash REST) or
 * in-memory KV.
 *
 * makeRateLimitPreHandler({ limit, windowMs, keyPrefix?, keyBy? })
 *   Returns a Fastify preHandler that enforces the rate limit.
 *
 * Key strategy (default): IP address from x-forwarded-for or remoteAddress.
 * Custom keyBy: use nexusUserId, token prefix, route-specific id, etc.
 *
 * Algorithm:
 *   - Upstash Redis: atomic INCR + EXPIRE via pipeline (no race condition).
 *   - In-memory KV:   single-process, effectively atomic for Node.js event loop.
 * Fails open (no 429) when KV is unavailable to avoid blocking all traffic.
 */

import { createHash } from "node:crypto";

import { MemoryKVStore } from "@nexus/kv";
import type { FastifyRequest, FastifyReply } from "fastify";

import { getSharedKV } from "./shared-kv.js";

interface RateLimitOptions {
  /** Max requests allowed per window. */
  limit: number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Namespace prefix for KV keys — separate limiters for different route groups. */
  keyPrefix?: string;
  /**
   * Custom key extractor. Receives the FastifyRequest and returns a string
   * identifier for the rate-limit bucket (e.g. userId, IP, token prefix).
   */
  keyBy?: (req: FastifyRequest) => string;
}

// req.ip honours NEXUS_TRUST_PROXY; a raw X-Forwarded-For would let any client pick its bucket.
function _ipKey(req: FastifyRequest, prefix: string): string {
  const ip =
    (req.ip as string | undefined) ??
    (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress ??
    "unknown";
  return `ratelimit:${prefix}:${ip}`;
}

/**
 * Stable per-API-key bucket id derived from the Bearer token. The token is
 * SHA-256'd and truncated — the raw key never appears in a KV key, log, or
 * response header. Returns null when there is no Bearer token.
 */
function _apiKeyId(req: FastifyRequest): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec((req.headers.authorization as string | undefined) ?? "");
  if (!m?.[1]) return null;
  return createHash("sha256").update(m[1]).digest("hex").slice(0, 16);
}

// ── Atomic Redis INCR + EXPIRE (pipeline) ────────────────────────────────────
// Uses the Upstash REST pipeline to atomically increment and set TTL.
// This eliminates the read-check-set race condition present in the old code.

/** A hung Upstash host would otherwise hold every rate-limited request. */
const UPSTASH_TIMEOUT_MS = 2_000;

async function _atomicIncrWithTTL(key: string, windowSec: number): Promise<number | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null; // not using Upstash

  try {
    const u = url.replace(/\/$/, "");
    const res = await fetch(`${u}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([["INCR", key]]),
      signal: AbortSignal.timeout(UPSTASH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const results = (await res.json()) as { result: number; error?: string }[];
    if (results[0]?.error) return null;
    const count = results[0]!.result as number;
    // Stamp the window expiry ONLY when this call created the key (INCR
    // returned 1). An unconditional EXPIRE refreshes the TTL on every request,
    // so a bucket pushed over the limit could never drain while any traffic
    // (e.g. an SSE reconnect loop) kept touching the key — the whole IP stuck
    // at 429 forever. Failing EXPIRE is tolerated: the bucket just lacks a
    // TTL (a one-key leak) instead of double-counting via the fallback.
    if (count === 1) {
      try {
        await fetch(`${u}/pipeline`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify([["EXPIRE", key, windowSec]]),
          signal: AbortSignal.timeout(UPSTASH_TIMEOUT_MS),
        });
      } catch {
        /* ignored — see above */
      }
    }
    return count;
  } catch {
    return null; // the shared store, or a local count, takes over
  }
}

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  const v = ip.replace(/^::ffff:/, ""); // IPv4-mapped IPv6
  return v === "::1" || v.startsWith("127.");
}

/**
 * Whether the connection itself comes from this machine. Never `request.ip`: with a trusted
 * proxy that is read from X-Forwarded-For, which a caller can write.
 */
export function peerIsLoopback(request: FastifyRequest): boolean {
  return isLoopback(request.socket?.remoteAddress ?? request.raw.socket?.remoteAddress);
}

/** The desktop app's own UI on this machine is its only client; limiting it only throttles the owner. */
const exempt = (request: FastifyRequest) =>
  process.env.NEXUS_DESKTOP === "1" && peerIsLoopback(request);

/**
 * Returns a Fastify preHandler that enforces the rate limit.
 * Mount it via `preHandler` on individual routes or route groups.
 *
 * @example
 * const adminRL = makeRateLimitPreHandler({ limit: 30, windowMs: 60_000, keyPrefix: "admin" });
 * app.post("/admin/settings", { preHandler: [requireAuth, adminRL] }, handler);
 */
export function makeRateLimitPreHandler(opts: RateLimitOptions) {
  const { limit, windowMs, keyPrefix = "default", keyBy } = opts;
  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));

  return async function rateLimitPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (exempt(request)) return;
    const key = keyBy ? `ratelimit:${keyPrefix}:${keyBy(request)}` : _ipKey(request, keyPrefix);

    try {
      // Try atomic Redis INCR first (no race condition)
      const atomicCount = await _atomicIncrWithTTL(key, windowSec);
      const current = atomicCount ?? (await countRequest(key, windowMs));

      if (current > limit) {
        const retryAfter = windowSec;
        await reply
          .code(429)
          .header("Retry-After", retryAfter)
          .header("X-RateLimit-Limit", limit)
          .header("X-RateLimit-Remaining", 0)
          .send({
            error: "Too Many Requests",
            code: "RATE_LIMIT_EXCEEDED",
            limit,
            windowMs,
            retryAfterSeconds: retryAfter,
          });
        return;
      }

      reply.header("X-RateLimit-Limit", limit);
      reply.header("X-RateLimit-Remaining", Math.max(0, limit - current));
    } catch {
      // Counting falls back locally, so only a failed reply lands here; let the request through.
    }
  };
}

/**
 * Fallback: atomic increment on the shared KV (Redis INCR / in-process map
 * increment / Upstash INCR). The store stamps the window TTL only when it
 * creates the key, so the expiry is never refreshed by in-window traffic —
 * the bucket drains at the window boundary even under continuous requests.
 */
export async function countRequest(key: string, windowMs: number): Promise<number> {
  try {
    return await getSharedKV().incr(key, windowMs);
  } catch {
    // An unreachable shared store must not lift every limit: count in this process instead.
    return localCounts.incr(key, windowMs);
  }
}

const localCounts = new MemoryKVStore();

/**
 * Per-identity rate limiter. Buckets by the strongest identity available:
 * an explicit `keyBy`, else `nexusUserId`, else the caller's **API key**
 * (SHA-256 of the Bearer token — BYOK requests without a resolved user still get
 * a per-key bucket instead of collapsing onto a shared NAT IP), else the IP.
 * Layer this ON TOP of IP-based limits for defense in depth.
 */
export function makeUserRateLimitPreHandler(opts: RateLimitOptions) {
  const { limit, windowMs, keyPrefix = "default", keyBy } = opts;
  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));

  return async function userRateLimitPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (exempt(request)) return;
    // Identity class for the X-RateLimit-User header (never the raw key/token).
    let identity = "ip";
    const resolveKey = (): string => {
      if (keyBy) {
        identity = "custom";
        return `ratelimit:${keyPrefix}:${keyBy(request)}`;
      }
      if (request.nexusUserId) {
        identity = request.nexusUserId;
        return `ratelimit:${keyPrefix}:user:${request.nexusUserId}`;
      }
      const apiKeyId = _apiKeyId(request);
      if (apiKeyId) {
        identity = "key";
        return `ratelimit:${keyPrefix}:key:${apiKeyId}`;
      }
      // Its own bucket: the IP limiter layered with this one must not count the request twice.
      return _ipKey(request, `${keyPrefix}:anon`);
    };
    const key = resolveKey();

    try {
      const atomicCount = await _atomicIncrWithTTL(key, windowSec);
      const current = atomicCount ?? (await countRequest(key, windowMs));

      if (current > limit) {
        const retryAfter = windowSec;
        await reply
          .code(429)
          .header("Retry-After", retryAfter)
          .header("X-RateLimit-Limit", limit)
          .header("X-RateLimit-Remaining", 0)
          .header("X-RateLimit-User", identity)
          .send({
            error: "Too Many Requests",
            code: "RATE_LIMIT_EXCEEDED",
            limit,
            windowMs,
            retryAfterSeconds: retryAfter,
          });
        return;
      }

      reply.header("X-RateLimit-Limit", limit);
      reply.header("X-RateLimit-Remaining", Math.max(0, limit - current));
      reply.header("X-RateLimit-User", identity);
    } catch {
      // Counting falls back locally, so only a failed reply lands here; let the request through.
    }
  };
}
