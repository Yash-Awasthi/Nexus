// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth 2.0 routes — Google and GitHub SSO.
 *
 * GET  /oauth/google           — redirect to Google OAuth consent screen
 * GET  /oauth/google/callback  — exchange code → user info → Nexus JWT
 * GET  /oauth/github           — redirect to GitHub OAuth consent screen
 * GET  /oauth/github/callback  — exchange code → user info → Nexus JWT
 *
 * Environment variables:
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 *   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
 *   NEXUS_JWT_SECRET       — HS256 secret; used to sign issued JWTs
 *   OAUTH_REDIRECT_BASE    — base URL for OAuth callbacks
 *                            (default: http://localhost:3000)
 *
 * Issued JWT payload (24-hour TTL):
 *   { sub, email, name?, provider, tier: "free", iat, exp }
 *
 * Clients use the returned `token` as a Bearer token on subsequent requests.
 * Tier is "free" by default; upgrade via POST /billing/subscribe or admin API.
 *
 * Security notes:
 *  - State parameter is generated per-request and stored in KV (5-min TTL)
 *    to prevent CSRF on the callback.
 *  - Tokens are signed HS256 — verifiable by requireAuthWithTier in auth.ts.
 *  - No state is stored server-side after the JWT is issued (stateless).
 */

import { randomBytes } from "node:crypto";

import { signJwt } from "@nexus/auth";
import { db } from "@nexus/db";
import { users, refreshTokens } from "@nexus/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { sha256hex as _sha256hex } from "../lib/crypto-utils.js";
import { makeRateLimitPreHandler } from "../lib/rate-limiter.js";
import { getSharedKV } from "../lib/shared-kv.js";

// IP-keyed limiter for unauthenticated OAuth callback routes (no user yet).
const oauthRL = makeRateLimitPreHandler({ limit: 20, windowMs: 60_000, keyPrefix: "oauth" });

// ── OAuth provider constants ───────────────────────────────────────────────────

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";
const GOOGLE_SCOPE = "openid email profile";

const GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USERINFO = "https://api.github.com/user";

const _redirectBase = (): string => process.env.OAUTH_REDIRECT_BASE ?? "http://localhost:3000";

// ── CSRF state helpers ────────────────────────────────────────────────────────

const STATE_TTL_MS = 5 * 60_000; // 5 minutes

async function _genState(): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  await getSharedKV().set<boolean>(`oauth:state:${state}`, true, STATE_TTL_MS);
  return state;
}

async function _consumeState(state: string): Promise<boolean> {
  const kv = getSharedKV();
  const key = `oauth:state:${state}`;
  const valid = await kv.get<boolean>(key);
  if (valid) await kv.delete(key);
  return !!valid;
}

// ── Route plugin ──────────────────────────────────────────────────────────────

// ── OAuth user upsert + token issuance ────────────────────────────────────────

const _OAUTH_ACCESS_TTL_SEC = 15 * 60;
const _OAUTH_REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

