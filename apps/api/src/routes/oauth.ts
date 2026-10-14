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
 *   NEXUS_JWT_SECRET       — HS256 signing secret (default alg)
 *   NEXUS_JWT_ALG          — "HS256" (default) or "RS256" (§14.1); RS256 signs
 *                            with NEXUS_JWT_PRIVATE_KEY and verifies with the
 *                            matching public key
 *   OAUTH_REDIRECT_BASE    — base URL for OAuth callbacks
 *                            (default: http://localhost:3000)
 *
 * Issued JWT payload (15-minute TTL):
 *   { sub, role, tier, exp, iat }
 *
 * Clients use the returned `token` as a Bearer token on subsequent requests.
 * Tier is "free" by default; upgrade via POST /billing/subscribe or admin API.
 *
 * Security notes:
 *  - State parameter is generated per-request and stored in KV (5-min TTL)
 *    to prevent CSRF on the callback.
 *  - Tokens are signed per NEXUS_JWT_ALG (HS256 or RS256) via
 *    lib/issue-access-token.ts — always verifiable by requireAuthWithTier.
 *  - No state is stored server-side after the JWT is issued (stateless).
 */

import { randomBytes } from "node:crypto";

import { db } from "@nexus/db";
import { users, refreshTokens } from "@nexus/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { sha256hex as _sha256hex } from "../lib/crypto-utils.ts";
import { issueAccessToken } from "../lib/issue-access-token.ts";
import { makeRateLimitPreHandler } from "../lib/rate-limiter.ts";
import { getSharedKV } from "../lib/shared-kv.ts";
import {
  bindSignInState,
  failSignIn,
  finishSignIn,
  stateFromThisBrowser,
} from "../lib/sign-in-finish.ts";
import { claimForSso } from "../lib/sso-link.ts";

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
const GITHUB_EMAILS = "https://api.github.com/user/emails";

const _redirectBase = (): string => process.env.OAUTH_REDIRECT_BASE ?? "http://localhost:3000";

// ── CSRF state helpers ────────────────────────────────────────────────────────

const STATE_TTL_MS = 5 * 60_000; // 5 minutes

async function _genState(request: FastifyRequest, reply: FastifyReply): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  await getSharedKV().set<boolean>(`oauth:state:${state}`, true, STATE_TTL_MS);
  bindSignInState(request, reply, state);
  return state;
}

async function _consumeState(request: FastifyRequest, state: string): Promise<boolean> {
  if (!stateFromThisBrowser(request, state)) return false;
  const kv = getSharedKV();
  const key = `oauth:state:${state}`;
  const valid = await kv.get<boolean>(key);
  if (valid) await kv.delete(key);
  return !!valid;
}

// ── Route plugin ──────────────────────────────────────────────────────────────

// ── OAuth user upsert + token issuance ────────────────────────────────────────

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
      await claimForSso(existing, provider);
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

  // Issue access token honoring NEXUS_JWT_ALG (§14.1) — role mapped via
  // toNexusRole inside the shared helper (platform roles are not NexusRoles).
  const rawRefresh = randomBytes(32).toString("hex");
  let sid: string | undefined;
  if (process.env.DATABASE_URL) {
    const [row] = await db
      .insert(refreshTokens)
      .values({
        userId,
        tokenHash: _sha256hex(rawRefresh),
        expiresAt: new Date(Date.now() + _OAUTH_REFRESH_TTL_MS),
        userAgent: userAgent ?? null,
      })
      .returning({ id: refreshTokens.id });
    sid = row?.id;
  }
  const { accessToken } = issueAccessToken(userId, role, tier, secret, sid);

  return { accessToken, refreshToken: rawRefresh, userId };
}

