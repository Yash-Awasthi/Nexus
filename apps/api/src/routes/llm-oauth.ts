// SPDX-License-Identifier: Apache-2.0
/**
 * Provider OAuth routes — bring-your-own LLM provider account (Google → Vertex AI).
 *
 * PREFIX `/llm-oauth/*`. This is PROVIDER auth (the caller links their own GCP
 * account so Nexus can call Vertex on their project), and is SEPARATE from
 * `oauth.ts` which is user SSO (sign-in → Nexus JWT). They must not collide:
 * different env (`GOOGLE_OAUTH_CLIENT_ID`, not `GOOGLE_CLIENT_ID`), different
 * prefix. See @nexus/llm-oauth for the provider framework + token vault.
 *
 *   GET  /llm-oauth/providers          — catalog (no auth)
 *   POST /llm-oauth/:provider/start    — begin login, returns authUrl (auth'd)
 *   GET  /llm-oauth/:provider/callback — exchange code → seal + persist tokens
 *   POST /llm-oauth/:provider/revoke   — upstream revoke + hard-delete (auth'd)
 *
 * Security posture (SECURITY.md §4/§6):
 *  - `redirectUri` is SERVER-DERIVED (OAUTH_REDIRECT_BASE + fixed path), never
 *    user input — it must match the URI registered in the provider console.
 *  - `PendingAuth` lives in the shared KV keyed by CSRF `state`, TTL 600s,
 *    single-use (delete-on-read). The `state` in the callback IS the capability.
 *  - Tokens / sealed blobs are never logged and never returned to the client.
 *
 * LIVE-CALL GATE: completeLogin/revoke hit the provider token endpoint. Unit
 * tests inject a mocked provider (mocked TokenHttp) so nothing leaves the box;
 * real E2E needs the redirect URI registered upstream first.
 */
import { timingSafeEqual } from "node:crypto";

import {
  registryFromEnv,
  type AuthProviderRegistry,
  type OAuthTokenStore,
  type OAuthTokens,
  type PendingAuth,
} from "@nexus/llm-oauth";
import type { FastifyInstance } from "fastify";

import { createOAuthTokenStore } from "../lib/oauth-token-store.js";
import { makeRateLimitPreHandler } from "../lib/rate-limiter.js";
import { getSharedKV } from "../lib/shared-kv.js";
import { requireAuthWithTier } from "../middleware/auth.js";

// IP-keyed limiter for the unauthenticated callback (no user yet — state is the cap).
const callbackRL = makeRateLimitPreHandler({ limit: 20, windowMs: 60_000, keyPrefix: "llm-oauth" });

const PENDING_TTL_MS = 600_000; // 10 min — matches the provider auth-code lifetime.
const pendingKey = (state: string): string => `llm-oauth:pending:${state}`;

/** What we stash in KV between start and callback: the pending auth + its owner. */
interface StoredPending {
  userId: string;
  pending: PendingAuth;
}

/** Fixed, server-derived callback URI. Never user input (SECURITY.md §4). */
function callbackUri(provider: string): string {
  const base = process.env.OAUTH_REDIRECT_BASE ?? "http://localhost:3000";
  return `${base}/api/v1/llm-oauth/${provider}/callback`;
}

/** Constant-time string compare that never throws on a length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Best-effort upstream revoke for google-vertex. Google's revoke endpoint takes
 * the refresh (preferred) or access token as a form field and returns 200 on
 * success. Errors are swallowed by OAuthTokenStore.revoke — the authoritative
 * local hard-delete still runs. The token is never logged.
 */
async function googleRevoke(tokens: OAuthTokens): Promise<void> {
  const token = tokens.refreshToken ?? tokens.accessToken;
  if (!token) return;
  await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
}

/** Per-provider upstream revoke, or undefined when the provider has none wired. */
function upstreamRevokeFor(providerId: string): ((t: OAuthTokens) => Promise<void>) | undefined {
  return providerId === "google-vertex" ? googleRevoke : undefined;
}

/** Injection seams so unit tests can supply a mocked registry / token store. */
export interface LlmOauthDeps {
  /** Resolve the provider registry (defaults to env-built, per request). */
  getRegistry?: () => AuthProviderRegistry;
  /** Build the token store (defaults to the drizzle-backed factory). */
  makeStore?: () => OAuthTokenStore | null;
}

