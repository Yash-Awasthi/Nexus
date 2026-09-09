// SPDX-License-Identifier: Apache-2.0
/**
 * API tokens surface OWNER — extracted from api-bridge.ts (§16.7).
 *
 * Defect history (playtest round 4): this surface minted `nxk_` tokens that
 * nothing ever verified (the store was process-local and unreachable from the
 * auth path) — every token created here authenticated nothing, and the usage
 * example even showed the wrong prefix (`nexus_`). Now backed by the real PAT
 * store (lib/pat-store.ts, verified by middleware/auth.ts), scoped per owner,
 * with raw values returned exactly once at creation.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

import { isValidPatScope } from "../lib/pat-scopes.js";
import {
  createPat,
  listPats,
  revokePat,
} from "../lib/pat-store.js";

/** Owner for the request's PATs: the authenticated user, or "dev" in bypass mode. */
function patOwner(request: FastifyRequest): string {
  return request.nexusUserId ?? "dev";
}

/** Register the /tokens surface. Called from apiBridgeRoutes. */
export async function tokensRoutes(app: FastifyInstance): Promise<void> {
  app.get("/tokens", async (request, reply) => {
    const ownerId = patOwner(request);
    return reply.send({
      tokens: (await listPats(ownerId)).map((t) => ({
        id: t.id,
        name: t.name,
        prefix: t.prefix,
        scopes: t.scopes,
        tier: t.tier,
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        revokedAt: t.revokedAt,
        lastUsedAt: t.lastUsedAt,
      })),
    });
  });

  app.post<{
    Body: { name?: string; label?: string; tier?: string; scopes?: string[]; expiresInDays?: number };
  }>("/tokens", async (request, reply) => {
    const name = (request.body.name ?? request.body.label ?? "").trim();
    if (!name) return reply.code(400).send({ error: "EMPTY_NAME" });

    const days = request.body.expiresInDays ?? 0;
    if (typeof days !== "number" || !Number.isFinite(days) || days < 0 || days > 3650) {
      return reply.code(400).send({ error: "INVALID_EXPIRY" });
    }

    // Scope validation (playtest round 7): the old UI vocabulary
    // (read:conversations, admin:system, …) was never enforced and now
    // matches no area — reject it at mint instead of minting a token that
    // grants nothing. Semantics live in lib/pat-scopes.ts.
    const scopes = request.body.scopes;
    if (scopes !== undefined &&
        (!Array.isArray(scopes) || scopes.some((s) => typeof s !== "string" || !isValidPatScope(s)))) {
      return reply.code(400).send({
        error: "UNKNOWN_SCOPE",
        message: "Unknown scope — choose from " + "chat, memory, council, sandbox, research, ab, godmode, threads, tokens, auth",
      });
    }

    const { entry, raw } = await createPat({
      ownerId: patOwner(request),
      name,
      tier: request.body.tier,
      scopes: request.body.scopes,
      expiresInDays: days,
    });
    return reply.code(201).send({
      id: entry.id,
      name: entry.name,
      token: raw,
      prefix: entry.prefix,
      scopes: entry.scopes,
      tier: entry.tier,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    });
  });

  app.delete<{ Params: { id: string } }>("/tokens/:id", async (request, reply) => {
    if (!(await revokePat(request.params.id, patOwner(request))))
      return reply.code(404).send({ error: "Token not found" });
    return reply.code(204).send();
  });
}