/** Accounts from before team-scoped Slack identities move to the new address on next sign-in. */
async function adoptLegacySlackAccount(legacy: string, email: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const [current] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (current) return;
  await db.update(users).set({ email }).where(eq(users.email, legacy));
}

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  // ── Google ──────────────────────────────────────────────────────────────────

  /** Which sign-in providers this server can complete, so the page offers no dead ends. */
  app.get("/oauth/providers", async (_request, reply) =>
    reply.send({
      google: Boolean(process.env.GOOGLE_CLIENT_ID),
      github: Boolean(process.env.GITHUB_CLIENT_ID),
    }),
  );

  /**
   * GET /oauth/google
   * Redirect to Google OAuth consent screen.
   * Requires GOOGLE_CLIENT_ID env var.
   */
  app.get("/oauth/google", async (request, reply) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return reply
        .code(501)
        .send({ error: "Google OAuth not configured (GOOGLE_CLIENT_ID missing)" });
    }
    const state = await _genState(request, reply);
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
      if (error) return failSignIn(request, reply, 400, { error });
      if (!code) return failSignIn(request, reply, 400, { error: "missing_code" });
      if (!state || !(await _consumeState(request, state))) {
        return failSignIn(request, reply, 400, { error: "invalid_state" });
      }

      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return failSignIn(request, reply, 501, { error: "google_not_configured" });
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
          return failSignIn(request, reply, 401, {
            error: tokens.error ?? "token_exchange_failed",
          });
        }

        const userRes = await fetch(GOOGLE_USERINFO, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        const user = (await userRes.json()) as {
          sub?: string;
          email?: string;
          email_verified?: boolean;
          name?: string;
        };
        if (!user.email || user.email_verified !== true) {
          return failSignIn(request, reply, 403, { error: "email_not_verified" });
        }
        const email = user.email;
        const { accessToken, refreshToken, userId } = await upsertOAuthUser(
          email,
          user.name,
          "google",
          request.headers["user-agent"],
        );
        return finishSignIn(request, reply, refreshToken, {
          accessToken,
          refreshToken,
          userId,
          email,
          provider: "google",
        });
      } catch (err) {
        app.log.error(err, "Google OAuth callback error");
        return failSignIn(request, reply, 500, { error: "oauth_failed" });
      }
    },
  );

  // ── GitHub ──────────────────────────────────────────────────────────────────

  /**
   * GET /oauth/github
   * Redirect to GitHub OAuth consent screen.
   * Requires GITHUB_CLIENT_ID env var.
   */
  app.get("/oauth/github", async (request, reply) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    if (!clientId) {
      return reply
        .code(501)
        .send({ error: "GitHub OAuth not configured (GITHUB_CLIENT_ID missing)" });
    }
    const state = await _genState(request, reply);
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
      if (error) return failSignIn(request, reply, 400, { error });
      if (!code) return failSignIn(request, reply, 400, { error: "missing_code" });
      if (!state || !(await _consumeState(request, state))) {
        return failSignIn(request, reply, 400, { error: "invalid_state" });
      }

      const clientId = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return failSignIn(request, reply, 501, { error: "github_not_configured" });
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
          return failSignIn(request, reply, 401, {
            error: tokens.error ?? "token_exchange_failed",
          });
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
          name?: string;
        };
        if (typeof user.id !== "number" || !user.login) {
          return failSignIn(request, reply, 502, { error: "github_profile_invalid" });
        }
        const emailsRes = await fetch(GITHUB_EMAILS, {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            "User-Agent": "nexus-api/1.0",
          },
        });
        const emails: unknown = emailsRes.ok ? await emailsRes.json() : [];
        // GitHub logins can be released and re-registered; the numeric id never moves.
        const verified = (Array.isArray(emails) ? emails : []).filter(
          (e): e is { email: string; primary: boolean } =>
            e?.verified === true && typeof e.email === "string",
        );
        const email =
          (verified.find((e) => e.primary) ?? verified[0])?.email ??
          `${user.id}+${user.login}@users.noreply.github.com`;
        const { accessToken, refreshToken, userId } = await upsertOAuthUser(
          email,
          user.name ?? user.login,
          "github",
          request.headers["user-agent"],
        );
        return finishSignIn(request, reply, refreshToken, {
          accessToken,
          refreshToken,
          userId,
          email,
          provider: "github",
        });
      } catch (err) {
        app.log.error(err, "GitHub OAuth callback error");
        return failSignIn(request, reply, 500, { error: "oauth_failed" });
      }
    },
  );

  // ── Slack ──────────────────────────────────────────────────────────────────

  /**
   * GET /oauth/slack
   * Redirect to Slack OAuth consent screen.
   * Requires SLACK_CLIENT_ID env var.
   */
  app.get("/oauth/slack", async (request, reply) => {
    const clientId = process.env.SLACK_CLIENT_ID;
    if (!clientId) {
      return reply
        .code(501)
        .send({ error: "Slack OAuth not configured (SLACK_CLIENT_ID missing)" });
    }
    const state = await _genState(request, reply);
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
      if (error) return failSignIn(request, reply, 400, { error });
      if (!code) return failSignIn(request, reply, 400, { error: "missing_code" });
      if (!state || !(await _consumeState(request, state))) {
        return failSignIn(request, reply, 400, { error: "invalid_state" });
      }
      const clientId = process.env.SLACK_CLIENT_ID;
      const clientSecret = process.env.SLACK_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return failSignIn(request, reply, 501, { error: "slack_not_configured" });
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
          team?: { id?: string; name?: string };
          authed_user?: { id?: string };
          error?: string;
        };
        if (!data.ok || !data.access_token) {
          return failSignIn(request, reply, 401, { error: data.error ?? "token_exchange_failed" });
        }
        const slackUser = data.authed_user?.id;
        const team = data.team?.id;
        if (!slackUser || !team) {
          return failSignIn(request, reply, 502, { error: "slack_identity_missing" });
        }
        // A Slack user id is only unique within its workspace.
        const email = `${team}.${slackUser}@slack.invalid`.toLowerCase();
        await adoptLegacySlackAccount(`${slackUser}@slack.workspace`.toLowerCase(), email);
        const { accessToken, refreshToken, userId } = await upsertOAuthUser(
          email,
          data.team?.name,
          "slack",
          request.headers["user-agent"],
        );
        return finishSignIn(request, reply, refreshToken, {
          accessToken,
          refreshToken,
          userId,
          provider: "slack",
        });
      } catch (err) {
        app.log.error(err, "Slack OAuth callback error");
        return failSignIn(request, reply, 500, { error: "oauth_failed" });
      }
    },
  );
}
