// SPDX-License-Identifier: Apache-2.0
/**
 * Council task handler — processes `council.deliberate` jobs.
 *
 * Called by the task worker when a job with name "council.deliberate" is
 * dequeued from nexus-high or nexus-medium.
 */

import type { CouncilRequest, ModelVote } from "@nexus/contracts";
import { CouncilService } from "@nexus/council";
import type { CouncilPersistPayload } from "@nexus/council";
import { db } from "@nexus/db";
import { verdicts, councilTranscripts } from "@nexus/db/schema";

/**
 * Persist verdict + transcript produced by an async BullMQ deliberation job.
 *
 * Mirrors apps/api/src/routes/council.ts:persistCouncilResult. The worker
 * runs in a separate process without the API layer, so it writes to the DB
 * directly.  Both paths must stay in sync when the schema changes.
 */
async function persistCouncilResult(payload: CouncilPersistPayload): Promise<void> {
  const { result, votes, signalId } = payload;

  // Without a signalId we can't write — verdicts.signal_id is NOT NULL.
  // Fire-and-forget jobs submitted without a signalId are acceptable;
  // the result is still returned to the BullMQ caller via job.returnvalue.
  if (!signalId) return;

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

let _svc: CouncilService | null = null;

function getSvc(): CouncilService {
  if (!_svc) {
    _svc = new CouncilService({ onResult: persistCouncilResult });
  }
  return _svc;
}

export interface CouncilJobPayload {
  proposal: CouncilRequest["proposal"];
  budgetUsd?: number;
  timeoutMs?: number;
  signalId?: string;
}

export async function handleCouncilJob(payload: CouncilJobPayload): Promise<unknown> {
  const svc = getSvc();
  const request: CouncilRequest = {
    proposal: payload.proposal,
    budgetUsd: payload.budgetUsd,
    timeoutMs: payload.timeoutMs ?? 60_000,
  };
  return svc.deliberate(request, { signalId: payload.signalId });
}
