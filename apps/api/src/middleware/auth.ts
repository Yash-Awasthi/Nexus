// SPDX-License-Identifier: Apache-2.0
/**
 * Auth middleware for @nexus/api.
 *
 * requireAuth         — validates Bearer token (constant-time). Dev bypass when NEXUS_API_KEY unset.
 * requireAuthWithTier — validates auth AND attaches request.nexusUserId (identity)
 *                         from a verified JWT sub or the api_keys table.
 * getTierFromRequest  — sync tier reader for gate preHandlers.
 *
 * Nexus is free and open to all: there is no paid tier and nothing is gated.
 * Tier resolution is hard-wired to the highest level (OPEN_TIER), so every gate
 * passes. The `Tier` type / tier-gate package are kept inert for type-compat.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { authenticate, AuthError } from "@nexus/auth";
import type { Tier } from "@nexus/tier-gate";
import type { FastifyRequest, FastifyReply } from "fastify";

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
  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  let sig: Buffer;
  try {
    sig = Buffer.from(s, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== sig.length || !timingSafeEqual(expected, sig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as JwtPayload;
    if (payload.exp !== undefined && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// Nexus is free and open to all — there is no paid tier. Every authenticated
// caller is treated as the highest access level so no feature is ever gated.
// `Tier` and the tier-gate package remain only so existing gate call-sites keep
// type-checking; with OPEN_TIER they always pass.
const OPEN_TIER: Tier = "enterprise";

// ── Fastify request augmentation ──────────────────────────────────────────────

declare module "fastify" {
  interface FastifyRequest {
    nexusTier?: Tier;
    nexusUserId?: string;
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Sync tier reader used by makeTierGatePreHandler. Nexus is free/open, so every
 * caller resolves to the highest tier and all gates pass.
 */
export function getTierFromRequest(_request: FastifyRequest): Tier {
  return OPEN_TIER;
}

/** Bearer token validation (constant-time). Dev bypass when NEXUS_API_KEY unset. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authConfig = {
    apiKey: process.env.NEXUS_API_KEY || undefined,
    // Accept user JWTs (issued by /auth/login) in addition to the master API key.
    jwtSecret: process.env.NEXUS_JWT_SECRET || undefined,
    // Dev bypass only when NO auth method is configured at all.
    disabled: !process.env.NEXUS_API_KEY && !process.env.NEXUS_JWT_SECRET,
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
 * requireAuthWithTier — validates the Bearer token and attaches the caller's
 * identity. Nexus is free/open, so `nexusTier` is always the highest tier (no
 * gating); this preHandler exists only to resolve `nexusUserId` for per-user
 * scoping.
 *
 * After this runs, routes can read:
 *   request.nexusTier   — always OPEN_TIER (no paywall)
 *   request.nexusUserId — user ID from JWT sub or api_keys.user_id
 */
export async function requireAuthWithTier(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await requireAuth(request, reply);
  if (reply.sent) return;

  request.nexusTier = OPEN_TIER;

  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return;
  const token = auth.slice(7);

  // Identity from a verified JWT (no DB round-trip).
  const jwtSecret = process.env.NEXUS_JWT_SECRET;
  if (jwtSecret) {
    const payload = _verifyHs256(token, jwtSecret);
    if (payload) {
      request.nexusUserId = typeof payload.sub === "string" ? payload.sub : undefined;
      return;
    }
  }

  // Otherwise resolve the owning user from the api_keys table.
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
      const keyHash = createHmac("sha256", dbUrl).update(token).digest("hex");
      const { rows } = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM api_keys
          WHERE key_hash = $1 AND (revoked_at IS NULL OR revoked_at > NOW())
          LIMIT 1`,
        [keyHash],
      );
      await pool.end();
      if (rows.length > 0) request.nexusUserId = rows[0]!.user_id;
    } catch {
      /* DB unreachable — identity stays undefined, tier already open */
    }
  }
}
