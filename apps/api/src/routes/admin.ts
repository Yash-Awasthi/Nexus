// SPDX-License-Identifier: Apache-2.0
/**
 * Admin routes — route management, runtime stats, admin settings.
 *
 * GET  /api/v1/admin/routes      — list all model alias routes + override status
 * POST /api/v1/admin/routes      — add a static route
 * DELETE /api/v1/admin/routes/:alias  — remove a route
 * POST /api/v1/admin/routes/:alias/override — set a runtime override
 * DELETE /api/v1/admin/routes/:alias/override — remove a runtime override
 * GET  /api/v1/admin/stats       — usage stats per alias
 * POST /api/v1/admin/stats/:alias/record — record a request (internal)
 * GET  /api/v1/admin/settings    — current admin settings
 * POST /api/v1/admin/settings    — update admin settings (partial)
 */

import { GatewayAdminService } from "@nexus/admin-gateway";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

import { DRIVER_ALIASES, gatewayLog } from "./gateway.js";

// ── Singleton admin service ───────────────────────────────────────────────────

const adminService = new GatewayAdminService();

// Bootstrap static routes from the DRIVER_ALIASES table
for (const [alias, target] of Object.entries(DRIVER_ALIASES)) {
  adminService.addRoute(alias, target.model, target.provider);
}

// ── In-memory admin settings store ───────────────────────────────────────────

interface AdminSettings {
  tracing: boolean;
  logLevel: string;
  rateLimitRpm: number;
  maxTokens: number;
  defaultModel: string;
  corsOrigins: string[];
}

let adminSettings: AdminSettings = {
  tracing: process.env.NEXUS_TRACING === "true",
  logLevel: process.env.LOG_LEVEL ?? "info",
  rateLimitRpm: 60,
  maxTokens: 4096,
  defaultModel: "nexus/smart",
  corsOrigins: process.env.ALLOWED_ORIGINS?.split(",") ?? ["http://localhost:5173"],
};

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  /** GET /admin/routes */
  app.get("/admin/routes", { preHandler: requireAuth }, async (_req, reply) => {
    const routes = adminService.listRoutes();
    return reply.send({ routes, total: routes.length });
  });

  /** POST /admin/routes — add static route */
  app.post<{ Body: { alias: string; model: string; provider: string } }>(
    "/admin/routes",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          required: ["alias", "model", "provider"],
          properties: {
            alias: { type: "string", minLength: 1, maxLength: 100 },
            model: { type: "string", minLength: 1, maxLength: 200 },
            provider: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        adminService.addRoute(request.body.alias, request.body.model, request.body.provider);
        return reply.code(201).send({
          alias: request.body.alias,
          model: request.body.model,
          provider: request.body.provider,
        });
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        return reply.code(400).send({ error: e.code, message: e.message });
      }
    },
  );

  /** DELETE /admin/routes/:alias */
  app.delete<{ Params: { alias: string } }>(
    "/admin/routes/:alias",
    {
      schema: {
        response: { 200: { type: "object", additionalProperties: true }, 204: { type: "null" } },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      adminService.removeRoute(decodeURIComponent(request.params.alias));
      return reply.code(204).send();
    },
  );

  /** POST /admin/routes/:alias/override */
  app.post<{ Params: { alias: string }; Body: { model: string } }>(
    "/admin/routes/:alias/override",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          required: ["model"],
          properties: {
            model: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        adminService.overrideAlias(decodeURIComponent(request.params.alias), request.body.model);
        return reply.send({ alias: request.params.alias, overrideModel: request.body.model });
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        return reply.code(400).send({ error: e.code, message: e.message });
      }
    },
  );

  /** DELETE /admin/routes/:alias/override */
  app.delete<{ Params: { alias: string } }>(
    "/admin/routes/:alias/override",
    {
      schema: {
        response: { 200: { type: "object", additionalProperties: true }, 204: { type: "null" } },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      adminService.removeOverride(decodeURIComponent(request.params.alias));
      return reply.code(204).send();
    },
  );

  /** GET /admin/stats */
  app.get<{ Querystring: { alias?: string } }>(
    "/admin/stats",
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
      const stats = adminService.getStats(
        request.query.alias ? decodeURIComponent(request.query.alias) : undefined,
      );
      return reply.send({ stats });
    },
  );

  /** POST /admin/stats/:alias/record — internal: record request for stats */
  app.post<{
    Params: { alias: string };
    Body: { tokens?: number; latencyMs?: number; error?: boolean };
  }>(
    "/admin/stats/:alias/record",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          properties: {
            tokens: { type: "number", minimum: 0 },
            latencyMs: { type: "number", minimum: 0 },
            error: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      adminService.recordRequest(decodeURIComponent(request.params.alias), request.body);
      return reply.code(204).send();
    },
  );

  /** GET /admin/settings */
  app.get(
    "/admin/settings",
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
      return reply.send({ settings: adminSettings });
    },
  );

  /**
   * GET /admin/traces?provider=&model=&status=&limit=&since=&before=
   *
   * Query the gateway request log (MemoryGatewayLog circular buffer, 10 k entries).
   * Results are returned most-recent first.
   */
  app.get<{
    Querystring: {
      provider?: string;
      model?: string;
      status?: "success" | "error" | "cached";
      limit?: string;
      since?: string;
      before?: string;
      identity?: string;
    };
  }>("/admin/traces", { preHandler: requireAuth }, async (request, reply) => {
    const { provider, model, status, limit, since, before, identity } = request.query;
    const entries = await gatewayLog.query({
      provider,
      model,
      status,
      identity,
      limit: limit ? Math.min(parseInt(limit, 10), 1000) : 100,
      since: since ? parseInt(since, 10) : undefined,
      before: before ? parseInt(before, 10) : undefined,
    });
    return reply.send({ entries, total: entries.length });
  });

  /** GET /admin/traces/stats — aggregate stats for the logged requests */
  app.get(
    "/admin/traces/stats",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_request, reply) => {
      const [stats, count] = await Promise.all([gatewayLog.stats(), gatewayLog.count()]);
      return reply.send({ ...stats, total: count });
    },
  );

  /** DELETE /admin/traces — flush the circular buffer */
  app.delete("/admin/traces", { preHandler: requireAuth }, async (_request, reply) => {
    await gatewayLog.clear();
    return reply.code(204).send();
  });

  /** POST /admin/settings — partial update */
  app.post<{ Body: Partial<AdminSettings> }>(
    "/admin/settings",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            tracing: { type: "boolean" },
            logLevel: {
              type: "string",
              enum: ["trace", "debug", "info", "warn", "error", "fatal"],
            },
            rateLimitRpm: { type: "number", minimum: 1, maximum: 10_000 },
            maxTokens: { type: "number", minimum: 256, maximum: 200_000 },
            defaultModel: { type: "string", minLength: 1, maxLength: 200 },
            corsOrigins: { type: "array", items: { type: "string" }, maxItems: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      adminSettings = { ...adminSettings, ...request.body };
      // Apply live settings
      if (request.body.tracing !== undefined) {
        if (request.body.tracing) {
          const { enableTracing } = await import("@nexus/llm-tracer");
          enableTracing({ serviceName: "nexus-api" });
        } else {
          const { disableTracing } = await import("@nexus/llm-tracer");
          disableTracing();
        }
      }
      return reply.send({ settings: adminSettings });
    },
  );
}
