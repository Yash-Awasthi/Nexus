// SPDX-License-Identifier: Apache-2.0
/**
 * Council routes
 *   POST /api/v1/council/deliberate
 *   GET  /api/v1/council/verdicts/:verdictId
 *   GET  /api/v1/council/transcripts/:verdictId
 */

import type { CouncilRequest, ModelVote } from "@nexus/contracts";
import { CouncilService } from "@nexus/council";
import type { CouncilPersistPayload } from "@nexus/council";
import { db } from "@nexus/db";
import { verdicts, councilTranscripts } from "@nexus/db/schema";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// Lazy singleton — created on first request to avoid cold-start cost
let _councilService: CouncilService | null = null;

function getCouncilService(): CouncilService {
  if (!_councilService) {
    _councilService = new CouncilService({
      onResult: persistCouncilResult,
    });
  }
  return _councilService;
}

/**
 * Persist verdict + transcript to DB after a deliberation.
 * Passed as the `onResult` callback so @nexus/council stays DB-free.
 */
async function persistCouncilResult(payload: CouncilPersistPayload): Promise<void> {
  const { result, votes, signalId } = payload;

  if (!signalId) {
    // Without a signalId we can't write — verdicts.signal_id is NOT NULL
    return;
  }

  const decision: "approve" | "reject" | "defer" | "escalate" =
    result.outcome === "approved" ? "approve" : result.outcome === "rejected" ? "reject" : "defer";

  const dissents = votes
    .filter((v: ModelVote) => v.vote !== result.majority && v.vote !== "abstain")
    .map((v: ModelVote) => v.model);

  const [verdictRow] = await db
    .insert(verdicts)
    .values({
      signalId,
      decision,
      confidence: result.consensus,
      rationale: result.summary,
      dissents,
      actions: null,
      costUsd: payload.totalCostUsd > 0 ? payload.totalCostUsd.toFixed(6) : null,
    })
    .returning({ id: verdicts.id });

  if (!verdictRow) return;

  // Write transcript
  await db.insert(councilTranscripts).values({
    verdictId: verdictRow.id,
    turns: votes.map((v: ModelVote) => ({
      archetype: v.model,
      role: "assistant",
      content: v.reasoning,
      confidence: v.confidence,
      latencyMs: v.latencyMs,
    })),
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function councilRoutes(app: FastifyInstance): Promise<void> {
  // POST /council/deliberate
  app.post<{
    Body: CouncilRequest & { signal_id?: string };
  }>("/council/deliberate", { preHandler: requireAuth }, async (request, reply) => {
    const { signal_id, ...councilRequest } = request.body as CouncilRequest & {
      signal_id?: string;
    };
    const svc = getCouncilService();

    try {
      const response = await svc.deliberate(councilRequest, { signalId: signal_id });
      const statusCode = response.ok ? 200 : 500;
      return reply.code(statusCode).send(response);
    } catch (err) {
      request.log.error(err, "council/deliberate failed");
      return reply.code(500).send({
        ok: false,
        error: err instanceof Error ? err.message : "Deliberation failed",
      });
    }
  });

  // GET /council/verdicts/:verdictId
  app.get<{ Params: { verdictId: string } }>(
    "/council/verdicts/:verdictId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const [row] = await db
        .select()
        .from(verdicts)
        .where(eq(verdicts.id, request.params.verdictId));

      if (!row) return reply.code(404).send({ error: "Verdict not found" });
      return reply.send(row);
    },
  );

  // GET /council/transcripts/:verdictId
  app.get<{ Params: { verdictId: string } }>(
    "/council/transcripts/:verdictId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const [row] = await db
        .select()
        .from(councilTranscripts)
        .where(eq(councilTranscripts.verdictId, request.params.verdictId));

      if (!row) return reply.code(404).send({ error: "Transcript not found" });
      return reply.send(row);
    },
  );
}
