// SPDX-License-Identifier: Apache-2.0
/**
 * Archetype registry surface — owner of /archetypes, moved out of
 * api-bridge.ts, where it was CRUD over a module-level array that no council
 * path ever read.
 *
 * Rows are durable and per-user (lib/archetype-store.ts). Response shapes match
 * the handlers this replaces, so the existing pages keep working unchanged.
 * PATCH is registered alongside PUT because `apps/ui/app/context/StoreContext.tsx`
 * sends PATCH while `apps/ui/app/routes/archetypes.tsx` sends PUT, and only PUT
 * existed.
 *
 * Mounted inside apiBridgeRoutes (same /api scope, same auth hooks).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";

import {
  ANON_OWNER,
  createArchetype,
  deleteArchetype,
  listArchetypes,
  listCustomArchetypes,
  loadArchetypeStore,
  updateArchetype,
  type ArchetypeInput,
} from "../lib/archetype-store.js";

/** Owner bucket for this request. Callers with no identity share ANON_OWNER. */
function ownerOf(request: { nexusUserId?: string }): string {
  return request.nexusUserId ?? ANON_OWNER;
}

const WRITABLE = [
  "name",
  "icon",
  "color",
  "thinkingStyle",
  "description",
  "asks",
  "blindSpot",
  "systemPrompt",
  "model",
  "temperature",
] as const;

/** Drop anything the caller is not allowed to set (id, ownerId, builtin, …). */
function pickInput(body: unknown): ArchetypeInput {
  const src = (body ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE) if (src[key] !== undefined) out[key] = src[key];
  return out as ArchetypeInput;
}

export async function archetypesRoutes(app: FastifyInstance): Promise<void> {
  await loadArchetypeStore();

  app.get<{ Querystring: { custom?: string } }>("/archetypes", async (request, reply) => {
    const owner = ownerOf(request);
    const archetypes =
      request.query.custom === "true" ? listCustomArchetypes(owner) : listArchetypes(owner);
    return reply.send({ archetypes });
  });

  app.post("/archetypes", async (request, reply) => {
    return reply.code(201).send(createArchetype(ownerOf(request), pickInput(request.body)));
  });

  const update = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const result = updateArchetype(ownerOf(request), request.params.id, pickInput(request.body));
    if (result === "not_found") return reply.code(404).send({ error: "not_found" });
    if (result === "readonly")
      return reply
        .code(403)
        .send({ error: "readonly", message: "Built-in archetypes cannot be edited." });
    return reply.send(result);
  };

  app.put<{ Params: { id: string } }>("/archetypes/:id", update as RouteHandlerMethod);
  app.patch<{ Params: { id: string } }>("/archetypes/:id", update as RouteHandlerMethod);

  app.delete<{ Params: { id: string } }>("/archetypes/:id", async (request, reply) => {
    const result = deleteArchetype(ownerOf(request), request.params.id);
    if (result === "not_found") return reply.code(404).send({ error: "not_found" });
    if (result === "readonly")
      return reply
        .code(403)
        .send({ error: "readonly", message: "Built-in archetypes cannot be deleted." });
    return reply.send({ ok: true });
  });
}
