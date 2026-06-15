// SPDX-License-Identifier: Apache-2.0
/**
 * Auth middleware for @nexus/api.
 *
 * requireAuth         — validates Bearer token (constant-time). Dev bypass when NEXUS_API_KEY unset.
 * requireAuthWithTier — validates auth AND attaches nexusTier to request from VERIFIED source:
 *                         1. HS256-verified JWT claim (NEXUS_JWT_SECRET)
 *                         2. api_keys.tier DB lookup (DATABASE_URL)
 *                         3. "free" default (safe)
 *
 * getTierFromRequest  — sync tier reader for preHandler factories (uses JWT or cache).
 *
 * ⚠️  x-nexus-tier header is intentionally IGNORED — callers can forge any header.
 *     Tier must always come from a cryptographically verified source.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { authenticate, AuthError } from "@nexus/auth";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { Tier } from "@nexus/tier-gate";

// ── HS256 JWT verifier (no npm dep — Node 22 crypto) ──────────────────────────

interface JwtPayload {
  sub?: string;
  tier?: string;
  exp?: number;
  [key: string]: unknown;
}

function _verifyHs256(token: string, secret: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const expected  = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  let sig: Buffer;
  try { sig = Buffer.from(s, "base64url"); } catch { return null; }
  if (expected.length !== sig.length || !timingSafeEqual(expected, sig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as JwtPayload;
    if (payload.exp !== undefined && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

const _VALID_TIERS = new Set<string>(["free", "pro", "enterprise"]);
function _coerceTier(raw: unknown): Tier {
  return (typeof raw === "string" && _VALID_TIERS.has(raw)) ? raw as Tier : "free";
}

// ── In-process API-key tier cache (populated by requireAuthWithTier) ──────────

const _keyTierCache = new Map<string, Tier>();
function _cacheTier(prefix: string, tier: Tier): void {
  _keyTierCache.set(prefix, tier);
  setTimeout(() => _keyTierCache.delete(prefix), 5 * 60_000).unref();
}

// ── Fastify request augmentation ──────────────────────────────────────────────

declare module "fastify" {
  interface FastifyRequest {
    nexusTier?:   Tier;
    nexusUserId?: string;
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Sync tier reader — used by makeTierGatePreHandler via opts.getTier override.
 * Sources: JWT claim (if NEXUS_JWT_SECRET set) → in-process cache → "free".
 */
export function getTierFromRequest(request: FastifyRequest): Tier {
  if (request.nexusTier) return request.nexusTier;
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return "free";
  const token  = auth.slice(7);
  const secret = process.env.NEXUS_JWT_SECRET;
  if (secret) {
    const payload = _verifyHs256(token, secret);
    if (payload?.tier) return _coerceTier(payload.tier);
  }
  return _keyTierCache.get(token.slice(0, 40)) ?? "free";
}

/** Bearer token validation (constant-time). Dev bypass when NEXUS_API_KEY unset. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authConfig = {
    apiKey:   process.env.NEXUS_API_KEY || undefined,
    disabled: !process.env.NEXUS_API_KEY,
  };
  try {
    authenticate(request.headers.authorization, authConfig);
  } catch (err) {
    if (err instanceof AuthError) {
      await reply.code(err.httpStatus).send({ code: err.code, message: err.message });
      return;
    }
    await reply.code(500).send({ code: "INTERNAL_ERROR", message: "Auth check failed" });
  }
}

/**
 * requireAuthWithTier — validates Bearer token AND attaches verified tier.
 * Use this as the preHandler on routes that need RBAC or tier-gating.
 *
 * After this runs, routes can read:
 *   request.nexusTier   — "free" | "pro" | "enterprise"
 *   request.nexusUserId — user ID from JWT sub or api_keys.user_id
 */
export async function requireAuthWithTier(
  request: FastifyRequest,
  reply:   FastifyReply,
): Promise<void> {
  await requireAuth(request, reply);
  if (reply.sent) return;

  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { request.nexusTier = "free"; return; }

  const token       = auth.slice(7);
  const tokenPrefix = token.slice(0, 40);
  const jwtSecret   = process.env.NEXUS_JWT_SECRET;

  // JWT path (no DB round-trip)
  if (jwtSecret) {
    const payload = _verifyHs256(token, jwtSecret);
    if (payload) {
      request.nexusTier   = _coerceTier(payload.tier);
      request.nexusUserId = typeof payload.sub === "string" ? payload.sub : undefined;
      _cacheTier(tokenPrefix, request.nexusTier);
      return;
    }
  }

  // DB lookup (async — only when DATABASE_URL present)
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
      const keyHash = createHmac("sha256", dbUrl).update(token).digest("hex");
      const { rows } = await pool.query<{ user_id: string; tier: string }>(
        `SELECT user_id, tier FROM api_keys
          WHERE key_hash = $1 AND (revoked_at IS NULL OR revoked_at > NOW())
          LIMIT 1`,
        [keyHash],
      );
      await pool.end();
      if (rows.length > 0) {
        const row = rows[0]!;
        request.nexusTier   = _coerceTier(row.tier);
        request.nexusUserId = row.user_id;
        _cacheTier(tokenPrefix, request.nexusTier);
        return;
      }
    } catch { /* DB unreachable — fall through to default */ }
  }

  request.nexusTier = "free";
}
