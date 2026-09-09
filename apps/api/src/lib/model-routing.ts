// SPDX-License-Identifier: Apache-2.0
/**
 * §15.7 — per-model capability routing (Roadmap 15.7).
 *
 * The discovery surface (`lib/model-discovery.ts`, GET /api/v1/llm/models)
 * knows each model's capabilities. This module is the DECISION layer that
 * consumes it: given a requirement (vision / tool-use / context size /
 * minimum reasoning tier / cheapest-first), rank the discovered models and
 * pick one. Pure and deterministic — routes/llm.ts feeds it the discovery
 * result over HTTP.
 *
 * Hard requirements FILTER (a model without them is ineligible); soft
 * preferences RANK (tier adequacy, then cost, then context headroom).
 */

import type { ModelCapability, ReasoningTier } from "./model-discovery.js";

export interface CapabilityRequirement {
  /** Model must accept image inputs. */
  vision?: boolean;
  /** Model must support tool/function calling. */
  toolUse?: boolean;
  /** Model must support streaming. */
  streaming?: boolean;
  /** Prompt + expected response must fit this context window. */
  minContextWindow?: number;
  /** The task needs at least this many output tokens. */
  maxOutputNeeded?: number;
  /** Minimum reasoning depth ("fast" < "reasoning" < "deep"). */
  minReasoningTier?: ReasoningTier;
  /** Rank by lowest cost among eligible models (default: capability-first). */
  preferCheapest?: boolean;
}

const TIER_ORDER: Record<ReasoningTier, number> = { fast: 0, reasoning: 1, deep: 2 };

export interface RouteCandidate {
  model: ModelCapability;
  /** Why this model ranked where it did (human-readable, ordered). */
  notes: string[];
}

export interface RouteResult {
  chosen: ModelCapability | null;
  /** Ranked eligible models, best first (capped at 5). */
  candidates: RouteCandidate[];
  /** Why the pool has zero eligible models (echoes each failed filter). */
  unmatched: string[];
}

function meetsHardRequirements(m: ModelCapability, req: CapabilityRequirement): string[] {
  const failed: string[] = [];
  if (req.vision && !m.vision) failed.push("no vision");
  if (req.toolUse && !m.toolUse) failed.push("no tool calling");
  if (req.streaming && !m.streaming) failed.push("no streaming");
  if (req.minContextWindow !== undefined && m.contextWindow < req.minContextWindow)
    failed.push(`context ${m.contextWindow} < ${req.minContextWindow}`);
  if (req.maxOutputNeeded !== undefined && m.maxOutput < req.maxOutputNeeded)
    failed.push(`max output ${m.maxOutput} < ${req.maxOutputNeeded}`);
  if (req.minReasoningTier && TIER_ORDER[m.reasoningTier] < TIER_ORDER[req.minReasoningTier])
    failed.push(`tier ${m.reasoningTier} < ${req.minReasoningTier}`);
  return failed;
}

function costOf(m: ModelCapability): number | null {
  if (m.inputCostPer1M === null && m.outputCostPer1M === null) return 0; // free (local)
  return (m.inputCostPer1M ?? 0) + (m.outputCostPer1M ?? 0);
}

function scoreAndNotes(
  m: ModelCapability,
  req: CapabilityRequirement,
): { score: number[]; notes: string[] } {
  // Lexicographic score, lower is better. Capability-first unless
  // preferCheapest: adequate tier costs less when it is not overridden.
  const needed = TIER_ORDER[req.minReasoningTier ?? "fast"];
  const tierExcess = TIER_ORDER[m.reasoningTier] - needed;
  const cost = costOf(m);
  const notes: string[] = [];
  if (m.inputCostPer1M === null) notes.push("free (local)");
  if (tierExcess === 0) notes.push(`tier exactly ${m.reasoningTier}`);
  else notes.push(`tier ${m.reasoningTier} (${tierExcess > 0 ? "above" : "at"} minimum)`);
  notes.push(`context ${(m.contextWindow / 1000).toFixed(0)}k`);
  if (cost !== null && cost > 0) notes.push(`$${cost.toFixed(2)}/1M combined`);
  const score = req.preferCheapest
    ? [cost ?? 0, tierExcess, -m.contextWindow]
    : [tierExcess, cost ?? 0, -m.contextWindow];
  return { score, notes };
}

/**
 * Rank + pick. Never throws; an empty pool or unsatisfiable requirement
 * returns chosen: null with the unmatched filters spelled out.
 */
export function routeModel(models: ModelCapability[], req: CapabilityRequirement): RouteResult {
  const eligible: ModelCapability[] = [];
  const unmatched: string[] = [];
  for (const m of models) {
    const failed = meetsHardRequirements(m, req);
    if (failed.length === 0) eligible.push(m);
    else unmatched.push(`${m.provider}/${m.id}: ${failed.join(", ")}`);
  }
  if (eligible.length === 0) return { chosen: null, candidates: [], unmatched };

  const scored = eligible.map((m) => ({ m, ...scoreAndNotes(m, req) }));
  scored.sort((a, b) => {
    for (let i = 0; i < a.score.length; i++) {
      if (a.score[i] !== b.score[i]) return a.score[i]! - b.score[i]!;
    }
    return a.m.id.localeCompare(b.m.id);
  });
  const candidates = scored.slice(0, 5).map((s) => ({ model: s.m, notes: s.notes }));
  return { chosen: candidates[0]?.model ?? null, candidates, unmatched };
}
