// SPDX-License-Identifier: Apache-2.0
/**
 * OpenAPI specs served as MCP endpoints: save a REST API's spec once, then any MCP client (an
 * agent run, Claude Desktop, …) sees its operations as tools.
 *
 *   GET    /api/v1/mcp/openapi          — the caller's saved specs
 *   POST   /api/v1/mcp/openapi          — save { name, spec | specUrl, baseUrl?, authorization? }
 *   DELETE /api/v1/mcp/openapi/:id
 *   POST   /api/v1/mcp/openapi/:id/mcp  — JSON-RPC MCP endpoint (single or batch)
 *
 * The authorization value is encrypted at rest and only ever sent to the spec's API.
 */
import { randomUUID } from "node:crypto";

import { McpHttpServer } from "@nexus/mcp-client";
import { openApiToMcp, type OpenApiSpec } from "@nexus/mcp-openapi";
import type { FastifyInstance } from "fastify";

import { ownsRow } from "../lib/owner.js";
import { PersistentStore } from "../lib/persistent-store.js";
import { callerFetch, fetchPublic, unsafeUrlReason } from "../lib/public-url.js";
import { decryptSecret, encryptSecret } from "../lib/secret-crypto.js";
import { requireAuthWithTier } from "../middleware/auth.js";

interface SavedSpec {
  id: string;
  ownerId: string | null;
  name: string;
  spec: OpenApiSpec;
  baseUrl?: string;
  /** Encrypted Authorization header value. */
  authorization?: string;
  createdAt: string;
}

const store = new PersistentStore<SavedSpec>("mcp_openapi");

function server(saved: SavedSpec): McpHttpServer {
  const { tools, execute } = openApiToMcp(saved.spec, {
    ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}),
    ...(saved.authorization
      ? { headers: { authorization: decryptSecret(saved.authorization) } }
      : {}),
    fetch: callerFetch,
  });
  return new McpHttpServer({ name: saved.name, version: "1.0.0", tools, execute });
}

const view = (s: SavedSpec) => ({
  id: s.id,
  name: s.name,
  tools: openApiToMcp(s.spec).tools.map((t) => t.name),
  url: `/api/v1/mcp/openapi/${s.id}/mcp`,
  createdAt: s.createdAt,
});

export async function mcpOpenApiRoutes(app: FastifyInstance): Promise<void> {
  await store.load();
  const mine = (request: { nexusUserId?: string }, id: string) => {
    const s = store.get(id);
    return s && ownsRow(request, s) ? s : undefined;
  };

  app.get("/mcp/openapi", { preHandler: requireAuthWithTier }, async (request) => ({
    specs: [...store.values()].filter((s) => ownsRow(request, s)).map(view),
  }));

  app.post<{
    Body: {
      name?: string;
      spec?: OpenApiSpec;
      specUrl?: string;
      baseUrl?: string;
      authorization?: string;
    };
  }>("/mcp/openapi", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const { name, specUrl, baseUrl, authorization } = request.body ?? {};
    let spec = request.body?.spec;
    if (!name?.trim()) return reply.code(400).send({ error: "name is required" });
    if (!spec && specUrl) {
      const bad = unsafeUrlReason(specUrl);
      if (bad) return reply.code(400).send({ error: bad });
      const res = await fetchPublic(specUrl).catch(() => null);
      if (!res?.ok) return reply.code(422).send({ error: "Could not fetch the spec" });
      spec = (await res.json().catch(() => null)) as OpenApiSpec | undefined;
    }
    if (!spec?.paths || typeof spec.paths !== "object")
      return reply.code(400).send({ error: "spec (or specUrl) must be an OpenAPI document" });
    const target = baseUrl ?? spec.servers?.[0]?.url;
    const bad = target ? unsafeUrlReason(target) : "the spec names no server: pass baseUrl";
    if (bad) return reply.code(400).send({ error: bad });
    const saved: SavedSpec = {
      id: randomUUID(),
      ownerId: request.nexusUserId ?? null,
      name: name.trim(),
      spec,
      ...(baseUrl ? { baseUrl } : {}),
      ...(authorization ? { authorization: encryptSecret(authorization) } : {}),
      createdAt: new Date().toISOString(),
    };
    store.set(saved.id, saved);
    return reply.code(201).send(view(saved));
  });

  app.delete<{ Params: { id: string } }>(
    "/mcp/openapi/:id",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      if (!mine(request, request.params.id)) return reply.code(404).send({ error: "not found" });
      store.delete(request.params.id);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/mcp/openapi/:id/mcp",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const saved = mine(request, request.params.id);
      if (!saved) return reply.code(404).send({ error: "not found" });
      const res = await server(saved).handle({ method: "POST", path: "/mcp", body: request.body });
      return reply.code(res.status).send(res.body);
    },
  );
}
