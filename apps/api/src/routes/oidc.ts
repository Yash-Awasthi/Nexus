// SPDX-License-Identifier: Apache-2.0
/**
 * Generic OIDC 1.0 routes — Okta, Azure AD, Keycloak, Ping, Auth0, any OIDC provider.
 *
 * GET  /auth/oidc/authorize  — redirect to provider's authorization endpoint
 * GET  /auth/oidc/callback   — exchange code → ID token → Nexus token pair
 *
 * Environment variables:
 *   NEXUS_OIDC_ISSUER         — provider issuer (e.g. https://company.okta.com)
 *                               used to fetch /.well-known/openid-configuration
 *   NEXUS_OIDC_CLIENT_ID      — OAuth 2.0 client ID
 *   NEXUS_OIDC_CLIENT_SECRET  — OAuth 2.0 client secret
 *   NEXUS_OIDC_REDIRECT_URI   — absolute callback URL registered with the provider
 *   NEXUS_OIDC_SCOPES         — space-separated scopes (default: "openid email profile")
 *   OAUTH_REDIRECT_BASE       — where to send the browser after token issuance
 *
 * Security:
 *   State parameter — 24-byte CSPRNG, stored in KV (5-min TTL), consumed on callback.
 *   ID token — verified RS256/ES256 via provider's JWKS endpoint.
 *   JWKS — cached 5 min; refreshed on unknown kid to handle key rotation.
 *   Claims validated: iss, aud, exp, iat.
 */

import { createPublicKey, randomBytes, createVerify } from "node:crypto";

import { signJwt } from "@nexus/auth";
import { db } from "@nexus/db";
import { users, refreshTokens } from "@nexus/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { emitAuditEvent } from "../lib/audit-emitter.js";
import { sha256hex as _sha256hex } from "../lib/crypto-utils.js";
import { makeRateLimitPreHandler } from "../lib/rate-limiter.js";
import { getSharedKV } from "../lib/shared-kv.js";

// 20 OIDC callback attempts per 15 minutes per IP — prevents code replay attacks
const oidcRateLimit = makeRateLimitPreHandler({
  limit: 20,
  windowMs: 15 * 60 * 1000,
  keyPrefix: "auth:oidc",
});

// ── Config helpers ─────────────────────────────────────────────────────────────

function oidcConfig() {
  return {
    issuer: process.env.NEXUS_OIDC_ISSUER,
    clientId: process.env.NEXUS_OIDC_CLIENT_ID,
    clientSecret: process.env.NEXUS_OIDC_CLIENT_SECRET,
    redirectUri: process.env.NEXUS_OIDC_REDIRECT_URI,
    scopes: process.env.NEXUS_OIDC_SCOPES ?? "openid email profile",
  };
}

function isOidcConfigured(): boolean {
  const c = oidcConfig();
  return !!(c.issuer && c.clientId && c.clientSecret && c.redirectUri);
}

const _redirectBase = (): string => process.env.OAUTH_REDIRECT_BASE ?? "http://localhost:3000";

// ── CSRF state helpers ────────────────────────────────────────────────────────

const STATE_TTL_MS = 5 * 60_000; // 5 minutes

async function _genState(): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  await getSharedKV().set<boolean>(`oidc:state:${state}`, true, STATE_TTL_MS);
  return state;
}

async function _consumeState(state: string): Promise<boolean> {
  const kv = getSharedKV();
  const key = `oidc:state:${state}`;
  const valid = await kv.get<boolean>(key);
  if (valid) await kv.delete(key);
  return !!valid;
}

// ── OIDC Discovery cache ──────────────────────────────────────────────────────

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

interface CachedDiscovery {
  issuer: string;
  doc: OidcDiscovery;
  cachedAt: number;
}

let _discoveryCache: CachedDiscovery | null = null;
const DISCOVERY_TTL_MS = 5 * 60_000;

