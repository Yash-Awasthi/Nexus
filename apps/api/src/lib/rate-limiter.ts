// SPDX-License-Identifier: Apache-2.0
/**
 * Lightweight fixed-window rate limiter backed by the shared KV store.
 *
 * makeRateLimitPreHandler({ limit, windowMs, keyPrefix?, keyBy? })
 *   Returns a Fastify preHandler that enforces the rate limit.
 *
 * Key strategy (default): IP address from x-forwarded-for or remoteAddress.
 * Custom keyBy: use nexusUserId, token prefix, route-specific id, etc.
 *
 * Algorithm: fixed-window counter stored in KV with TTL = windowMs.
 * Each request increments the counter; if it hits the limit → 429.
 * Fails open (no 429) when KV is unavailable to avoid blocking all traffic.
 *
 * Production upgrade path: replace fixed-window with sliding-window using
 * Redis INCR + EXPIRE, or use @upstash/ratelimit when Upstash is wired.
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
    forwarded?.split(",")[0]?.trim()
    ?? (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress
    ?? "unknown";
  return `ratelimit:${prefix}:${ip}`;
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

  return async function rateLimitPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const kv  = getSharedKV();
    const key = keyBy
      ? `ratelimit:${keyPrefix}:${keyBy(request)}`
      : _ipKey(request, keyPrefix);

    try {
      const current = (await kv.get<number>(key)) ?? 0;
      if (current >= limit) {
        const retryAfter = Math.ceil(windowMs / 1_000);
        await reply
          .code(429)
          .header("Retry-After", retryAfter)
          .header("X-RateLimit-Limit", limit)
          .header("X-RateLimit-Remaining", 0)
          .send({
            error:    "Too Many Requests",
            code:     "RATE_LIMIT_EXCEEDED",
            limit,
            windowMs,
            retryAfterSeconds: retryAfter,
          });
        return;
      }
      // Increment — TTL resets the window from the first request of this bucket.
      await kv.set<number>(key, current + 1, windowMs);
      reply.header("X-RateLimit-Limit", limit);
      reply.header("X-RateLimit-Remaining", Math.max(0, limit - current - 1));
    } catch {
      // KV unavailable — fail open to avoid cascading downtime.
    }
  };
}
