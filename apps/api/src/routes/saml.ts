// SPDX-License-Identifier: Apache-2.0
/**
 * SAML 2.0 SP-initiated SSO.
 *
 * Environment variables required:
 *   NEXUS_SAML_ENABLED=true          — feature gate
 *   NEXUS_SAML_IDP_SSO_URL           — IdP's SSO endpoint (HTTP-Redirect)
 *   NEXUS_SAML_IDP_ENTITY_ID         — IdP Entity ID URI (the assertion's Issuer)
 *   NEXUS_SAML_IDP_CERT              — IdP X.509 signing certificate (PEM, headers optional)
 *   NEXUS_SAML_SP_ENTITY_ID          — SP Entity ID, also the expected Audience
 *   NEXUS_SAML_SP_ACS_URL            — Assertion Consumer Service URL (callback)
 *   NEXUS_SAML_COOKIE_SECRET         — 32-byte hex string for the RelayState HMAC
 *   NEXUS_FRONTEND_URL               — where the browser goes after sign-in
 *
 * Routes:
 *   GET  /auth/saml/metadata  — SP metadata XML (for IdP registration)
 *   GET  /auth/saml/login     — initiate HTTP-Redirect binding
 *   POST /auth/saml/callback  — ACS endpoint (IdP POST binding)
 *
 * @node-saml/node-saml checks the assertion: XML signature with digest and
 * canonicalization, issuer, audience, time window, and that it answers a
 * request this server made (IDs kept in the shared KV and spent on use).
 * Graceful 501 if NEXUS_SAML_ENABLED is not "true".
 */

import { createHash, createHmac, randomBytes } from "node:crypto";

import { db } from "@nexus/db";
import { users, refreshTokens } from "@nexus/db/schema";
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from "@node-saml/node-saml";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { issueAccessToken } from "../lib/issue-access-token.js";
import { makeRateLimitPreHandler } from "../lib/rate-limiter.js";
import { getSharedKV } from "../lib/shared-kv.js";
import { failSignIn, finishSignIn } from "../lib/sign-in-finish.js";
import { assertMayProvision, SsoPolicyError } from "../lib/sso-provisioning.js";

// 30 SAML initiations per 15 min per IP — prevents SSO redirect spam
const samlLoginRateLimit = makeRateLimitPreHandler({
  limit: 30,
  windowMs: 15 * 60 * 1000,
  keyPrefix: "auth:saml:login",
});

// 20 ACS callbacks per 15 min per IP — prevents SAML response replay attacks
const samlCallbackRateLimit = makeRateLimitPreHandler({
  limit: 20,
  windowMs: 15 * 60 * 1000,
  keyPrefix: "auth:saml:callback",
});

const REQUEST_TTL_MS = 10 * 60_000;

// ── Helpers ────────────────────────────────────────────────────────────────────

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`SAML misconfigured: missing ${key}`);
  return v;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1_000);
}

// ── RelayState (HMAC-signed return path) ──────────────────────────────────────

