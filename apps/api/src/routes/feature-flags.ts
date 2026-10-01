// SPDX-License-Identifier: Apache-2.0
/**
 * Feature flag routes — backed by @nexus/feature-flags globalFlags registry.
 * Admin overrides persist in the `feature-flag-overrides` collection and are
 * re-applied at boot.
 *
 * GET   /api/v1/feature-flags          — list all registered flags with current values
 * GET   /api/v1/feature-flags/:key     — get a single flag
 * PATCH /api/v1/feature-flags/:key     — override a flag value (API source)
 * DELETE /api/v1/feature-flags/:key    — reset flag to definition default
 */

import { globalFlags, type FlagDefinition, type FlagValue } from "@nexus/feature-flags";
import type { FastifyInstance } from "fastify";

import { PersistentStore } from "../lib/persistent-store.js";
import { requireAuth } from "../middleware/auth.js";

import { requireAdminRole } from "./admin-users.js";

const overrides = new PersistentStore<{ key: string; value: FlagValue }>("feature-flag-overrides");

const view = (def: FlagDefinition) => ({
  key: def.key,
  value: globalFlags.getFlag(def.key, def.default),
  default: def.default,
  type: def.type,
  description: def.description,
  overridden: globalFlags.isOverridden(def.key),
});

const objectReply = {
  schema: { response: { 200: { type: "object", additionalProperties: true } } },
};

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function featureFlagsRoutes(app: FastifyInstance): Promise<void> {
  await overrides.load();
  for (const o of overrides.values()) {
    const def = globalFlags.getDefinition(o.key);
    if (def && typeof o.value === def.type) globalFlags.setFlag(o.key, o.value);
  }

  app.get("/feature-flags", { ...objectReply, preHandler: requireAuth }, async (_req, reply) => {
    const flags = globalFlags.listFlags().map(view);
    return reply.send({ flags, total: flags.length });
  });

  app.get<{ Params: { key: string } }>(
    "/feature-flags/:key",
    { ...objectReply, preHandler: requireAuth },
    async (request, reply) => {
      const key = decodeURIComponent(request.params.key);
      const def = globalFlags.getDefinition(key);
      if (!def) return reply.code(404).send({ error: `Flag "${key}" not found` });
      return reply.send(view(def));
    },
  );

  app.patch<{ Params: { key: string }; Body: { value?: unknown } }>(
    "/feature-flags/:key",
    { ...objectReply, preHandler: requireAdminRole },
    async (request, reply) => {
      const key = decodeURIComponent(request.params.key);
      const def = globalFlags.getDefinition(key);
      if (!def) return reply.code(404).send({ error: `Flag "${key}" not found` });
      const value = request.body?.value;
      if (typeof value !== def.type || (typeof value === "number" && !Number.isFinite(value))) {
        return reply.code(400).send({ error: `"${key}" takes a ${def.type}` });
      }
      globalFlags.setFlag(key, value as FlagValue);
      overrides.set(key, { key, value: value as FlagValue });
      return reply.send(view(def));
    },
  );

  app.delete<{ Params: { key: string } }>(
    "/feature-flags/:key",
    { schema: { response: { 204: { type: "null" } } }, preHandler: requireAdminRole },
    async (request, reply) => {
      const key = decodeURIComponent(request.params.key);
      globalFlags.resetFlag(key);
      overrides.delete(key);
      return reply.code(204).send();
    },
  );
}
