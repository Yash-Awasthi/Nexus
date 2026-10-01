// SPDX-License-Identifier: Apache-2.0
/**
 * Connector routes — registry-backed integration management.
 *
 * GET   /api/v1/connectors                        — list all connectors + status
 * POST  /api/v1/connectors/connect                — connect a specific connector (or all)
 * GET   /api/v1/connectors/:id                    — get single connector
 * PATCH /api/v1/connectors/:id                    — toggle enabled / set config
 * POST  /api/v1/connectors/:id/health             — run health check
 * POST  /api/v1/connectors/:id/reconnect          — reconnect
 * POST  /api/v1/connectors/:id/disconnect         — disconnect
 *
 * OAuth 2.0 connector flow (providers: github, slack, linear):
 * GET   /api/v1/connectors/:id/oauth/start        — generate state + redirect URL
 * GET   /api/v1/connectors/:id/oauth/callback     — exchange code, store the token in the owner's secret store
 *
 * Env vars:
 *   OAUTH_REDIRECT_BASE_URL  — base URL for callbacks (e.g. https://api.nexus.io)
 *   NEXUS_SECRETS_KEY        — the secret store key; without it a token is not kept
 *   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
 *   SLACK_CLIENT_ID  / SLACK_CLIENT_SECRET
 *   LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET
 */

import { randomBytes } from "node:crypto";

import {
  ConnectorRegistry,
  GitHubConnector,
  GroqConnector,
  TavilyConnector,
  NeonConnector,
  SlackConnector,
  LinearConnector,
  NotionConnector,
  BitbucketConnector,
  JiraConnector,
  betterStackConnector,
  cloudflareConnector,
  googleCalendarConnector,
  salesforceConnector,
  NullConnector,
  type Connector,
} from "@nexus/connectors";
import { pinnedFetch } from "@nexus/runtime";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { IdleMap } from "../lib/idle-map.js";
import { ownerIdFor } from "../lib/owner.js";
import { PersistentStore } from "../lib/persistent-store.js";
import { makeRateLimitPreHandler } from "../lib/rate-limiter.js";
import {
  SecretEncryptionUnavailableError,
  listSecrets,
  putSecret,
  resolveSecret,
} from "../lib/secret-store.js";
import { requireAuth, requireAuthWithTier } from "../middleware/auth.js";

// ── Registries, one per account ───────────────────────────────────────────────

/** The access token an account stored through a connector's OAuth flow, if any. */
function ownerToken(ownerId: string, id: string): string | undefined {
  const blob = resolveSecret(ownerId, oauthSecretName(id));
  return blob ? (JSON.parse(blob) as { accessToken?: string }).accessToken : undefined;
}

