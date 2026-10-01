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

import { authenticate, AuthError, verifyJwtRS256 } from "@nexus/auth";
import type { Tier } from "@nexus/tier-gate";
import type { FastifyRequest, FastifyReply } from "fastify";

import { sessionRevocations } from "../lib/auth-hardening.js";
import { sha256hex } from "../lib/crypto-utils.js";
import { patScopesAllow } from "../lib/pat-scopes.js";
import { verifyPat } from "../lib/pat-store.js";
import { getPgPool } from "../lib/pg-pool.js";

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
    // RFC 7519: a token is invalid at its exp second, not one second after.
    if (payload.exp !== undefined && payload.exp <= Math.floor(Date.now() / 1000)) return null;
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

/** Process-wide pool for the api_keys lookup below; never ended. */

// ── Fastify request augmentation ──────────────────────────────────────────────

declare module "fastify" {
  interface FastifyRequest {
    nexusTier?: Tier;
    nexusUserId?: string;
    /** The signed role of a signed-in caller: "admin" for owners and admins. */
    nexusRole?: string;
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

/**
 * Identity guard for routes that are meaningless without an owner.
 *
 * `requireAuthWithTier` leaves `nexusUserId` unset for a caller that
 * authenticated with the master API key, which owns no user. Routes keyed on
 * `user_id` must reject such a caller rather than query with an absent owner.
 * Sends 401 and returns null; otherwise returns the identity.
 */
export async function requireUserId(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string | null> {
  const userId = request.nexusUserId;
  if (!userId) {
    await reply.code(401).send({
      code: "IDENTITY_REQUIRED",
      message: "This endpoint requires a user identity; the master API key has none.",
    });
    return null;
  }
  return userId;
}

/** Requests whose caller is already known, so no layer verifies the token twice for it. */
const resolved = new WeakSet<FastifyRequest>();

/** Bearer token validation (constant-time). Dev bypass when NEXUS_API_KEY unset. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authConfig = {
    apiKey: process.env.NEXUS_API_KEY || undefined,
    // Accept user JWTs (issued by /auth/login) in addition to the master API key.
    jwtSecret: process.env.NEXUS_JWT_SECRET || undefined,
    // RS256 (asymmetric) mode (§14.1): verify with the public key, alg-pinned.
    jwtAlg: (process.env.NEXUS_JWT_ALG === "RS256" ? "RS256" : "HS256") as "HS256" | "RS256",
    jwtPublicKey: process.env.NEXUS_JWT_PUBLIC_KEY || undefined,
    // Reject revoked sessions (§14.3) on every verified JWT.
    revocations: sessionRevocations,
    // Dev bypass only when NO auth method is configured at all.
    disabled:
      !process.env.NEXUS_API_KEY &&
      !process.env.NEXUS_JWT_SECRET &&
      !process.env.NEXUS_JWT_PUBLIC_KEY,
  };
  try {
    authenticate(request.headers.authorization, authConfig);
    await resolveIdentity(request);
  } catch (err) {
    if (err instanceof AuthError) {
      // Personal-access tokens (playtest round 4): an `nxk_` token minted via
      // /tokens authenticates even when the master-key/JWT path rejects it.
      const m = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "");
      if (m?.[1]?.startsWith("nxk_")) {
        const pat = await verifyPat(m[1]);
        if (pat) {
          // Scope enforcement (playtest round 7): scopes flowed mint → DB →
          // list but gated nothing. Now a restricted token may only reach
          // endpoints inside its areas (lib/pat-scopes.ts owns the semantics;
          // "*" / no scopes = full access, unchanged for existing tokens).
          if (!patScopesAllow(pat.scopes, request.url)) {
            await reply.code(403).send({
              code: "INSUFFICIENT_SCOPE",
              message: "Token scope does not allow this endpoint",
            });
            return;
          }
          request.nexusUserId = pat.ownerId;
          resolved.add(request);
          return;
        }
      }
      await reply.code(err.httpStatus).send({ code: err.code, message: err.message });
      return;
    }
    await reply.code(500).send({ code: "INTERNAL_ERROR", message: "Auth check failed" });
  }
}

/** requireAuth plus `nexusTier`, which is always OPEN_TIER: Nexus has no paywall. */
export async function requireAuthWithTier(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await requireAuth(request, reply);
  if (reply.sent) return;
  request.nexusTier = OPEN_TIER;
}

/** Attach the caller's user id: from the JWT, a personal-access token, or an api_keys row. */
export async function resolveIdentity(request: FastifyRequest): Promise<void> {
  if (resolved.has(request)) return;
  resolved.add(request);
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return;
  const token = auth.slice(7);

  // Identity from a verified JWT (no DB round-trip).
  const jwtSecret = process.env.NEXUS_JWT_SECRET;
  const jwtPublicKey = process.env.NEXUS_JWT_PUBLIC_KEY;
  const jwtAlg = process.env.NEXUS_JWT_ALG === "RS256" ? "RS256" : "HS256";
  if (jwtSecret || (jwtAlg === "RS256" && jwtPublicKey)) {
    let payload: JwtPayload | null = null;
    if (jwtAlg === "RS256" && jwtPublicKey) {
      try {
        payload = verifyJwtRS256(token, jwtPublicKey) as unknown as JwtPayload;
      } catch {
        payload = null; // fall through — identity stays undefined
      }
    } else if (jwtSecret) {
      payload = _verifyHs256(token, jwtSecret);
    }
    if (payload) {
      request.nexusUserId = typeof payload.sub === "string" ? payload.sub : undefined;
      const { role } = payload as { role?: unknown };
      if (typeof role === "string") request.nexusRole = role;
      return;
    }
  }

  // Personal-access tokens (playtest round 4): identity comes from the PAT
  // owner — no DB round-trip. Only short-circuits when the PAT verifies; an
  // unknown nxk_ value still falls through to the api_keys lookup below.
  if (token.startsWith("nxk_")) {
    const pat = await verifyPat(token);
    if (pat) {
      request.nexusUserId = pat.ownerId;
      return;
    }
  }

  // Otherwise resolve the owning user from the api_keys table. Both writers of
  // key_hash (pat-store, packages/billing) store an unkeyed SHA-256 hex, and the
  // validity predicate must mirror verifyPat's: checking revoked_at alone would
  // let an expired PAT row resolve an identity here.
  const pool = getPgPool();
  if (pool) {
    try {
      const { rows } = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM api_keys
          WHERE key_hash = $1
            AND (revoked_at IS NULL OR revoked_at > NOW())
            AND (expires_at IS NULL OR expires_at > NOW())
          LIMIT 1`,
        [sha256hex(token)],
      );
      if (rows.length > 0) request.nexusUserId = rows[0]!.user_id;
    } catch {
      /* DB unreachable — identity stays undefined, tier already open */
    }
  }
}