async function upsertOAuthUser(
  email: string,
  name: string | undefined,
  provider: string,
  userAgent: string | undefined,
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  const secret = process.env.NEXUS_JWT_SECRET;
  if (!secret) throw new Error("NEXUS_JWT_SECRET not set");

  let userId: string;
  let role = "member";
  let tier = "free";

  if (process.env.DATABASE_URL) {
    const normalEmail = email.toLowerCase().trim();
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
          name: name?.trim() ?? null,
          role: "member",
          tier: "free",
          emailVerified: true,
        })
        .returning();
      if (!created) throw new Error("User insert failed");
      userId = created.id;
    }
  } else {
    userId = `${provider}:${_sha256hex(email).slice(0, 16)}`;
  }

  const accessToken = signJwt(
    {
      sub: userId,
      role: role as "admin" | "agent" | "read-only",
      tier,
      exp: Math.floor(Date.now() / 1000) + _OAUTH_ACCESS_TTL_SEC,
    } as Parameters<typeof signJwt>[0],
    secret,
  );

  const rawRefresh = randomBytes(32).toString("hex");
  if (process.env.DATABASE_URL) {
    await db.insert(refreshTokens).values({
      userId,
      tokenHash: _sha256hex(rawRefresh),
      expiresAt: new Date(Date.now() + _OAUTH_REFRESH_TTL_MS),
      userAgent: userAgent ?? null,
    });
  }

  return { accessToken, refreshToken: rawRefresh, userId };
}

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  // ── Google ──────────────────────────────────────────────────────────────────

  /**
   * GET /oauth/google
   * Redirect to Google OAuth consent screen.
   * Requires GOOGLE_CLIENT_ID env var.
   */
  app.get("/oauth/google", async (_request, reply) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return reply
        .code(501)
        .send({ error: "Google OAuth not configured (GOOGLE_CLIENT_ID missing)" });
    }
    const state = await _genState();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${_redirectBase()}/api/v1/oauth/google/callback`,
      response_type: "code",
      scope: GOOGLE_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return reply.redirect(`${GOOGLE_AUTH_URL}?${params}`);
  });

  /**
   * GET /oauth/google/callback?code=&state=
   * Exchange authorization code for tokens, fetch user info, issue Nexus JWT.
   */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/oauth/google/callback",
    { preHandler: oauthRL },
    async (request, reply) => {
      const { code, state, error } = request.query;
      if (error) return reply.code(400).send({ error });
      if (!code) return reply.code(400).send({ error: "missing_code" });
      if (!state || !(await _consumeState(state))) {
        return reply.code(400).send({ error: "invalid_state" });
      }

      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return reply.code(501).send({ error: "Google OAuth not configured" });
      }

      try {
        const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: `${_redirectBase()}/api/v1/oauth/google/callback`,
            grant_type: "authorization_code",
          }),
        });
        const tokens = (await tokenRes.json()) as { access_token?: string; error?: string };
        if (!tokens.access_token) {
          return reply.code(401).send({ error: tokens.error ?? "token_exchange_failed" });
        }

        const userRes = await fetch(GOOGLE_USERINFO, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        const user = (await userRes.json()) as { sub?: string; email?: string; name?: string };
        const email = user.email ?? user.sub ?? "unknown@google.com";
        const { accessToken, refreshToken, userId } = await upsertOAuthUser(
          email,
          user.name,
          "google",
          request.headers["user-agent"],
        );
        return reply.send({ accessToken, refreshToken, userId, email, provider: "google" });
      } catch (err) {
        app.log.error(err, "Google OAuth callback error");
        return reply.code(500).send({ error: "oauth_failed" });
      }
    },
  );

  // ── GitHub ──────────────────────────────────────────────────────────────────

  /**
   * GET /oauth/github
   * Redirect to GitHub OAuth consent screen.
   * Requires GITHUB_CLIENT_ID env var.
   */
  app.get("/oauth/github", async (_request, reply) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    if (!clientId) {
      return reply
        .code(501)
        .send({ error: "GitHub OAuth not configured (GITHUB_CLIENT_ID missing)" });
    }
    const state = await _genState();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${_redirectBase()}/api/v1/oauth/github/callback`,
      scope: "read:user user:email",
      state,
    });
    return reply.redirect(`${GITHUB_AUTH_URL}?${params}`);
  });

  /**
   * GET /oauth/github/callback?code=&state=
   * Exchange authorization code for access token, fetch user info, issue Nexus JWT.
   */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/oauth/github/callback",
    { preHandler: oauthRL },
    async (request, reply) => {
      const { code, state, error } = request.query;
      if (error) return reply.code(400).send({ error });
      if (!code) return reply.code(400).send({ error: "missing_code" });
      if (!state || !(await _consumeState(state))) {
        return reply.code(400).send({ error: "invalid_state" });
      }

      const clientId = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return reply.code(501).send({ error: "GitHub OAuth not configured" });
      }

      try {
        const tokenRes = await fetch(GITHUB_TOKEN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: `${_redirectBase()}/api/v1/oauth/github/callback`,
          }),
        });
        const tokens = (await tokenRes.json()) as { access_token?: string; error?: string };
        if (!tokens.access_token) {
          return reply.code(401).send({ error: tokens.error ?? "token_exchange_failed" });
        }

        const userRes = await fetch(GITHUB_USERINFO, {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            "User-Agent": "nexus-api/1.0",
          },
        });
        const user = (await userRes.json()) as {
          id?: number;
          login?: string;
          email?: string;
          name?: string;
        };
        const email = user.email ?? `${user.login ?? "unknown"}@users.noreply.github.com`;
        const { accessToken, refreshToken, userId } = await upsertOAuthUser(
          email,
          user.name ?? user.login,
          "github",
          request.headers["user-agent"],
        );
        return reply.send({ accessToken, refreshToken, userId, email, provider: "github" });
      } catch (err) {
        app.log.error(err, "GitHub OAuth callback error");
        return reply.code(500).send({ error: "oauth_failed" });
      }
    },
  );

  // ── Slack ──────────────────────────────────────────────────────────────────

  /**
   * GET /oauth/slack
   * Redirect to Slack OAuth consent screen.
   * Requires SLACK_CLIENT_ID env var.
   */
  app.get("/oauth/slack", async (_request, reply) => {
    const clientId = process.env.SLACK_CLIENT_ID;
    if (!clientId) {
      return reply
        .code(501)
        .send({ error: "Slack OAuth not configured (SLACK_CLIENT_ID missing)" });
    }
    const state = await _genState();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${_redirectBase()}/api/v1/oauth/slack/callback`,
      scope: "channels:history channels:read users:read",
      state,
    });
    return reply.redirect(`https://slack.com/oauth/v2/authorize?${params}`);
  });

  /** GET /oauth/slack/callback */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/oauth/slack/callback",
    { preHandler: oauthRL },
    async (request, reply) => {
      const { code, state, error } = request.query;
      if (error) return reply.code(400).send({ error });
      if (!code) return reply.code(400).send({ error: "missing_code" });
      if (!state || !(await _consumeState(state))) {
        return reply.code(400).send({ error: "invalid_state" });
      }
      const clientId = process.env.SLACK_CLIENT_ID;
      const clientSecret = process.env.SLACK_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return reply.code(501).send({ error: "Slack OAuth not configured" });
      }
      try {
        const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: `${_redirectBase()}/api/v1/oauth/slack/callback`,
          }),
        });
        const data = (await tokenRes.json()) as {
          ok: boolean;
          access_token?: string;
          team?: { name?: string };
          authed_user?: { id?: string };
          error?: string;
        };
        if (!data.ok || !data.access_token) {
          return reply.code(401).send({ error: data.error ?? "token_exchange_failed" });
        }
        const email = `${data.authed_user?.id ?? "slack_user"}@slack.workspace`;
        const { accessToken, refreshToken, userId } = await upsertOAuthUser(
          email,
          data.team?.name,
          "slack",
          request.headers["user-agent"],
        );
        return reply.send({ accessToken, refreshToken, userId, provider: "slack" });
      } catch (err) {
        app.log.error(err, "Slack OAuth callback error");
        return reply.code(500).send({ error: "oauth_failed" });
      }
    },
  );
}