function makeState(relayState: string): string {
  const secret = process.env.NEXUS_SAML_COOKIE_SECRET ?? randomBytes(32).toString("hex");
  const ts = nowSec().toString(16);
  const nonce = randomBytes(8).toString("hex");
  const payload = `${ts}.${nonce}.${relayState}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
  return `${payload}.${sig}`;
}

function verifyState(state: string): { relayState: string } | null {
  try {
    const secret = process.env.NEXUS_SAML_COOKIE_SECRET ?? "";
    const parts = state.split(".");
    if (parts.length < 4) return null;
    const sig = parts.pop()!;
    const payload = parts.join(".");
    const expected = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
    if (sig !== expected) return null;
    const [ts, , relayState] = parts;
    // State valid for 10 minutes
    if (Math.abs(nowSec() - parseInt(ts!, 16)) > 600) return null;
    return { relayState: relayState ?? "/" };
  } catch {
    return null;
  }
}

// ── SAML client ────────────────────────────────────────────────────────────────

/** Outstanding AuthnRequest IDs, shared across instances so any one can take the answer. */
const requestIds: CacheProvider = {
  async saveAsync(key, value) {
    await getSharedKV().set<string>(`saml:req:${key}`, value, REQUEST_TTL_MS);
    return { value, createdAt: Date.now() };
  },
  async getAsync(key) {
    return (await getSharedKV().get<string>(`saml:req:${key}`)) ?? null;
  },
  async removeAsync(key) {
    if (!key) return null;
    const kv = getSharedKV();
    const value = (await kv.get<string>(`saml:req:${key}`)) ?? null;
    await kv.delete(`saml:req:${key}`);
    return value;
  },
};

function samlClient(): SAML {
  const spEntityId = env("NEXUS_SAML_SP_ENTITY_ID");
  return new SAML({
    entryPoint: env("NEXUS_SAML_IDP_SSO_URL"),
    idpIssuer: env("NEXUS_SAML_IDP_ENTITY_ID"),
    idpCert: env("NEXUS_SAML_IDP_CERT"),
    issuer: spEntityId,
    audience: spEntityId,
    callbackUrl: env("NEXUS_SAML_SP_ACS_URL"),
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    // Most IdPs (Auth0, Okta, Entra) sign the assertion, not the envelope.
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: REQUEST_TTL_MS,
    cacheProvider: requestIds,
    acceptedClockSkewMs: 60_000,
  });
}

// ── Assertion → identity ──────────────────────────────────────────────────────

const CLAIM = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/";

interface SamlIdentity {
  email: string;
  name?: string;
}

function identityOf(profile: Profile): SamlIdentity {
  const attr = (name: string) => {
    const v = profile[name];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const email = (
    profile.email ??
    profile.mail ??
    attr(`${CLAIM}emailaddress`) ??
    (profile.nameID.includes("@") ? profile.nameID : undefined)
  )
    ?.trim()
    .toLowerCase();
  if (!email) throw new SsoPolicyError(400, "no_email", "The assertion carries no email address.");

  // An IdP that says the address is unverified has not proven it; linking on it
  // would let anyone who can type a victim's email into that IdP take the account.
  const verified = attr("http://schemas.auth0.com/email_verified") ?? attr("email_verified");
  if (verified !== undefined && verified !== "true") {
    throw new SsoPolicyError(
      403,
      "email_not_verified",
      "The identity provider did not assert a verified email address.",
    );
  }

  const name =
    attr(`${CLAIM}name`) ??
    ([attr(`${CLAIM}givenname`), attr(`${CLAIM}surname`)].filter(Boolean).join(" ") || undefined);
  return { email, ...(name ? { name } : {}) };
}

// ── User upsert (same pattern as oauth.ts) ────────────────────────────────────

async function upsertSamlUser(
  identity: SamlIdentity,
  userAgent: string,
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  const secret = process.env.NEXUS_JWT_SECRET;
  if (!secret) throw new Error("NEXUS_JWT_SECRET not set");

  // Erased and deactivated accounts stay gone: without the deletedAt filter an
  // SSO sign-in revives a row the user asked to have deleted.
  const [existing] = await db
    .select({ id: users.id, name: users.name, role: users.role, tier: users.tier })
    .from(users)
    .where(and(eq(users.email, identity.email), isNull(users.deletedAt)))
    .limit(1);

  let userId: string;
  let role = "member";
  let tier = "free";
  if (existing) {
    userId = existing.id;
    role = existing.role;
    tier = existing.tier;
    await db
      .update(users)
      .set({
        emailVerified: true,
        ...(!existing.name && identity.name ? { name: identity.name } : {}),
      })
      .where(eq(users.id, userId));
  } else {
    assertMayProvision(identity.email);
    const [newUser] = await db
      .insert(users)
      .values({
        email: identity.email,
        name: identity.name ?? identity.email,
        passwordHash: "oauth:saml:no-password",
        role: "member",
        tier: "free",
        emailVerified: true,
      })
      .returning({ id: users.id });
    userId = newUser!.id;
  }

  const { accessToken } = issueAccessToken(userId, role, tier, secret);

  const rawRefresh = randomBytes(32).toString("hex");
  await db.insert(refreshTokens).values({
    userId,
    tokenHash: createHash("sha256").update(rawRefresh).digest("hex"),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
    userAgent,
  });

  return { accessToken, refreshToken: rawRefresh, userId };
}

// ── Route plugin ───────────────────────────────────────────────────────────────

export async function samlRoutes(app: FastifyInstance): Promise<void> {
  // Feature gate — return 501 if SAML not configured
  const samlEnabled = process.env.NEXUS_SAML_ENABLED === "true";

  if (!samlEnabled) {
    for (const [method, path] of [
      ["get", "/auth/saml/metadata"],
      ["get", "/auth/saml/login"],
      ["post", "/auth/saml/callback"],
    ] as const) {
      app[method](
        path,
        async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
          reply.code(501).send({
            error: "saml_not_configured",
            message: "Set NEXUS_SAML_ENABLED=true and all NEXUS_SAML_* env vars to enable SAML SSO",
          }),
      );
    }
    return;
  }

  // The IdP posts the response as an HTML form; this parser stays inside this plugin.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 1024 * 1024 },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );

  /**
   * GET /auth/saml/metadata
   * Returns SP metadata XML — paste the URL into your IdP to register Nexus as an SP.
   */
  app.get("/auth/saml/metadata", async (_req, reply) => {
    try {
      reply.header("Content-Type", "application/xml; charset=utf-8");
      return reply.send(samlClient().generateServiceProviderMetadata(null, null));
    } catch (err) {
      return reply.code(503).send({ error: "saml_config_error", message: (err as Error).message });
    }
  });

  /**
   * GET /auth/saml/login?redirect=<path>
   * Initiates SP-initiated SSO via HTTP-Redirect binding.
   */
  app.get<{ Querystring: { redirect?: string } }>(
    "/auth/saml/login",
    { preHandler: samlLoginRateLimit },
    async (request, reply) => {
      try {
        const url = await samlClient().getAuthorizeUrlAsync(
          makeState(request.query.redirect ?? "/"),
          undefined,
          {},
        );
        return reply.redirect(url);
      } catch (err) {
        return reply
          .code(503)
          .send({ error: "saml_config_error", message: (err as Error).message });
      }
    },
  );

  /**
   * POST /auth/saml/callback
   * ACS endpoint — IdP POSTs the SAML response here after authentication.
   */
  app.post<{
    Body: { SAMLResponse?: string; RelayState?: string };
  }>("/auth/saml/callback", { preHandler: samlCallbackRateLimit }, async (request, reply) => {
    const frontendUrl = process.env.NEXUS_FRONTEND_URL ?? "http://localhost:5173";
    const fail = (status: number, body: { error: string } & Record<string, unknown>) =>
      failSignIn(request, reply, status, body, frontendUrl);

    const { SAMLResponse, RelayState } = request.body ?? {};
    if (!SAMLResponse) return fail(400, { error: "missing_saml_response" });

    let profile: Profile | null;
    try {
      ({ profile } = await samlClient().validatePostResponseAsync({ SAMLResponse }));
    } catch (err) {
      request.log.warn({ err }, "SAML response refused");
      return fail(401, { error: "saml_response_invalid" });
    }
    if (!profile) return fail(400, { error: "saml_response_invalid" });

    try {
      const { accessToken, refreshToken } = await upsertSamlUser(
        identityOf(profile),
        request.headers["user-agent"] ?? "",
      );
      return finishSignIn(
        request,
        reply,
        refreshToken,
        { accessToken, refreshToken, provider: "saml" },
        {
          appBase: frontendUrl,
          next: RelayState ? verifyState(RelayState)?.relayState : undefined,
        },
      );
    } catch (err) {
      // A refused identity is an answer, not a server fault.
      if (err instanceof SsoPolicyError) {
        return fail(err.statusCode, { error: err.code, message: err.message });
      }
      request.log.error({ err }, "SAML callback error");
      return fail(500, { error: "saml_callback_error" });
    }
  });
}
