// SPDX-License-Identifier: Apache-2.0
/**
 * MCP server registry — per-user CRUD for external MCP servers.
 *
 * Registered under the versioned /api/v1 scope, so the live paths are:
 *   GET    /api/v1/mcp/servers          — list the caller's servers (no raw key)
 *   POST   /api/v1/mcp/servers          — create
 *   PUT    /api/v1/mcp/servers/:id      — update (key write-only: empty = keep)
 *   DELETE /api/v1/mcp/servers/:id      — soft-delete
 *   POST   /api/v1/mcp/servers/:id/test — connect, list tools, persist health
 *
 * Security: every route is auth-gated (requireAuthWithTier → request.nexusUserId)
 * and ownership-checked. An optional API key is encrypted at rest fail-closed
 * (SecretCryptoUnavailableError → 503); the decrypted key is only ever used
 * server-side (the /test path) and never returned over HTTP — responses expose
 * `keyPrefix` only.
 */
import { db } from "@nexus/db";
import { mcpServers } from "@nexus/db/schema";
import { McpClient } from "@nexus/mcp-client";
import { isSafeUrl } from "@nexus/runtime";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { pinnedFetch } from "../lib/pinned-fetch.js";
import {
  encryptSecret,
  decryptSecret,
  SecretCryptoUnavailableError,
} from "../lib/secret-crypto.js";
import { requireAuthWithTier } from "../middleware/auth.js";

const TRANSPORTS = ["http", "stdio", "websocket"] as const;
type Transport = (typeof TRANSPORTS)[number];

// Columns safe to return over HTTP — explicitly excludes encrypted_api_key.
const SAFE_COLUMNS = {
  id: mcpServers.id,
  name: mcpServers.name,
  description: mcpServers.description,
  transportType: mcpServers.transportType,
  endpoint: mcpServers.endpoint,
  keyPrefix: mcpServers.keyPrefix,
  config: mcpServers.config,
  tools: mcpServers.tools,
  status: mcpServers.status,
  enabled: mcpServers.enabled,
  createdAt: mcpServers.createdAt,
  updatedAt: mcpServers.updatedAt,
  lastHealthCheckAt: mcpServers.lastHealthCheckAt,
};

/**
 * SSRF guard for user-supplied MCP endpoint URLs. Returns an error message to
 * send to the client, or null when the endpoint is safe.
 *
 * Delegates host safety to `@nexus/runtime`'s shared `isSafeUrl`, so this now
 * blocks — in addition to the old localhost/127 list — RFC1918 private ranges
 * (10/8, 172.16/12, 192.168/16), link-local 169.254/16 (cloud metadata / IMDS),
 * CGNAT, multicast/reserved, cloud-metadata hostnames, IPv6 loopback/ULA/
 * link-local, and the decimal/hex/octal/IPv4-mapped-IPv6 encodings attackers use
 * to smuggle those addresses past a naïve string check. The URL parse and scheme
 * checks stay inline to keep the granular client-facing messages.
 *
 * Note: this is a *static* host check. A hostname that resolves to a private IP
 * only at request time (DNS rebinding) still passes here; the /test outbound call
 * pins the socket via `pinnedFetch` (safeLookup) to block that at connect time.
 */
export function validateMcpEndpoint(endpoint: string): string | null {
  const trimmed = endpoint.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "endpoint must be a valid URL";
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return "endpoint must use http or https scheme";
  }
  if (!isSafeUrl(trimmed)) {
    return "endpoint host is not allowed (loopback, private, or reserved address)";
  }
  return null;
}

