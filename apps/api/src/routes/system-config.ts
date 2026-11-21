// SPDX-License-Identifier: Apache-2.0
/**
 * System config surface OWNER — extracted from api-bridge.ts.
 *
 * Admin system page. Each key here is read somewhere: default_llm_model is the
 * model the tools ask the default provider for; maintenance_mode turns every
 * /api call away except for admins. The bridge passes the current model in and
 * receives updates back, because its defaultModel() reads the same value.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import { db } from "@nexus/db";
import { users } from "@nexus/db/schema";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { PersistentStore } from "../lib/persistent-store.ts";

import { requireAdminRole } from "./admin-users.ts";

export interface SystemConfigDeps {
  /** The bridge's current default model, before any stored override is applied. */
  initialModel: string;
  /** Called when default_llm_model changes, so the bridge's defaultModel() follows. */
  setModel(model: string): void;
}

/** Register GET/PUT /system/config and the maintenance-mode gate. */
export async function systemConfigRoutes(
  app: FastifyInstance,
  deps: SystemConfigDeps,
): Promise<void> {
  const keys: Record<string, { type: "string" | "boolean"; initial: string }> = {
    default_llm_model: { type: "string", initial: deps.initialModel },
    maintenance_mode: { type: "boolean", initial: process.env.MAINTENANCE_MODE ?? "false" },
  };
  const store = new PersistentStore<{ id: string; value: string }>("system_config");
  await store.load();

  const value = (key: string) => store.get(key)?.value ?? keys[key]?.initial ?? "";
  const apply = () =>
    deps.setModel(value("default_llm_model") || process.env.NEXUS_DEFAULT_MODEL || "");
  apply();

  app.addHook("preHandler", async (request, reply) => {
    if (value("maintenance_mode") !== "true" || request.url.startsWith("/api/system/config"))
      return;
    const userId = request.nexusUserId;
    const [user] = userId
      ? await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1)
      : [];
    if (user?.role === "admin" || user?.role === "owner") return;
    return reply
      .code(503)
      .send({ error: "maintenance", message: "Nexus is in maintenance mode. Try again later." });
  });

  app.get("/system/config", { preHandler: requireAdminRole }, async (_req, reply) => {
    const configs = Object.entries(keys).map(([key, { type }]) => ({
      key,
      value: value(key),
      type,
    }));
    return reply.send({ configs });
  });

  app.put<{ Params: { key: string }; Body: { value?: unknown } }>(
    "/system/config/:key",
    { preHandler: requireAdminRole },
    async (request, reply) => {
      const spec = keys[request.params.key];
      if (!spec) return reply.code(404).send({ error: "unknown config key" });
      const next = String(request.body?.value ?? "").trim();
      if (!next) return reply.code(400).send({ error: "value is required" });
      if (spec.type === "boolean" && next !== "true" && next !== "false") {
        return reply.code(400).send({ error: "value must be true or false" });
      }
      store.set(request.params.key, { id: request.params.key, value: next });
      apply();
      return reply.send({ ok: true, key: request.params.key, value: next });
    },
  );
}
