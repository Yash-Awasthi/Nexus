// SPDX-License-Identifier: Apache-2.0
/**
 * Connector routes — registry-backed integration management.
 *
 * GET   /api/v1/connectors           — list all connectors + status
 * POST  /api/v1/connectors/connect   — connect a specific connector (or all)
 * GET   /api/v1/connectors/:id       — get single connector
 * PATCH /api/v1/connectors/:id       — toggle enabled / set config
 * POST  /api/v1/connectors/:id/health — run health check
 * POST  /api/v1/connectors/:id/reconnect — reconnect
 * POST  /api/v1/connectors/:id/disconnect — disconnect
 */

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

// ── Registry bootstrap ────────────────────────────────────────────────────────

const registry = new ConnectorRegistry();

// Register all connectors from env
registry.register(new GroqConnector({ apiKey: process.env.GROQ_API_KEY ?? "" }));
registry.register(new TavilyConnector({ apiKey: process.env.TAVILY_API_KEY ?? "" }));

if (process.env.GITHUB_TOKEN) {
  registry.register(new GitHubConnector({ token: process.env.GITHUB_TOKEN }));
} else {
  registry.register(new NullConnector({ id: "github", name: "GitHub" }));
}

if (process.env.DATABASE_URL) {
  registry.register(new NeonConnector({ connectionString: process.env.DATABASE_URL }));
} else {
  registry.register(new NullConnector({ id: "neon", name: "Neon DB" }));
}

// Add placeholder connectors for common integrations not yet configured
const PLACEHOLDER_CONNECTORS = [
  { id: "slack",   name: "Slack",   type: "messaging" },
  { id: "notion",  name: "Notion",  type: "docs"      },
  { id: "linear",  name: "Linear",  type: "issues"    },
];
for (const p of PLACEHOLDER_CONNECTORS) {
  if (!registry.has(p.id)) {
    registry.register(new NullConnector(p));
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

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function connectorsRoutes(app: FastifyInstance): Promise<void> {
  /** GET /connectors */
  app.get("/connectors", { preHandler: requireAuth }, async (_req, reply) => {
    const connectors = registry.ids().map((id) => connectorView(id)).filter(Boolean);
    return reply.send({ connectors, total: connectors.length });
  });

  /** GET /connectors/:id */
  app.get<{ Params: { id: string } }>(
    "/connectors/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const view = connectorView(request.params.id);
      if (!view) return reply.code(404).send({ error: "Connector not found" });
      return reply.send(view);
    },
  );

  /** PATCH /connectors/:id — toggle enabled / update config */
  app.patch<{
    Params: { id: string };
    Body: { enabled?: boolean };
  }>("/connectors/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!registry.has(request.params.id)) {
      return reply.code(404).send({ error: "Connector not found" });
    }
    if (request.body.enabled !== undefined) {
      enabledOverrides.set(request.params.id, request.body.enabled);
      if (!request.body.enabled) {
        registry.disable(request.params.id);
      }
    }
    return reply.send(connectorView(request.params.id));
  });

  /** POST /connectors/connect — connect all or a specific connector */
  app.post<{ Body: { id?: string } }>(
    "/connectors/connect",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (request.body.id) {
        const conn = registry.get(request.body.id);
        if (!conn) return reply.code(404).send({ error: "Connector not found" });
        const result = await conn.connect();
        return reply.send({ [request.body.id]: result });
      }
      const results = await registry.connectAll();
      return reply.send({ results });
    },
  );

  /** POST /connectors/:id/health */
  app.post<{ Params: { id: string } }>(
    "/connectors/:id/health",
    { preHandler: requireAuth },
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
    { preHandler: requireAuth },
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
    { preHandler: requireAuth },
    async (request, reply) => {
      const conn = registry.get(request.params.id);
      if (!conn) return reply.code(404).send({ error: "Connector not found" });
      await conn.disconnect();
      return reply.code(204).send();
    },
  );
}
