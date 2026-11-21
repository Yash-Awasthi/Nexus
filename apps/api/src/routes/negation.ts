// SPDX-License-Identifier: Apache-2.0
/**
 * Negation surface OWNER — extracted from api-bridge.ts.
 *
 * Rules are keyed by conversation (a chat thread id). The chat stream folds a
 * thread's rules into the system preamble through {@link negRulesFor} and
 * {@link negBlock}, so the store stays here.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";

import { PersistentStore } from "../lib/persistent-store.ts";

export interface NegRule {
  id: string;
  pattern: string;
  type?: string;
  createdAt: string;
}

const negationRules = new PersistentStore<{ id: string; rules: NegRule[] }>("negation_rules");

const negKey = (req: { nexusUserId?: string }, convId: string) =>
  `${req.nexusUserId ?? "anonymous"}:${convId}`;

export const negRulesFor = (req: { nexusUserId?: string }, convId: string) =>
  negationRules.get(negKey(req, convId))?.rules ?? [];

export const negBlock = (rules: NegRule[]) =>
  rules.length
    ? "The user has ruled these out. Do not do any of them:\n" +
      rules.map((r) => `- ${r.pattern}`).join("\n")
    : "";

/** Register /negation/*. */
export async function negationRoutes(app: FastifyInstance): Promise<void> {
  await negationRules.load();

  app.post<{
    Body: { convId?: string; patterns?: { pattern?: unknown; type?: unknown }[] };
  }>("/negation/add", async (request, reply) => {
    const convId = request.body?.convId?.trim();
    const patterns = request.body?.patterns;
    if (!convId || !Array.isArray(patterns))
      return reply.code(400).send({ error: "convId and patterns[] are required" });
    const rules = negRulesFor(request, convId);
    const known = new Set(rules.map((r) => r.pattern.toLowerCase()));
    for (const p of patterns) {
      const pattern = String(p?.pattern ?? "")
        .trim()
        .slice(0, 300);
      if (!pattern || known.has(pattern.toLowerCase())) continue;
      known.add(pattern.toLowerCase());
      rules.push({
        id: crypto.randomUUID(),
        pattern,
        ...(p.type ? { type: String(p.type).slice(0, 40) } : {}),
        createdAt: new Date().toISOString(),
      });
    }
    negationRules.set(negKey(request, convId), { id: negKey(request, convId), rules });
    return reply.send({ ok: true, rules });
  });

  app.get<{ Params: { convId: string } }>("/negation/:convId", async (request, reply) => {
    return reply.send({ rules: negRulesFor(request, request.params.convId) });
  });

  app.delete<{ Params: { convId: string; ruleId: string } }>(
    "/negation/:convId/:ruleId",
    async (request, reply) => {
      const key = negKey(request, request.params.convId);
      const rules = negRulesFor(request, request.params.convId).filter(
        (r) => r.id !== request.params.ruleId,
      );
      negationRules.set(key, { id: key, rules });
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { convId: string } }>("/negation/:convId", async (request, reply) => {
    negationRules.delete(negKey(request, request.params.convId));
    return reply.code(204).send();
  });
}
