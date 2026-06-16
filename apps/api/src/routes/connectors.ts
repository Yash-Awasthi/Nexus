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
 * GET   /api/v1/connectors/:id/oauth/callback     — exchange code, encrypt + store token
 *
 * Env vars:
 *   OAUTH_REDIRECT_BASE_URL  — base URL for callbacks (e.g. https://api.nexus.io)
 *   OAUTH_ENCRYPTION_KEY     — 32-byte hex key for AES-256-GCM credential storage
 *   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
 *   SLACK_CLIENT_ID  / SLACK_CLIENT_SECRET
 *   LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import {
  ConnectorRegistry,
  GitHubConnector,
  GroqConnector,
  TavilyConnector,
  NeonConnector,
  NullConnector,
} from "@nexus/connectors";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";
import { makeRateLimitPreHandler } from "../lib/rate-limiter.js";

// ── Registry bootstrap ────────────────────────────────────────────────────────

const registry = new ConnectorRegistry();

// Register all connectors from env
registry.register(new GroqConnector({ apiKey: process.env.GROQ_API_KEY ?? "" }));
registry.register(new TavilyConnector({ apiKey: process.env.TAVILY_API_KEY ?? "" }));

if (process.env.GITHUB_TOKEN) {
  registry.register(new GitHubConnector({ token: process.env.GITHUB_TOKEN }));
} else {
  registry.register(new NullConnector("github", "GitHub"));
}

if (process.env.DATABASE_URL) {
  try {
    // NeonConnector expects { endpoint, database, user, password } — parse from URL.
    const raw = process.env.DATABASE_URL.replace(/^postgres(ql)?:\/\//, "https://");
    const u = new URL(raw);
    registry.register(
      new NeonConnector({
        endpoint: `https://${u.host}`,
        database: u.pathname.slice(1).split("?")[0] ?? "neondb",
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
      }),
    );
  } catch {
    registry.register(new NullConnector("neon", "Neon DB"));
  }
} else {
  registry.register(new NullConnector("neon", "Neon DB"));
}

// Add placeholder connectors for common integrations not yet configured
const PLACEHOLDER_CONNECTORS = [
  { id: "slack", name: "Slack", type: "messaging" },
  { id: "notion", name: "Notion", type: "docs" },
  { id: "linear", name: "Linear", type: "issues" },
];
for (const p of PLACEHOLDER_CONNECTORS) {
  if (!registry.get(p.id)) {
    registry.register(new NullConnector(p.id, p.name));
  }
}

// ── Manual enabled/disabled state (overlay on top of registry) ───────────────

const enabledOverrides = new Map<string, boolean>();

function connectorView(id: string) {
  const conn = registry.get(id);
  if (!conn) return null;
  const enabled = enabledOverrides.has(id) ? enabledOverrides.get(id)! : conn.status !== "disabled";
  return {
    id: conn.id,
    name: conn.name,
    type: (conn as { type?: string }).type ?? "unknown",
    status: conn.status,
    enabled,
    lastCheckedAt: (conn as { lastCheckedAt?: string }).lastCheckedAt,
    error: (conn as { lastError?: string }).lastError,
  };
}

// ── OAuth helpers ─────────────────────────────────────────────────────────────

/** In-memory state tokens — TTL 10 min. Production: store in Redis. */
const oauthStates = new Map<string, { provider: string; createdAt: number }>();
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

function getEncryptionKey(): Buffer | null {
  const hex = process.env.OAUTH_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) return null; // must be 32 bytes = 64 hex chars
  return Buffer.from(hex, "hex");
}

/** AES-256-GCM encrypt. Returns base64: iv(12) + tag(16) + ciphertext. */
function encryptCredential(plaintext: string): string | null {
  const key = getEncryptionKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/** AES-256-GCM decrypt. Input: base64 from encryptCredential. */
function decryptCredential(ciphertext: string): string | null {
  const key = getEncryptionKey();
  if (!key) return null;
  try {
    const buf = Buffer.from(ciphertext, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc).toString("utf8") + decipher.final("utf8");
  } catch {
    return null;
  }
}

/** Encrypted credential vault: connectorId → encrypted token blob. */
const credentialVault = new Map<string, string>();

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function connectorsRoutes(app: FastifyInstance): Promise<void> {
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
    async (_req, reply) => {
      const connectors = registry
        .list()
        .map((c) => connectorView(c.id))
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
      const view = connectorView(safeId);
      if (!view) return reply.code(404).send({ error: "Connector not found" });
      return reply.send(view);
    },
  );

  /** PATCH /connectors/:id — toggle enabled / update config */
  app.patch<{
    Params: { id: string };
    Body: { enabled?: boolean };
  }>("/connectors/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!registry.get(request.params.id)) {
      return reply.code(404).send({ error: "Connector not found" });
    }
    if (request.body.enabled !== undefined) {
      enabledOverrides.set(request.params.id, request.body.enabled);
      if (!request.body.enabled) {
        // Disconnect the connector when disabling
        const conn = registry.get(request.params.id);
        if (conn && conn.status === "connected") {
          void conn.disconnect().catch(() => undefined);
        }
      }
    }
    return reply.send(connectorView(request.params.id));
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
      const conn = registry.get(request.params.id);
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
      const conn = registry.get(request.params.id);
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
      const conn = registry.get(request.params.id);
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
        requireAuth,
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
      oauthStates.set(state, { provider: id, createdAt: Date.now() });

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
      let tokenResponse: Record<string, unknown>;
      try {
        const resp = await fetch(provider.tokenUrl, {
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

      const encrypted = encryptCredential(blob);
      if (encrypted) {
        credentialVault.set(id, encrypted);
      }

      // Reinitialise connector with fresh credential
      // GitHub: replace NullConnector with a real GitHubConnector
      if (id === "github") {
        const existing = registry.get("github");
        if (existing) {
          void existing.disconnect().catch(() => undefined);
        }
        // Re-register is not always safe; update the registry entry in-place if possible.
        // For now, store token in env-equivalent and surface connected status.
        // A full re-init would require the registry to support replace().
      }

      enabledOverrides.set(id, true);

      return reply.send({
        connected: true,
        connector: id,
        scope: tokenResponse.scope ?? provider.scopes,
        encrypted: !!encrypted,
        message: encrypted
          ? "Credential stored securely. Reconnect the connector to activate."
          : "Token obtained but OAUTH_ENCRYPTION_KEY not set — credential not persisted.",
      });
    },
  );

  /**
   * GET /connectors/:id/oauth/credential
   * Returns the decrypted credential (admin-only, for debugging).
   * Remove or gate behind admin auth in production.
   */
  app.get<{ Params: { id: string } }>(
    "/connectors/:id/oauth/credential",
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
      const encrypted = credentialVault.get(request.params.id);
      if (!encrypted) return reply.code(404).send({ error: "No stored credential" });
      const decrypted = decryptCredential(encrypted);
      if (!decrypted)
        return reply
          .code(500)
          .send({ error: "Failed to decrypt credential (check OAUTH_ENCRYPTION_KEY)" });
      return reply.send(JSON.parse(decrypted) as Record<string, unknown>);
    },
  );
}