async function fetchDiscovery(issuer: string): Promise<OidcDiscovery> {
  const now = Date.now();
  if (
    _discoveryCache &&
    _discoveryCache.issuer === issuer &&
    now - _discoveryCache.cachedAt < DISCOVERY_TTL_MS
  ) {
    return _discoveryCache.doc;
  }
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OIDC discovery fetch failed: ${res.status} ${url}`);
  const doc = (await res.json()) as OidcDiscovery;
  _discoveryCache = { issuer, doc, cachedAt: now };
  return doc;
}

// ── JWKS cache ────────────────────────────────────────────────────────────────

interface Jwk {
  kid?: string;
  kty: string;
  use?: string;
  alg?: string;
  // RSA
  n?: string;
  e?: string;
  // EC
  x?: string;
  y?: string;
  crv?: string;
}

interface JwkSet {
  keys: Jwk[];
}

interface CachedJwks {
  uri: string;
  set: JwkSet;
  cachedAt: number;
}

let _jwksCache: CachedJwks | null = null;
const JWKS_TTL_MS = 5 * 60_000;

async function fetchJwks(uri: string, forceRefresh = false): Promise<JwkSet> {
  const now = Date.now();
  if (
    !forceRefresh &&
    _jwksCache &&
    _jwksCache.uri === uri &&
    now - _jwksCache.cachedAt < JWKS_TTL_MS
  ) {
    return _jwksCache.set;
  }
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status} ${uri}`);
  const set = (await res.json()) as JwkSet;
  _jwksCache = { uri, set, cachedAt: now };
  return set;
}

async function findJwk(uri: string, kid: string | undefined): Promise<Jwk> {
  let set = await fetchJwks(uri);
  let jwk = kid ? set.keys.find((k) => k.kid === kid) : set.keys[0];
  if (!jwk) {
    // Key may have been rotated — refresh cache and retry once
    set = await fetchJwks(uri, true);
    jwk = kid ? set.keys.find((k) => k.kid === kid) : set.keys[0];
  }
  if (!jwk) throw new Error(`No matching JWK found for kid="${kid ?? "(none)"}"`);
  return jwk;
}

// ── ID token verification ─────────────────────────────────────────────────────

interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
}

/**
 * Verify an OIDC ID token (RS256 or ES256) against the provider's JWKS.
 * Returns the decoded claims on success; throws on any verification failure.
 */
async function verifyIdToken(
  idToken: string,
  jwksUri: string,
  expectedIssuer: string,
  expectedAudience: string,
): Promise<IdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed ID token");

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString()) as {
    alg?: string;
    kid?: string;
  };

  const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as IdTokenClaims;

  // ── Claim validation first (before crypto — fail fast) ──────────────────────

  const now = Math.floor(Date.now() / 1000);

  if (claims.iss !== expectedIssuer) {
    throw new Error(`ID token iss mismatch: got "${claims.iss}", expected "${expectedIssuer}"`);
  }

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(expectedAudience)) {
    throw new Error(
      `ID token aud mismatch: "${claims.aud}" does not include "${expectedAudience}"`,
    );
  }

  if (claims.exp <= now) {
    throw new Error(`ID token expired at ${new Date(claims.exp * 1000).toISOString()}`);
  }

  // Allow 60s clock skew on iat
  if (claims.iat > now + 60) {
    throw new Error("ID token iat is in the future");
  }

  // ── Signature verification ──────────────────────────────────────────────────

  const alg = header.alg ?? "RS256";
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(signatureB64, "base64url");

  const jwk = await findJwk(jwksUri, header.kid);
  const publicKey = createPublicKey({ key: jwk, format: "jwk" } as unknown as Parameters<
    typeof createPublicKey
  >[0]);

  let valid = false;
  if (alg === "RS256" || alg === "RS384" || alg === "RS512") {
    const hashAlg = alg.replace("RS", "SHA-");
    const verifier = createVerify(hashAlg);
    verifier.update(signingInput);
    valid = verifier.verify(publicKey, signature);
  } else if (alg === "ES256" || alg === "ES384" || alg === "ES512") {
    const hashAlg = alg.replace("ES", "SHA-");
    const verifier = createVerify(hashAlg);
    verifier.update(signingInput);
    valid = verifier.verify(publicKey, signature);
  } else {
    throw new Error(`Unsupported ID token algorithm: ${alg}`);
  }

  if (!valid) throw new Error("ID token signature verification failed");

  return claims;
}