/** NeonConnector's config parsed from DATABASE_URL, or undefined when there is none to parse. */
function neonConfig() {
  if (!process.env.DATABASE_URL) return undefined;
  try {
    const u = new URL(process.env.DATABASE_URL.replace(/^postgres(ql)?:\/\//, "https://"));
    return {
      endpoint: `https://${u.host}`,
      database: u.pathname.slice(1).split("?")[0] ?? "neondb",
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
  } catch {
    return undefined;
  }
}

/** An account's connectors: its own OAuth tokens first, else the server's env credentials. */
function buildRegistry(ownerId: string): ConnectorRegistry {
  const env = process.env;
  const registry = new ConnectorRegistry();
  const add = (id: string, name: string, conn: Connector | false | "" | undefined) =>
    registry.register(conn || new NullConnector(id, name, { placeholder: true }));

  registry.register(new GroqConnector({ apiKey: env.GROQ_API_KEY ?? "" }));
  registry.register(new TavilyConnector({ apiKey: env.TAVILY_API_KEY ?? "" }));
  const github = ownerToken(ownerId, "github") ?? env.GITHUB_TOKEN;
  add("github", "GitHub", github && new GitHubConnector({ token: github }));
  const neon = neonConfig();
  add("neon", "Neon DB", neon && new NeonConnector(neon));
  const slack = ownerToken(ownerId, "slack") ?? env.SLACK_BOT_TOKEN;
  add("slack", "Slack", slack && new SlackConnector({ token: slack }));
  const linear = ownerToken(ownerId, "linear") ?? env.LINEAR_API_KEY;
  add("linear", "Linear", linear && new LinearConnector({ apiKey: linear }));
  add(
    "notion",
    "Notion",
    env.NOTION_API_KEY && new NotionConnector({ apiKey: env.NOTION_API_KEY }),
  );
  add(
    "bitbucket",
    "Bitbucket",
    env.BITBUCKET_TOKEN
      ? new BitbucketConnector({ token: env.BITBUCKET_TOKEN })
      : env.BITBUCKET_USERNAME &&
          env.BITBUCKET_APP_PASSWORD &&
          new BitbucketConnector({
            username: env.BITBUCKET_USERNAME,
            appPassword: env.BITBUCKET_APP_PASSWORD,
          }),
  );
  add(
    "jira",
    "Jira",
    env.JIRA_HOST &&
      env.JIRA_EMAIL &&
      env.JIRA_API_TOKEN &&
      new JiraConnector({
        host: env.JIRA_HOST,
        email: env.JIRA_EMAIL,
        apiToken: env.JIRA_API_TOKEN,
      }),
  );
  add(
    "betterstack",
    "Better Stack",
    env.BETTERSTACK_API_TOKEN && betterStackConnector({ apiToken: env.BETTERSTACK_API_TOKEN }),
  );
  add(
    "cloudflare",
    "Cloudflare",
    env.CLOUDFLARE_API_TOKEN && cloudflareConnector({ apiToken: env.CLOUDFLARE_API_TOKEN }),
  );
  add(
    "salesforce",
    "Salesforce",
    env.SALESFORCE_INSTANCE_URL &&
      env.SALESFORCE_ACCESS_TOKEN &&
      salesforceConnector({
        instanceUrl: env.SALESFORCE_INSTANCE_URL,
        accessToken: env.SALESFORCE_ACCESS_TOKEN,
      }),
  );
  const calendar = ownerToken(ownerId, "google") ?? env.GOOGLE_CALENDAR_TOKEN;
  add(
    "calendar",
    "Google Calendar",
    calendar && googleCalendarConnector({ accessToken: calendar }),
  );
  return registry;
}

// Registries rebuild from env and the secret store, so a quiet account's is dropped;
// which connectors it switched off is its choice, so that is stored.
const _registries = new IdleMap<string, ConnectorRegistry>(60 * 60_000, (r) => {
  void r.disconnectAll().catch(() => undefined);
});
const _enabled = new PersistentStore<Record<string, boolean>>("connector_enabled");

function registryOf(ownerId: string): ConnectorRegistry {
  let r = _registries.get(ownerId);
  if (!r) {
    r = buildRegistry(ownerId);
    _registries.set(ownerId, r);
  }
  return r;
}

function setEnabled(ownerId: string, id: string, on: boolean): void {
  _enabled.set(ownerId, { ...(_enabled.get(ownerId) ?? {}), [id]: on });
}

/** The caller's connector named in the route. */
const connectorFor = (request: FastifyRequest<{ Params: { id: string } }>) =>
  registryOf(ownerIdFor(request)).get(request.params.id);

function connectorView(ownerId: string, id: string) {
  const conn = registryOf(ownerId).get(id);
  if (!conn) return null;
  const enabled = _enabled.get(ownerId)?.[id];
  return {
    id: conn.id,
    name: conn.name,
    type: (conn as { type?: string }).type ?? "unknown",
    status: conn.status,
    enabled: enabled ?? conn.status !== "disabled",
    lastCheckedAt: (conn as { lastCheckedAt?: string }).lastCheckedAt,
    error: (conn as { lastError?: string }).lastError,
  };
}

// ── OAuth helpers ─────────────────────────────────────────────────────────────

/** The secret-store name for a connector's OAuth token. */
const oauthSecretName = (id: string) =>
  `CONNECTOR_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_OAUTH`;

/** In-memory state tokens — TTL 10 min. Production: store in Redis. */
const oauthStates = new Map<string, { provider: string; ownerId: string; createdAt: number }>();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;

function pruneOauthStates(): void {
  const cutoff = Date.now() - OAUTH_STATE_TTL_MS;
  for (const [k, v] of oauthStates.entries()) {
    if (v.createdAt < cutoff) oauthStates.delete(k);
  }
}

interface OAuthProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  clientId: () => string | undefined;
  clientSecret: () => string | undefined;
}

const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  github: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: "repo,user:email",
    clientId: () => process.env.GITHUB_CLIENT_ID,
    clientSecret: () => process.env.GITHUB_CLIENT_SECRET,
  },
  slack: {
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: "channels:read,chat:write,users:read",
    clientId: () => process.env.SLACK_CLIENT_ID,
    clientSecret: () => process.env.SLACK_CLIENT_SECRET,
  },
  linear: {
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopes: "read,write",
    clientId: () => process.env.LINEAR_CLIENT_ID,
    clientSecret: () => process.env.LINEAR_CLIENT_SECRET,
  },
};

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function connectorsRoutes(app: FastifyInstance): Promise<void> {
  await _enabled.load();

  /** GET /connectors */
  app.get(
    "/connectors",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const owner = ownerIdFor(request);
      const connectors = registryOf(owner)
        .list()
        .map((c) => connectorView(owner, c.id))
        .filter(Boolean);
      return reply.send({ connectors, total: connectors.length });
    },
  );

  /** GET /connectors/:id */
  app.get<{ Params: { id: string } }>(
    "/connectors/:id",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      // Sanitise the URL param before use — prevents reflected XSS when the id
      // is echoed back in the response body through the connector view.
      const safeId = encodeURIComponent(request.params.id);
      const view = connectorView(ownerIdFor(request), safeId);
      if (!view) return reply.code(404).send({ error: "Connector not found" });
      return reply.send(view);
    },
  );

  /** PATCH /connectors/:id — toggle enabled / update config */
  app.patch<{
    Params: { id: string };
    Body: { enabled?: boolean };
  }>("/connectors/:id", { preHandler: requireAuth }, async (request, reply) => {
    const owner = ownerIdFor(request);
    const conn = registryOf(owner).get(request.params.id);
    if (!conn) return reply.code(404).send({ error: "Connector not found" });
    if (request.body.enabled !== undefined) {
      setEnabled(owner, request.params.id, request.body.enabled);
      if (!request.body.enabled && conn.status === "connected")
        void conn.disconnect().catch(() => undefined);
    }
    return reply.send(connectorView(owner, request.params.id));
  });

  /** POST /connectors/connect — connect all or a specific connector */
  app.post<{ Body: { id?: string } }>(
    "/connectors/connect",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const registry = registryOf(ownerIdFor(request));
      if (request.body.id) {
        const conn = registry.get(request.body.id);
        if (!conn) return reply.code(404).send({ error: "Connector not found" });
        const result = await conn.connect();
        return reply.send({ connectorId: request.body.id, result });
      }
      const results = await registry.connectAll();
      return reply.send({ results });
    },
  );

  /** POST /connectors/:id/health */
  app.post<{ Params: { id: string } }>(
    "/connectors/:id/health",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: [
        requireAuth,
        makeRateLimitPreHandler({ limit: 30, windowMs: 60_000, keyPrefix: "conn-health" }),
      ],
    },
    async (request, reply) => {
      const conn = connectorFor(request);
      if (!conn) return reply.code(404).send({ error: "Connector not found" });
      const result = await conn.healthCheck();
      return reply.send(result);
    },
  );

  /** POST /connectors/:id/reconnect */
  app.post<{ Params: { id: string } }>(
    "/connectors/:id/reconnect",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const conn = connectorFor(request);
      if (!conn) return reply.code(404).send({ error: "Connector not found" });
      await conn.disconnect();
      const result = await conn.connect();
      return reply.send(result);
    },
  );

  /** POST /connectors/:id/disconnect */
  app.post<{ Params: { id: string } }>(
    "/connectors/:id/disconnect",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: [
        requireAuth,
        makeRateLimitPreHandler({ limit: 30, windowMs: 60_000, keyPrefix: "conn-disconnect" }),
      ],
    },
    async (request, reply) => {
      const conn = connectorFor(request);
      if (!conn) return reply.code(404).send({ error: "Connector not found" });
      await conn.disconnect();
      return reply.code(204).send();
    },
  );

  // ── OAuth 2.0 flow ──────────────────────────────────────────────────────────

  /**
   * GET /connectors/:id/oauth/start
   * Generates a state token and returns the provider's authorization URL.
   * The client should redirect the user to `authorizeUrl`.
   */
  app.get<{ Params: { id: string } }>(
    "/connectors/:id/oauth/start",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: [
        requireAuthWithTier,
        makeRateLimitPreHandler({ limit: 10, windowMs: 60_000, keyPrefix: "conn-oauth-start" }),
      ],
    },
    async (request, reply) => {
      const { id } = request.params;
      const provider = OAUTH_PROVIDERS[id];
      if (!provider) {
        return reply
          .code(404)
          .send({ error: `No OAuth provider configured for connector "${id}"` });
      }
      const clientId = provider.clientId();
      if (!clientId) {
        return reply.code(503).send({
          error: `OAuth client ID not configured for "${id}". Set ${id.toUpperCase()}_CLIENT_ID env var.`,
        });
      }

      pruneOauthStates();

      // Generate a cryptographically random state token
      const state = randomBytes(24).toString("hex");
      oauthStates.set(state, { provider: id, ownerId: ownerIdFor(request), createdAt: Date.now() });

      const redirectBase = process.env.OAUTH_REDIRECT_BASE_URL ?? "http://localhost:3001";
      const callbackUri = `${redirectBase}/api/v1/connectors/${id}/oauth/callback`;

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUri,
        scope: provider.scopes,
        state,
        response_type: "code",
      });

      return reply.send({
        authorizeUrl: `${provider.authorizeUrl}?${params.toString()}`,
        state,
        expiresIn: OAUTH_STATE_TTL_MS / 1_000,
      });
    },
  );

  /**
   * GET /connectors/:id/oauth/callback?code=...&state=...
   * Exchanges the authorization code for a token, encrypts it, and stores it.
   * Reinitializes the connector with the new credential.
   */
  app.get<{
    Params: { id: string };
    Querystring: { code?: string; state?: string; error?: string };
  }>(
    "/connectors/:id/oauth/callback",
    {
      preHandler: makeRateLimitPreHandler({
        limit: 10,
        windowMs: 60_000,
        keyPrefix: "conn-oauth-cb",
      }),
    },
    async (request, reply) => {
      const { id } = request.params;
      const { code, state, error: oauthError } = request.query;

      // Provider reported an error
      if (oauthError) {
        return reply.code(400).send({ error: `OAuth provider error: ${oauthError}` });
      }
      if (!code || !state) {
        return reply.code(400).send({ error: "Missing code or state parameter" });
      }

      // Validate state
      pruneOauthStates();
      const stateEntry = oauthStates.get(state);
      if (!stateEntry || stateEntry.provider !== id) {
        return reply.code(400).send({ error: "Invalid or expired state token" });
      }
      oauthStates.delete(state);

      const provider = OAUTH_PROVIDERS[id];
      if (!provider) {
        return reply.code(404).send({ error: `Unknown OAuth provider: ${id}` });
      }
      const clientId = provider.clientId();
      const clientSecret = provider.clientSecret();
      if (!clientId || !clientSecret) {
        return reply.code(503).send({ error: `OAuth credentials not configured for "${id}"` });
      }

      const redirectBase = process.env.OAUTH_REDIRECT_BASE_URL ?? "http://localhost:3001";
      const callbackUri = `${redirectBase}/api/v1/connectors/${id}/oauth/callback`;

      // Exchange code for token
      // Socket-pinned fetch: the token URL is per-provider config, not raw user
      // input, but this is a user-triggered outbound POST — pin the socket to
      // the validated DNS answer to close the DNS-rebinding window (defense in
      // depth, consistent with the mcp-servers.ts live-call sink).
      let tokenResponse: Record<string, unknown>;
      try {
        const resp = await pinnedFetch(provider.tokenUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: callbackUri,
            grant_type: "authorization_code",
          }),
        });
        if (!resp.ok) {
          return reply.code(502).send({ error: `Token exchange failed: HTTP ${resp.status}` });
        }
        tokenResponse = (await resp.json()) as Record<string, unknown>;
      } catch (err) {
        return reply.code(502).send({ error: `Token exchange network error: ${String(err)}` });
      }

      const accessToken =
        (tokenResponse.access_token as string | undefined) ??
        (tokenResponse.token as string | undefined);

      if (!accessToken) {
        return reply.code(502).send({
          error: "Token exchange did not return access_token",
          detail: tokenResponse,
        });
      }

      // Encrypt and store the credential
      const blob = JSON.stringify({
        accessToken,
        tokenType: tokenResponse.token_type ?? "bearer",
        scope: tokenResponse.scope ?? provider.scopes,
        obtainedAt: new Date().toISOString(),
        raw: tokenResponse,
      });

      // The callback carries no session; the state names whose flow this is.
      let stored = true;
      try {
        putSecret(stateEntry.ownerId, oauthSecretName(id), blob, `${id} connector OAuth token`);
      } catch (err) {
        if (!(err instanceof SecretEncryptionUnavailableError)) throw err;
        stored = false;
      }

      // Rebuild the account's connectors so the new token is the one they use.
      void _registries
        .get(stateEntry.ownerId)
        ?.disconnectAll()
        .catch(() => undefined);
      _registries.set(stateEntry.ownerId, buildRegistry(stateEntry.ownerId));
      setEnabled(stateEntry.ownerId, id, true);

      return reply.send({
        connected: true,
        connector: id,
        scope: tokenResponse.scope ?? provider.scopes,
        encrypted: stored,
        message: stored
          ? "Credential stored in your secret store. Reconnect the connector to activate."
          : "Token obtained but NEXUS_SECRETS_KEY is not set, so it was not stored.",
      });
    },
  );

  /**
   * GET /connectors/:id/oauth/credential
   * Metadata about the caller's stored credential (scope, obtained-at, fingerprint).
   * The token itself is never returned, not even masked.
   */
  app.get<{ Params: { id: string } }>(
    "/connectors/:id/oauth/credential",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          404: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuthWithTier,
    },
    async (request, reply) => {
      const owner = ownerIdFor(request);
      const name = oauthSecretName(request.params.id);
      const meta = listSecrets(owner).find((x) => x.name === name);
      const value = meta ? resolveSecret(owner, name) : null;
      if (!meta || !value) return reply.code(404).send({ error: "No stored credential" });
      const credential = JSON.parse(value) as {
        tokenType?: string;
        scope?: string;
        obtainedAt?: string;
      };
      return reply.send({
        connector: request.params.id,
        tokenType: credential.tokenType ?? "bearer",
        scope: credential.scope ?? null,
        obtainedAt: credential.obtainedAt ?? null,
        fingerprint: meta.fingerprint,
      });
    },
  );
}