export function makeLlmOauthRoutes(deps: LlmOauthDeps = {}) {
  const getRegistry = deps.getRegistry ?? (() => registryFromEnv());
  const makeStore = deps.makeStore ?? (() => createOAuthTokenStore());

  return async function llmOauthRoutes(app: FastifyInstance): Promise<void> {
    // ── Catalog ──────────────────────────────────────────────────────────────
    app.get("/llm-oauth/providers", async (_request, reply) => {
      return reply.send({ providers: getRegistry().catalog() });
    });

    // ── Start login ────────────────────────────────────────────────────────────
    app.post<{ Params: { provider: string } }>(
      "/llm-oauth/:provider/start",
      { preHandler: requireAuthWithTier },
      async (request, reply) => {
        const userId = request.nexusUserId;
        if (!userId) return reply.code(401).send({ error: "unauthenticated" });

        const provider = getRegistry().get(request.params.provider);
        if (!provider) return reply.code(404).send({ error: "unknown_or_unsupported_provider" });

        const { authUrl, pending, device } = await provider.startLogin({
          redirectUri: callbackUri(provider.id),
        });

        const stored: StoredPending = { userId, pending };
        await getSharedKV().set(pendingKey(pending.state), stored, PENDING_TTL_MS);

        return reply.send({ authUrl, device });
      },
    );

    // ── Callback ─────────────────────────────────────────────────────────────────
    // No auth: the CSRF `state` (single-use, delete-on-read) IS the capability.
    app.get<{
      Params: { provider: string };
      Querystring: { code?: string; state?: string; error?: string };
    }>(
      "/llm-oauth/:provider/callback",
      { preHandler: callbackRL },
      async (request, reply) => {
        const { code, state, error } = request.query;
        if (error) return reply.code(400).send({ error });
        if (!code) return reply.code(400).send({ error: "missing_code" });
        if (!state) return reply.code(400).send({ error: "missing_state" });

        // Load + delete-on-read. ponytail: get-then-delete is not atomic; a
        // double-submitted state could race, but single-use + 600s TTL bounds it.
        const kv = getSharedKV();
        const key = pendingKey(state);
        const stored = await kv.get<StoredPending>(key);
        if (stored) await kv.delete(key);
        if (!stored) return reply.code(400).send({ error: "invalid_state" });

        const provider = getRegistry().get(request.params.provider);
        if (!provider) return reply.code(404).send({ error: "unknown_or_unsupported_provider" });

        // Defense in depth: the state must belong to THIS provider, and match.
        if (!safeEqual(state, stored.pending.state) || stored.pending.providerId !== provider.id) {
          return reply.code(400).send({ error: "invalid_state" });
        }

        const store = makeStore();
        if (!store) return reply.code(503).send({ error: "vault_unavailable" });

        try {
          const tokens = await provider.completeLogin({ code, pending: stored.pending });
          await store.save(stored.userId, provider.id, tokens);
          return reply.send({ ok: true, provider: provider.id });
        } catch (err) {
          app.log.error(err, "llm-oauth callback: token exchange failed");
          return reply.code(502).send({ error: "token_exchange_failed" });
        }
      },
    );

    // ── Revoke ───────────────────────────────────────────────────────────────────
    app.post<{ Params: { provider: string } }>(
      "/llm-oauth/:provider/revoke",
      { preHandler: requireAuthWithTier },
      async (request, reply) => {
        const userId = request.nexusUserId;
        if (!userId) return reply.code(401).send({ error: "unauthenticated" });

        const provider = getRegistry().get(request.params.provider);
        if (!provider) return reply.code(404).send({ error: "unknown_or_unsupported_provider" });

        const store = makeStore();
        if (!store) return reply.code(503).send({ error: "vault_unavailable" });

        const revoked = await store.revoke(userId, provider.id, upstreamRevokeFor(provider.id));
        return reply.send({ revoked });
      },
    );
  };
}

/** Default plugin used by the server (env-built registry + drizzle token store). */
export const llmOauthRoutes = makeLlmOauthRoutes();