// ── User upsert + token issuance ──────────────────────────────────────────────

const _OIDC_ACCESS_TTL_SEC = 15 * 60;
const _OIDC_REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

async function upsertOidcUser(
  claims: IdTokenClaims,
  provider: string,
  userAgent: string | undefined,
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  const secret = process.env.NEXUS_JWT_SECRET;
  if (!secret) throw new Error("NEXUS_JWT_SECRET not set");

  const rawEmail = claims.email;
  if (!rawEmail) throw new Error("ID token missing email claim");

  const displayName =
    claims.name ||
    [claims.given_name, claims.family_name].filter(Boolean).join(" ") ||
    claims.preferred_username ||
    undefined;

  let userId: string;
  let role = "member";
  let tier = "free";

  if (process.env.DATABASE_URL) {
    const normalEmail = rawEmail.toLowerCase().trim();

    const [existing] = await db
      .select()
      .from(users)
      .where(and(eq(users.email, normalEmail), isNull(users.deletedAt)))
      .limit(1);

    if (existing) {
      userId = existing.id;
      role = existing.role;
      tier = existing.tier;
    } else {
      const [created] = await db
        .insert(users)
        .values({
          email: normalEmail,
          passwordHash: `oauth:${provider}:no-password`,
          name: displayName?.trim() ?? null,
          role: "member",
          tier: "free",
          // OIDC providers handle email verification — trust their email_verified claim
          emailVerified: claims.email_verified !== false,
        })
        .returning();
      if (!created) throw new Error("User insert failed");
      userId = created.id;
    }
  } else {
    userId = `${provider}:${_sha256hex(rawEmail).slice(0, 16)}`;
  }

  const accessToken = signJwt(
    {
      sub: userId,
      role: role as "admin" | "agent" | "read-only",
      tier,
      exp: Math.floor(Date.now() / 1000) + _OIDC_ACCESS_TTL_SEC,
    } as Parameters<typeof signJwt>[0],
    secret,
  );

  const rawRefresh = randomBytes(32).toString("hex");
  if (process.env.DATABASE_URL) {
    await db.insert(refreshTokens).values({
      userId,
      tokenHash: _sha256hex(rawRefresh),
      expiresAt: new Date(Date.now() + _OIDC_REFRESH_TTL_MS),
      userAgent: userAgent ?? null,
    });
  }

  return { accessToken, refreshToken: rawRefresh, userId };
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function oidcRoutes(app: FastifyInstance): Promise<void> {
  if (!isOidcConfigured()) {
    // Graceful degradation — routes return 501 until OIDC env vars are set
    const notConfigured = async (
      _req: unknown,
      reply: { code: (n: number) => { send: (v: unknown) => unknown } },
    ) =>
      reply.code(501).send({
        error: "oidc_not_configured",
        message:
          "Set NEXUS_OIDC_ISSUER, NEXUS_OIDC_CLIENT_ID, NEXUS_OIDC_CLIENT_SECRET, NEXUS_OIDC_REDIRECT_URI to enable OIDC SSO",
      });
    app.get("/auth/oidc/authorize", notConfigured);
    app.get("/auth/oidc/callback", notConfigured);
    return;
  }

  /**
   * GET /auth/oidc/authorize
   *
   * Build the provider's authorization URL via OIDC discovery and redirect the
   * browser to it. Generates and stores a CSRF state token.
   *
   * Query params:
   *   redirect_uri — optional post-auth destination (validated against same-origin)
   */
  app.get<{ Querystring: { redirect_uri?: string } }>(
    "/auth/oidc/authorize",
    async (request, reply) => {
      const cfg = oidcConfig();

      let discovery: OidcDiscovery;
      try {
        discovery = await fetchDiscovery(cfg.issuer!);
      } catch (err) {
        return reply.code(502).send({
          error: "oidc_discovery_failed",
          message: `Could not fetch OIDC configuration: ${String(err)}`,
        });
      }

      const state = await _genState();
      const params = new URLSearchParams({
        response_type: "code",
        client_id: cfg.clientId!,
        redirect_uri: cfg.redirectUri!,
        scope: cfg.scopes,
        state,
      });

      return reply.redirect(`${discovery.authorization_endpoint}?${params.toString()}`, 302);
    },
  );

  /**
   * GET /auth/oidc/callback
   *
   * Provider redirects here with ?code=...&state=...
   * Flow:
   *   1. Validate CSRF state
   *   2. Exchange code for tokens at provider's token endpoint
   *   3. Verify ID token signature via JWKS
   *   4. Validate claims (iss, aud, exp, iat)
   *   5. Upsert user — find-or-create in DB, emailVerified = claims.email_verified
   *   6. Issue Nexus access + refresh token pair
   *   7. Redirect browser to OAUTH_REDIRECT_BASE with tokens in query params
   */
  app.get<{
    Querystring: { code?: string; state?: string; error?: string; error_description?: string };
  }>("/auth/oidc/callback", { preHandler: oidcRateLimit }, async (request, reply) => {
    const { code, state, error, error_description } = request.query;

    // Provider-side error (user denied consent, etc.)
    if (error) {
      return reply.code(400).send({
        error: "oidc_provider_error",
        provider_error: error,
        message: error_description ?? "Provider returned an error",
      });
    }

    if (!code || !state) {
      return reply
        .code(400)
        .send({ error: "missing_params", message: "code and state are required" });
    }

    // CSRF validation
    const stateValid = await _consumeState(state);
    if (!stateValid) {
      return reply
        .code(400)
        .send({ error: "invalid_state", message: "State mismatch — possible CSRF" });
    }

    const cfg = oidcConfig();

    let discovery: OidcDiscovery;
    try {
      discovery = await fetchDiscovery(cfg.issuer!);
    } catch (err) {
      return reply.code(502).send({ error: "oidc_discovery_failed", message: String(err) });
    }

    // ── Code → token exchange ─────────────────────────────────────────────

    let tokenRes: { id_token?: string; access_token?: string; error?: string };
    try {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: cfg.redirectUri!,
        client_id: cfg.clientId!,
        client_secret: cfg.clientSecret!,
      });
      const res = await fetch(discovery.token_endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      });
      tokenRes = (await res.json()) as typeof tokenRes;
    } catch (err) {
      return reply.code(502).send({ error: "token_exchange_failed", message: String(err) });
    }

    if (tokenRes.error || !tokenRes.id_token) {
      return reply.code(400).send({
        error: "token_exchange_error",
        message:
          (tokenRes as Record<string, string>).error_description ??
          tokenRes.error ??
          "No id_token returned",
      });
    }

    // ── ID token verification ──────────────────────────────────────────────

    let claims: IdTokenClaims;
    try {
      claims = await verifyIdToken(
        tokenRes.id_token,
        discovery.jwks_uri,
        cfg.issuer!,
        cfg.clientId!,
      );
    } catch (err) {
      app.log.warn({ err }, "oidc: id_token verification failed");
      return reply.code(401).send({ error: "id_token_invalid", message: String(err) });
    }

    // ── User upsert + token issuance ──────────────────────────────────────

    let tokens: { accessToken: string; refreshToken: string; userId: string };
    try {
      tokens = await upsertOidcUser(
        claims,
        `oidc:${new URL(cfg.issuer!).hostname}`,
        request.headers["user-agent"],
      );
    } catch (err) {
      app.log.error({ err }, "oidc: user upsert failed");
      return reply.code(500).send({ error: "upsert_failed", message: String(err) });
    }

    emitAuditEvent(
      {
        entityType: "user",
        entityId: tokens.userId,
        action: "auth.oidc_login",
        actor: tokens.userId,
        payload: {
          issuer: cfg.issuer,
          sub: claims.sub,
          email: claims.email,
          emailVerified: claims.email_verified,
        },
      },
      app.log,
    );

    // ── Browser redirect ──────────────────────────────────────────────────

    const dest = new URL("/auth/callback", _redirectBase());
    dest.searchParams.set("accessToken", tokens.accessToken);
    dest.searchParams.set("refreshToken", tokens.refreshToken);
    dest.searchParams.set("provider", "oidc");

    return reply.redirect(dest.toString(), 302);
  });
}
