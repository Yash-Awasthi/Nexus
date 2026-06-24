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

function _ipKey(req: FastifyRequest, prefix: string): string {
  const forwarded = req.headers["x-forwarded-for"] as string | undefined;
  const ip =
    forwarded?.split(",")[0]?.trim() ??
    (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress ??
    "unknown";
  return `ratelimit:${prefix}:${ip}`;
}

// ── Atomic Redis INCR + EXPIRE (pipeline) ────────────────────────────────────
// Uses the Upstash REST pipeline to atomically increment and set TTL.
// This eliminates the read-check-set race condition present in the old code.

async function _atomicIncrWithTTL(
  key: string,
  windowSec: number,
): Promise<number | null> {
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
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, windowSec],
      ]),
    });
    if (!res.ok) return null;
    const results = (await res.json()) as { result: number; error?: string }[];
    if (results[0]?.error) return null;
    return results[0]!.result as number;
  } catch {
    return null; // fail open
  }
}

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
    const key = keyBy ? `ratelimit:${keyPrefix}:${keyBy(request)}` : _ipKey(request, keyPrefix);

    try {
      // Try atomic Redis INCR first (no race condition)
      const atomicCount = await _atomicIncrWithTTL(key, windowSec);
      const current = atomicCount ?? await _getCurrentCount(key);

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
      // KV unavailable — fail open to avoid cascading downtime.
    }
  };
}

/** Fallback: read current count from KV (in-memory, single-process safe). */
async function _getCurrentCount(key: string): Promise<number> {
  const kv = getSharedKV();
  const current = (await kv.get<number>(key)) ?? 0;
  // ponytail: in-memory single-process → effectively atomic; redis uses INCR above
  await kv.set<number>(key, current + 1);
  return current + 1;
}

/**
 * Per-user rate limiter — keys by nexusUserId instead of IP.
 * Falls back to IP when nexusUserId is not available.
 * Layer this ON TOP of IP-based limits for defense in depth.
 */
export function makeUserRateLimitPreHandler(opts: RateLimitOptions) {
  const { limit, windowMs, keyPrefix = "default", keyBy } = opts;
  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));

  return async function userRateLimitPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const resolveKey = (): string => {
      if (keyBy) return `ratelimit:${keyPrefix}:${keyBy(request)}`;
      if (request.nexusUserId) return `ratelimit:${keyPrefix}:user:${request.nexusUserId}`;
      return _ipKey(request, keyPrefix);
    };
    const key = resolveKey();

    try {
      const atomicCount = await _atomicIncrWithTTL(key, windowSec);
      const current = atomicCount ?? await _getCurrentCount(key);

      if (current > limit) {
        const retryAfter = windowSec;
        await reply
          .code(429)
          .header("Retry-After", retryAfter)
          .header("X-RateLimit-Limit", limit)
          .header("X-RateLimit-Remaining", 0)
          .header("X-RateLimit-User", request.nexusUserId ?? "ip")
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
      reply.header("X-RateLimit-User", request.nexusUserId ?? "ip");
    } catch {
      // KV unavailable — fail open to avoid cascading downtime.
    }
  };
}
