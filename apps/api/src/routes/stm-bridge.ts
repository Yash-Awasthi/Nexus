// SPDX-License-Identifier: Apache-2.0
/**
 * Short-term-memory surface — owner of `/stm`, `/stm/history`, `/stm/active`,
 * `/stm/project/:id` and `/stm/toggle`.
 *
 * Every row is scoped to the calling user and stored durably
 * (lib/stm-store.ts). Response shapes match the handlers this replaces, so
 * `apps/ui/app/routes/stm.tsx` and `ProjectInstructions.tsx` keep working.
 *
 * Mounted inside apiBridgeRoutes (same /api scope, same auth hooks).
 */

import { computeAutoTuneParams } from "@nexus/drift";
import type { FastifyInstance } from "fastify";

import { ownerIdFor } from "../lib/owner.js";
import {
  clearStmHistory,
  getActiveModules,
  getProjectModules,
  listStmHistory,
  loadStmStore,
  recordStmEntry,
  setActiveModules,
  setProjectModules,
  toggleModule,
} from "../lib/stm-store.js";

/** Params a module list produces for a neutral prompt, for the status views. */
function neutralParams() {
  return computeAutoTuneParams({ message: "neutral", history: [] });
}

export async function stmBridgeRoutes(app: FastifyInstance): Promise<void> {
  await loadStmStore();

  // `{ entries }`, which is what apps/ui/app/routes/stm.tsx reads. The handler
  // this replaces answered with a bare array, so the page's history panel could
  // never show a row.
  app.get("/stm/history", async (request, reply) => {
    return reply.send({ entries: listStmHistory(ownerIdFor(request)) });
  });

  app.post<{ Body: { query?: string; modules?: string[]; applied?: string[] } }>(
    "/stm/history",
    async (request, reply) => {
      const { query = "", modules = [], applied = [] } = request.body ?? {};
      const result = computeAutoTuneParams({ message: query, history: [] });
      recordStmEntry(ownerIdFor(request), {
        query,
        modules,
        applied,
        params: result.params as unknown as Record<string, unknown>,
      });
      return reply.send({ ok: true, params: result.params });
    },
  );

  app.delete("/stm/history", async (request, reply) => {
    const cleared = clearStmHistory(ownerIdFor(request));
    return reply.send({ ok: true, cleared: true, removed: cleared });
  });

  app.get("/stm/active", async (request, reply) => {
    const result = neutralParams();
    return reply.send({
      modules: getActiveModules(ownerIdFor(request)),
      params: result.params,
      context: result.detectedContext,
    });
  });

  app.post<{ Body: { modules?: string[] } }>("/stm/active", async (request, reply) => {
    const owner = ownerIdFor(request);
    if (request.body?.modules) setActiveModules(owner, request.body.modules);
    const result = neutralParams();
    return reply.send({
      modules: getActiveModules(owner),
      params: result.params,
      context: result.detectedContext,
    });
  });

  app.get("/stm", async (request, reply) => {
    const modules = getActiveModules(ownerIdFor(request));
    return reply.send({ modules, active: modules });
  });

  app.get<{ Params: { id: string } }>("/stm/project/:id", async (request, reply) => {
    return reply.send({
      projectId: request.params.id,
      active: getProjectModules(ownerIdFor(request), request.params.id),
    });
  });

  app.post<{ Params: { id: string }; Body: { active?: string[] } }>(
    "/stm/project/:id",
    async (request, reply) => {
      const active = setProjectModules(
        ownerIdFor(request),
        request.params.id,
        request.body?.active ?? [],
      );
      return reply.send({ ok: true, projectId: request.params.id, active });
    },
  );

  app.post<{ Body: { moduleId?: string; enabled?: boolean } }>(
    "/stm/toggle",
    async (request, reply) => {
      const { moduleId, enabled } = request.body ?? {};
      if (!moduleId) return reply.code(400).send({ error: "moduleId required" });
      const active = toggleModule(ownerIdFor(request), moduleId, enabled === true);
      return reply.send({ ok: true, moduleId, enabled: enabled === true, active });
    },
  );
}
