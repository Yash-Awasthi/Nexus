// SPDX-License-Identifier: Apache-2.0
/**
 * Deliberation scoring surface OWNER — extracted from api-bridge.ts.
 *
 * Stores the per-member agreement/ranking scores behind a council run and
 * replays them with a short LLM summary. The store is per caller; the summary
 * uses the bridge's LLM helper, injected.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import type { LlmRole } from "@nexus/llm/drivers";
import type { FastifyInstance } from "fastify";

import { PersistentStore } from "../lib/persistent-store.ts";

const now = (): string => new Date().toISOString();
const userMsg = (content: string) => ({ role: "user" as LlmRole, content });

interface DeliberationsRoutesDeps {
  /** One-shot completion through the default driver. */
  llm(messages: { role: LlmRole; content: string }[], maxTokens?: number): Promise<string>;
}

/** Register /deliberations/:id/scoring and /deliberations/:id/replay. */
export async function deliberationsRoutes(
  app: FastifyInstance,
  deps: DeliberationsRoutesDeps,
): Promise<void> {
  // -- DELIBERATIONS (consensus scoring explainability) ----------------------
  interface DeliberationScore {
    id: string;
    memberId: string;
    memberName: string;
    agreement: number;
    peerRanking: number;
    validationPenalty: number;
    adversarialPenalty: number;
    groundingPenalty: number;
    final: number;
    createdAt: string;
  }
  const _deliberationScores = new PersistentStore<{
    id: string;
    scores: DeliberationScore[];
    consensus: Record<string, number>;
    createdAt: string;
  }>("deliberation_scores");
  await _deliberationScores.load();

  app.get<{ Params: { id: string } }>("/deliberations/:id/scoring", async (req, reply) => {
    const entry = _deliberationScores.for(req).get(req.params.id);
    return reply.send(
      entry
        ? { members: entry.scores, consensus: entry.consensus }
        : { members: [], consensus: {} },
    );
  });
  app.post<{ Params: { id: string }; Body: { members: DeliberationScore[] } }>(
    "/deliberations/:id/scoring",
    async (req, reply) => {
      const { id } = req.params;
      const members = req.body.members ?? [];
      const consensus: Record<string, number> = members.length
        ? {
            avgAgreement: members.reduce((s, m) => s + m.agreement, 0) / members.length,
            avgFinal: members.reduce((s, m) => s + m.final, 0) / members.length,
            spread:
              Math.max(...members.map((m) => m.final)) - Math.min(...members.map((m) => m.final)),
          }
        : {};
      const entry = { id, scores: members, consensus, createdAt: now() };
      _deliberationScores.for(req).set(id, entry);
      return reply.code(201).send(entry);
    },
  );
  app.get<{ Params: { id: string } }>("/deliberations/:id/replay", async (req, reply) => {
    const entry = _deliberationScores.for(req).get(req.params.id);
    if (!entry) return reply.code(404).send({ error: "not_found" });
    const summary = await deps.llm(
      [
        userMsg(
          `Summarise this deliberation scoring in 2-3 sentences: ${JSON.stringify(entry.consensus)}`,
        ),
      ],
      256,
    );
    return reply.send({ ...entry, replaySummary: summary });
  });
}