export async function mcpServersRoutes(app: FastifyInstance): Promise<void> {
  // ── List ────────────────────────────────────────────────────────────────────
  app.get("/mcp/servers", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const userId = request.nexusUserId!;
    const servers = await db
      .select(SAFE_COLUMNS)
      .from(mcpServers)
      .where(and(eq(mcpServers.userId, userId), isNull(mcpServers.deletedAt)));
    return reply.send({ servers, total: servers.length });
  });

  // ── Create ────────────────────────────────────────────────────────────────────
  app.post<{
    Body: {
      name?: string;
      description?: string;
      transportType?: string;
      endpoint?: string;
      apiKey?: string;
      config?: Record<string, unknown>;
    };
  }>("/mcp/servers", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const userId = request.nexusUserId!;
    const {
      name,
      description,
      transportType = "http",
      endpoint,
      apiKey,
      config,
    } = request.body ?? {};

    if (!name?.trim()) return reply.code(400).send({ error: "name is required" });
    if (!endpoint?.trim()) return reply.code(400).send({ error: "endpoint is required" });
    // Validate endpoint URL: only http/https schemes, block internal/loopback SSRF
    const endpointErr = validateMcpEndpoint(endpoint);
    if (endpointErr) return reply.code(400).send({ error: endpointErr });
    if (!TRANSPORTS.includes(transportType as Transport)) {
      return reply.code(400).send({ error: "invalid_transport", valid: TRANSPORTS });
    }

    let encryptedApiKey: string | null = null;
    let keyPrefix: string | null = null;
    if (apiKey) {
      try {
        encryptedApiKey = encryptSecret(apiKey);
      } catch (e) {
        if (e instanceof SecretCryptoUnavailableError)
          return reply.code(503).send({ error: "encryption_unavailable" });
        throw e;
      }
      keyPrefix = apiKey.slice(0, 8);
    }

    try {
      const [row] = await db
        .insert(mcpServers)
        .values({
          userId,
          name: name.trim(),
          description: description ?? null,
          transportType,
          endpoint: endpoint.trim(),
          encryptedApiKey,
          keyPrefix,
          config: config ?? null,
        })
        .returning(SAFE_COLUMNS);
      return reply.code(201).send(row);
    } catch (e) {
      // Unique (user, name) violation → 409 rather than a 500.
      if (e instanceof Error && /duplicate key|unique/i.test(e.message))
        return reply.code(409).send({ error: "name_taken" });
      throw e;
    }
  });

  // ── Update ────────────────────────────────────────────────────────────────────
  app.put<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string;
      transportType?: string;
      endpoint?: string;
      apiKey?: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
    };
  }>("/mcp/servers/:id", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const userId = request.nexusUserId!;
    const [existing] = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.id, request.params.id), isNull(mcpServers.deletedAt)))
      .limit(1);
    if (!existing) return reply.code(404).send({ error: "not_found" });
    if (existing.userId !== userId) return reply.code(403).send({ error: "forbidden" });

    const { name, description, transportType, endpoint, apiKey, config, enabled } =
      request.body ?? {};
    if (transportType && !TRANSPORTS.includes(transportType as Transport)) {
      return reply.code(400).send({ error: "invalid_transport", valid: TRANSPORTS });
    }
    // Validate endpoint URL on update (mirrors create validation)
    if (endpoint?.trim()) {
      const endpointErr = validateMcpEndpoint(endpoint);
      if (endpointErr) return reply.code(400).send({ error: endpointErr });
    }

    // Key is write-only: an empty/absent apiKey keeps the stored one.
    let encryptedApiKey = existing.encryptedApiKey;
    let keyPrefix = existing.keyPrefix;
    if (apiKey) {
      try {
        encryptedApiKey = encryptSecret(apiKey);
      } catch (e) {
        if (e instanceof SecretCryptoUnavailableError)
          return reply.code(503).send({ error: "encryption_unavailable" });
        throw e;
      }
      keyPrefix = apiKey.slice(0, 8);
    }

    const [row] = await db
      .update(mcpServers)
      .set({
        name: name?.trim() ?? existing.name,
        description: description ?? existing.description,
        transportType: transportType ?? existing.transportType,
        endpoint: endpoint?.trim() ?? existing.endpoint,
        encryptedApiKey,
        keyPrefix,
        config: config ?? existing.config,
        enabled: enabled ?? existing.enabled,
      })
      .where(eq(mcpServers.id, request.params.id))
      .returning(SAFE_COLUMNS);
    return reply.send(row);
  });

  // ── Delete (soft) ───────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    "/mcp/servers/:id",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const userId = request.nexusUserId!;
      const [row] = await db
        .select({ id: mcpServers.id, userId: mcpServers.userId })
        .from(mcpServers)
        .where(and(eq(mcpServers.id, request.params.id), isNull(mcpServers.deletedAt)))
        .limit(1);
      if (!row) return reply.code(404).send({ error: "not_found" });
      if (row.userId !== userId) return reply.code(403).send({ error: "forbidden" });
      await db
        .update(mcpServers)
        .set({ deletedAt: new Date(), enabled: false })
        .where(eq(mcpServers.id, request.params.id));
      return reply.send({ ok: true });
    },
  );

  // ── Test connection ───────────────────────────────────────────────────────────
  // Decrypts the key server-side, connects, lists tools, and persists health.
  // Makes a live outbound request to the configured endpoint.
  app.post<{ Params: { id: string } }>(
    "/mcp/servers/:id/test",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const userId = request.nexusUserId!;
      const [server] = await db
        .select()
        .from(mcpServers)
        .where(and(eq(mcpServers.id, request.params.id), isNull(mcpServers.deletedAt)))
        .limit(1);
      if (!server) return reply.code(404).send({ error: "not_found" });
      if (server.userId !== userId) return reply.code(403).send({ error: "forbidden" });

      // Defense-in-depth: re-validate the stored endpoint at the live-call sink.
      // Create/update already guard, but a row written under an older/weaker guard
      // (or via direct DB access) could hold a private/IMDS endpoint the current
      // isSafeUrl rejects — never make the outbound request to it.
      const endpointErr = validateMcpEndpoint(server.endpoint);
      if (endpointErr) return reply.code(400).send({ error: endpointErr });

      if (server.transportType !== "http") {
        return reply
          .code(400)
          .send({ error: "unsupported_transport", message: "Only http transport can be tested." });
      }

      let apiKey: string | undefined;
      if (server.encryptedApiKey) {
        try {
          apiKey = decryptSecret(server.encryptedApiKey);
        } catch (e) {
          if (e instanceof SecretCryptoUnavailableError)
            return reply.code(503).send({ error: "encryption_unavailable" });
          throw e;
        }
      }

      const headers =
        server.config && typeof server.config === "object" && "headers" in server.config
          ? (server.config.headers as Record<string, string>)
          : undefined;

      try {
        const client = new McpClient({
          serverUrl: server.endpoint,
          apiKey,
          extraHeaders: headers,
          timeoutMs: 15_000,
          // Socket-pinned fetch: blocks a hostname that re-resolves to a private
          // / IMDS address between validateMcpEndpoint above and this live call
          // (DNS rebinding) — the static check alone can't catch that.
          fetchFn: pinnedFetch,
        });
        const serverInfo = await client.initialize();
        const tools = await client.listTools();
        const toolNames = tools.map((t) => t.name);

        await db
          .update(mcpServers)
          .set({ status: "active", tools: toolNames, lastHealthCheckAt: new Date() })
          .where(eq(mcpServers.id, server.id));

        return reply.send({ ok: true, serverInfo, tools: toolNames });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await db
          .update(mcpServers)
          .set({ status: "error", lastHealthCheckAt: new Date() })
          .where(eq(mcpServers.id, server.id));
        return reply.code(502).send({ ok: false, error: "connection_failed", message });
      }
    },
  );
}
