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

import { createHmac, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";

import { getSharedKV } from "../lib/shared-kv.js";

// ── JWT issuer (HS256 — compatible with verifier in auth.ts) ──────────────────

function _b64url(data: string): string {
  return Buffer.from(data).toString("base64url");
}

function _issueJwt(payload: Record<string, unknown>): string {
  const secret = process.env.NEXUS_JWT_SECRET;
  if (!secret) throw new Error("NEXUS_JWT_SECRET not set — cannot issue JWT");
  const now  = Math.floor(Date.now() / 1_000);
  const full = { iat: now, exp: now + 86_400, ...payload };
  const h    = _b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p    = _b64url(JSON.stringify(full));
  const sig  = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

// ── OAuth provider constants ───────────────────────────────────────────────────

const GOOGLE_AUTH_URL  = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO  = "https://www.googleapis.com/oauth2/v3/userinfo";
const GOOGLE_SCOPE     = "openid email profile";

const GITHUB_AUTH_URL  = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USERINFO  = "https://api.github.com/user";

const _redirectBase = (): string =>
  process.env.OAUTH_REDIRECT_BASE ?? "http://localhost:3000";

// ── CSRF state helpers ────────────────────────────────────────────────────────

const STATE_TTL_MS = 5 * 60_000; // 5 minutes

async function _genState(): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  await getSharedKV().set<boolean>(`oauth:state:${state}`, true, STATE_TTL_MS);
  return state;
}

async function _consumeState(state: string): Promise<boolean> {
  const kv   = getSharedKV();
  const key  = `oauth:state:${state}`;
  const valid = await kv.get<boolean>(key);
  if (valid) await kv.delete(key);
  return !!valid;
}

// ── Route plugin ──────────────────────────────────────────────────────────────

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
      return reply.code(501).send({ error: "Google OAuth not configured (GOOGLE_CLIENT_ID missing)" });
    }
    const state  = await _genState();
    const params = new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  `${_redirectBase()}/api/v1/oauth/google/callback`,
      response_type: "code",
      scope:         GOOGLE_SCOPE,
      access_type:   "offline",
      prompt:        "consent",
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
    async (request, reply) => {
      const { code, state, error } = request.query;
      if (error)  return reply.code(400).send({ error });
      if (!code)  return reply.code(400).send({ error: "missing_code" });
      if (!state || !(await _consumeState(state))) {
        return reply.code(400).send({ error: "invalid_state" });
      }

      const clientId     = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return reply.code(501).send({ error: "Google OAuth not configured" });
      }

      try {
        const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
          method:  "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body:    new URLSearchParams({
            code,
            client_id:     clientId,
            client_secret: clientSecret,
            redirect_uri:  `${_redirectBase()}/api/v1/oauth/google/callback`,
            grant_type:    "authorization_code",
          }),
        });
        const tokens = (await tokenRes.json()) as { access_token?: string; error?: string };
        if (!tokens.access_token) {
          return reply.code(401).send({ error: tokens.error ?? "token_exchange_failed" });
        }

        const userRes = await fetch(GOOGLE_USERINFO, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        const user   = (await userRes.json()) as { sub?: string; email?: string; name?: string };
        const userId = `google:${user.sub ?? user.email ?? "unknown"}`;

        const token = _issueJwt({
          sub:      userId,
          email:    user.email,
          name:     user.name,
          provider: "google",
          tier:     "free",
        });
        return reply.send({ token, userId, email: user.email });
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
      return reply.code(501).send({ error: "GitHub OAuth not configured (GITHUB_CLIENT_ID missing)" });
    }
    const state  = await _genState();
    const params = new URLSearchParams({
      client_id:    clientId,
      redirect_uri: `${_redirectBase()}/api/v1/oauth/github/callback`,
      scope:        "read:user user:email",
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
    async (request, reply) => {
      const { code, state, error } = request.query;
      if (error)  return reply.code(400).send({ error });
      if (!code)  return reply.code(400).send({ error: "missing_code" });
      if (!state || !(await _consumeState(state))) {
        return reply.code(400).send({ error: "invalid_state" });
      }

      const clientId     = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return reply.code(501).send({ error: "GitHub OAuth not configured" });
      }

      try {
        const tokenRes = await fetch(GITHUB_TOKEN_URL, {
          method:  "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept":       "application/json",
          },
          body: new URLSearchParams({
            code,
            client_id:     clientId,
            client_secret: clientSecret,
            redirect_uri:  `${_redirectBase()}/api/v1/oauth/github/callback`,
          }),
        });
        const tokens = (await tokenRes.json()) as { access_token?: string; error?: string };
        if (!tokens.access_token) {
          return reply.code(401).send({ error: tokens.error ?? "token_exchange_failed" });
        }

        const userRes = await fetch(GITHUB_USERINFO, {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            "User-Agent":  "nexus-api/1.0",
          },
        });
        const user   = (await userRes.json()) as { id?: number; login?: string; email?: string; name?: string };
        const userId = `github:${user.id ?? user.login ?? "unknown"}`;

        const token = _issueJwt({
          sub:      userId,
          email:    user.email,
          name:     user.name ?? user.login,
          provider: "github",
          tier:     "free",
        });
        return reply.send({ token, userId, email: user.email });
      } catch (err) {
        app.log.error(err, "GitHub OAuth callback error");
        return reply.code(500).send({ error: "oauth_failed" });
      }
    },
  );
}
