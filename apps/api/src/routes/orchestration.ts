// SPDX-License-Identifier: Apache-2.0
/**
 * Orchestration routes — read + compare persisted multi-agent runs (§6.2).
 *
 * Backs the compare/merge UI over the `orchestration_runs` table (§6.1): list
 * runs, inspect a run's candidate diffs, and record a manually-chosen winner.
 * Merging the winner into the base branch stays strictly opt-in and lives in the
 * worker (§6.3) — these routes never touch git; selecting a winner here only
 * records the choice.
 *
 * GET  /api/v1/orchestration/runs        — recent runs (summary)
 * GET  /api/v1/orchestration/runs/:id    — one run with candidate diffs + scores
 * POST /api/v1/orchestration/runs/:id/winner — record a manually-selected winner
 */
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

const DB_AVAILABLE = !!process.env.DATABASE_URL;

interface CandidateShape {
  spec?: { id?: string; model?: string };
  summary?: string;
  diff?: string;
  ok?: boolean;
  error?: string;
}

/**
 * A winner must be one of the run's own candidate ids — never a free-form value.
 * Exported for unit testing without a live DB/HTTP app.
 */
export function isKnownCandidate(candidates: CandidateShape[], winnerId: string): boolean {
  return candidates.some((c) => c.spec?.id === winnerId);
}

export async function orchestrationRoutes(app: FastifyInstance): Promise<void> {
  /** GET /orchestration/runs — most-recent runs (summary only). */
  app.get(
    "/orchestration/runs",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          500: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_req, reply) => {
      if (!DB_AVAILABLE) return reply.send({ runs: [] });
      try {
        const { db } = await import("@nexus/db");
        const { orchestrationRuns } = await import("@nexus/db/schema");
        const { desc } = await import("drizzle-orm");
        const rows = await db
          .select({
            id: orchestrationRuns.id,
            status: orchestrationRuns.status,
            task: orchestrationRuns.task,
            winner: orchestrationRuns.winner,
            createdAt: orchestrationRuns.createdAt,
            updatedAt: orchestrationRuns.updatedAt,
          })
          .from(orchestrationRuns)
          .orderBy(desc(orchestrationRuns.updatedAt))
          .limit(100);
        return reply.send({ runs: rows });
      } catch (err: unknown) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    },
  );

  /** GET /orchestration/runs/:id — full run incl. candidate diffs + scores. */
  app.get<{ Params: { id: string } }>(
    "/orchestration/runs/:id",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        response: {
          200: { type: "object", additionalProperties: true },
          404: { type: "object", additionalProperties: true },
          500: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (req, reply) => {
      if (!DB_AVAILABLE) return reply.code(404).send({ error: "not found" });
      try {
        const { db } = await import("@nexus/db");
        const { orchestrationRuns } = await import("@nexus/db/schema");
        const { eq } = await import("drizzle-orm");
        const [row] = await db
          .select()
          .from(orchestrationRuns)
          .where(eq(orchestrationRuns.id, req.params.id))
          .limit(1);
        if (!row) return reply.code(404).send({ error: "not found" });
        return reply.send({ run: row });
      } catch (err: unknown) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    },
  );

  /** POST /orchestration/runs/:id/winner — record a human-selected winner. */
  app.post<{ Params: { id: string }; Body: { winnerId?: string } }>(
    "/orchestration/runs/:id/winner",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: {
          type: "object",
          properties: { winnerId: { type: "string" } },
          required: ["winnerId"],
        },
        response: {
          200: { type: "object", additionalProperties: true },
          400: { type: "object", additionalProperties: true },
          404: { type: "object", additionalProperties: true },
          500: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (req, reply) => {
      const winnerId = req.body?.winnerId;
      if (!winnerId) return reply.code(400).send({ error: "winnerId is required" });
      if (!DB_AVAILABLE) return reply.code(404).send({ error: "not found" });
      try {
        const { db } = await import("@nexus/db");
        const { orchestrationRuns } = await import("@nexus/db/schema");
        const { eq } = await import("drizzle-orm");
        const [row] = await db
          .select()
          .from(orchestrationRuns)
          .where(eq(orchestrationRuns.id, req.params.id))
          .limit(1);
        if (!row) return reply.code(404).send({ error: "not found" });

        // The chosen id must be one of the run's candidates — never a free-form value.
        const candidates = (row.candidates ?? []) as CandidateShape[];
        if (!isKnownCandidate(candidates, winnerId))
          return reply.code(400).send({ error: `unknown candidate "${winnerId}"` });

        await db
          .update(orchestrationRuns)
          .set({ winner: winnerId, updatedAt: new Date() })
          .where(eq(orchestrationRuns.id, req.params.id));
        return reply.send({ ok: true, id: req.params.id, winner: winnerId });
      } catch (err: unknown) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    },
  );
}
