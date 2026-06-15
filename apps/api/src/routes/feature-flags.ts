// SPDX-License-Identifier: Apache-2.0
/**
 * Feature flag routes — backed by @nexus/feature-flags globalFlags registry.
 *
 * GET   /api/v1/feature-flags          — list all registered flags with current values
 * GET   /api/v1/feature-flags/:key     — get a single flag
 * PATCH /api/v1/feature-flags/:key     — override a flag value (API source)
 * DELETE /api/v1/feature-flags/:key    — reset flag to definition default
 */

import { globalFlags } from "@nexus/feature-flags";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function featureFlagsRoutes(app: FastifyInstance): Promise<void> {
  /** GET /feature-flags */
  app.get("/feature-flags", { schema: { response: { 200: { type: "object", additionalProperties: true }, 201: { type: "object", additionalProperties: true } } }, preHandler: requireAuth }, async (_req, reply) => {
    const flags = globalFlags.listFlags().map((def) => ({
      key: def.key,
      value: globalFlags.getFlag(def.key, def.default),
      default: def.default,
      type: def.type,
      description: def.description,
      overridden: globalFlags.isOverridden(def.key),
    }));
    return reply.send({ flags, total: flags.length });
  });

  /** GET /feature-flags/:key */
  app.get<{ Params: { key: string } }>(
    "/feature-flags/:key",
    { schema: { response: { 200: { type: "object", additionalProperties: true }, 201: { type: "object", additionalProperties: true } } }, preHandler: requireAuth },
    async (request, reply) => {
      const key = decodeURIComponent(request.params.key);
      const def = globalFlags.getDefinition(key);
      if (!def) return reply.code(404).send({ error: `Flag "${key}" not found` });
      return reply.send({
        key,
        value: globalFlags.getFlag(key, def.default),
        default: def.default,
        type: def.type,
        description: def.description,
        overridden: globalFlags.isOverridden(key),
      });
    },
  );

  /** PATCH /feature-flags/:key — override value */
  app.patch<{ Params: { key: string }; Body: { value: boolean | string | number } }>(
    "/feature-flags/:key",
    { schema: { response: { 200: { type: "object", additionalProperties: true }, 201: { type: "object", additionalProperties: true } } }, preHandler: requireAuth },
    async (request, reply) => {
      const key = decodeURIComponent(request.params.key);
      const def = globalFlags.getDefinition(key);
      if (!def) return reply.code(404).send({ error: `Flag "${key}" not found` });
      try {
        globalFlags.setFlag(key, request.body.value);
        return reply.send({
          key,
          value: globalFlags.getFlag(key, def.default),
          overridden: true,
        });
      } catch (err: unknown) {
        const e = err as { message?: string };
        return reply.code(400).send({ error: e.message });
      }
    },
  );

  /** DELETE /feature-flags/:key — reset to default */
  app.delete<{ Params: { key: string } }>(
    "/feature-flags/:key",
    { schema: { response: { 200: { type: "object", additionalProperties: true }, 204: { type: "null" } } }, preHandler: requireAuth },
    async (request, reply) => {
      const key = decodeURIComponent(request.params.key);
      globalFlags.resetFlag(key);
      return reply.code(204).send();
    },
  );
}
