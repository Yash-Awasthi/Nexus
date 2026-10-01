// SPDX-License-Identifier: Apache-2.0
/**
 * run-transcript — the shared run/tool transcript compositions (pass 66).
 *
 * Every app surface that runs a deliberation (worker council job, worker
 * agent-MCP tools, CLI local agent, API council routes) previously carried a
 * near-identical local copy of these compositions over the pass-58 recorder
 * primitives (see @nexus/council src/transcript.ts). This module is the single
 * home for that core so every surface shares one literal artifact contract:
 *
 *   • {@link buildCouncilRunTranscript} — run-level artifact from a completed
 *     deliberation (route evidence, one stage per model vote, dissent computed
 *     with the handler's majority mapping, metrics/traces/total_ms finalized
 *     with the OR-of-five degradation semantics). Worker pass 59 + API pass 65.
 *   • {@link recordToolTranscript} — tool-level artifact for a council/debate
 *     tool invocation through an agent loop (debate protocol output becomes
 *     one stage per final answer; tally/critique/verdict/verify maps follow).
 *     Worker pass 62 + CLI pass 63.
 *   • {@link councilTranscriptEvent} — the worker-shaped "council.transcript"
 *     JSON event payload `{ level, event, signalId, transcript }`.
 *   • {@link maskedCouncilTranscript} — identity-masked run transcript for
 *     blind-council surfaces: builds the run transcript first, then anonymizes
 *     every structured model-identity field (`assigned_models`, per-vote model
 *     fields, dissent, model-call traces) into deterministic `voter_1..n`
 *     placeholders so blind deliberations stay recordable without leaking the
 *     identities blind mode exists to hide.
 *
 * Pure: depends only on this package's recorder primitives and @nexus/contracts
 * types — no DB, no network, no agent-runtime import.
 */
import type { CouncilRequest, ProposalResult, ModelVote } from "@nexus/contracts";

import {
  createTranscript,
  recordStage,
  recordRouting,
  appendAudit,
  finalizeTranscript,
  transcriptToJson,
  type CouncilTranscript,
} from "./transcript.js";

// ── Tool-level recorder (worker agent-mcp pass 62 / CLI pass 63) ─────────────

export type TranscriptSink = (transcript: CouncilTranscript) => void;

export interface ToolTranscriptHooks {
  /** Called with the run transcript after each completed (or failed) tool call. */
  onTranscript?: TranscriptSink;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * Compose the pass-58 transcript for one council/debate tool invocation.
 * Debate protocol output (standalone debate__run + council_debate share it)
 * becomes one stage per final answer plus a `debate` audit entry; otherwise the
 * tally / critique / verdict / verify maps apply. Failures still produce a
 * degraded transcript (protocol-degraded + error warning + audit entry) so
 * failed tool calls stay observable too.
 */
export function recordToolTranscript(
  tool: string,
  question: string,
  parsed: Record<string, unknown> | undefined,
  startedAt: number,
  error?: string,
): CouncilTranscript {
  const t = createTranscript({
    id: `tool-${tool}-${startedAt}`,
    query: question || tool,
    protocol: tool,
    createdAt: new Date(startedAt).toISOString(),
  });
  recordRouting(t, {
    mode: "explicit",
    tool,
    reason: error ? "Tool call failed; degradation recorded." : "Agent-loop tool invocation.",
  });
  if (parsed) {
    // Debate protocol output (standalone debate__run + council_debate share it).
    if (parsed.converged !== undefined || Array.isArray(parsed.finalAnswers)) {
      const answers = Array.isArray(parsed.finalAnswers)
        ? (parsed.finalAnswers as { agent?: unknown; answer?: unknown }[])
        : [];
      for (const fa of answers) {
        recordStage(t, { name: `answer:${str(fa.agent) || "agent"}`, answer: str(fa.answer) });
      }
      appendAudit(t, "debate", {
        converged: parsed.converged,
        roundsRun: parsed.roundsRun,
        majority: asRecord(parsed.majority).answer,
      });
    } else if (parsed.tally !== undefined) {
      recordStage(t, { name: "tally", winner: parsed.winner, tally: parsed.tally });
    } else if (parsed.critiques !== undefined) {
      const list = Array.isArray(parsed.critiques) ? parsed.critiques : [];
      recordStage(t, { name: "critique", mode: parsed.mode, count: list.length });
    } else if (parsed.verdict !== undefined && parsed.verified === undefined) {
      recordStage(t, { name: "verdict", verdict: parsed.verdict, advisors: parsed.advisors });
    } else if (parsed.verified !== undefined) {
      recordStage(t, { name: "verify", verified: parsed.verified, approvals: parsed.approvals });
    }
  }
  if (error) appendAudit(t, "error", { message: error });
  finalizeTranscript(t, {
    startedAt,
    warnings: error ? [error] : [],
    modelCallTraces: [],
    ...(error ? { protocolDegraded: true } : {}),
  });
  return t;
}

// ── Run-level recorder (worker pass 59 / API pass 65) ─────────────────────────

export interface CouncilRunInput {
  /** Optional FK linking the run to a pre-existing signal row. */
  signalId?: string;
  request: CouncilRequest;
  result: ProposalResult;
  votes: ModelVote[];
  /** Monotonic start timestamp (ms) — drives metrics.total_ms. */
  startedAt: number;
  /** Routing audit reason. Defaults to a neutral run description. */
  reason?: string;
}

/** Majority vote for dissent mapping (the handlers' own decision mapping). */
function majorityVote(outcome: ProposalResult["outcome"]): "yes" | "no" | null {
  if (outcome === "approved") return "yes";
  if (outcome === "rejected") return "no";
  return null; // deferred → no majority, no dissents
}

/** Build the inspectable run transcript for a completed deliberation. */
export function buildCouncilRunTranscript(input: CouncilRunInput): CouncilTranscript {
  const { signalId, request, result, votes, startedAt } = input;
  const query = `${request.proposal.title}\n${request.proposal.description}`.trim();

  const transcript = createTranscript({
    id: signalId ?? `council-${startedAt}`,
    query,
    protocol: "council",
    createdAt: new Date(startedAt).toISOString(),
  });
  transcript.finalAnswer = result.summary;
  transcript.confidence = result.consensus;

  recordRouting(transcript, {
    mode: "explicit",
    requested_protocol: "council",
    selected_protocol: "council",
    tier: "council",
    assigned_models: votes.map((v) => v.model),
    reason: input.reason ?? "Explicit council deliberation.",
  });

  for (const v of votes) {
    recordStage(transcript, {
      name: `vote:${v.model}`,
      vote: v.vote,
      provider: v.provider,
      confidence: v.confidence,
      latencyMs: v.latencyMs,
    });
  }

  const majority = majorityVote(result.outcome);
  transcript.dissent = majority
    ? votes.filter((v) => v.vote !== majority && v.vote !== "abstain").map((v) => v.model)
    : [];

  appendAudit(transcript, "finalize", {
    outcome: result.outcome,
    consensus: result.consensus,
    totalCostUsd: result.totalCostUsd,
  });

  finalizeTranscript(transcript, {
    startedAt,
    metrics: { deliberationMs: Date.now() - startedAt },
    modelCallTraces: votes.map((v) => ({
      model: v.model,
      provider: v.provider,
      latencyMs: v.latencyMs,
    })),
  });

  return transcript;
}

/** Serialize the transcript to a plain JSON string (SessionResult.to_dict analog). */
export const councilTranscriptJson = (transcript: CouncilTranscript): string =>
  transcriptToJson(transcript);

/**
 * The worker-shaped "council.transcript" event payload
 * `{ level: "info", event: "council.transcript", signalId, transcript }`.
 * The worker council-handler and the API route both emit exactly this shape.
 */
export function councilTranscriptEvent(
  signalId: string | undefined,
  transcript: CouncilTranscript,
): {
  level: "info";
  event: "council.transcript";
  signalId?: string;
  transcript: CouncilTranscript;
} {
  return {
    level: "info",
    event: "council.transcript",
    ...(signalId !== undefined ? { signalId } : {}),
    transcript,
  };
}

/**
 * The worker-shaped "tool.transcript" event payload
 * `{ level: "info", event: "tool.transcript", taskId, transcript }` — what the
 * worker agent-handler and the CLI local agent emit for every council/debate
 * tool invocation through an agent loop.
 */
export function toolTranscriptEvent(
  taskId: string | undefined,
  transcript: CouncilTranscript,
): { level: "info"; event: "tool.transcript"; taskId?: string; transcript: CouncilTranscript } {
  return {
    level: "info",
    event: "tool.transcript",
    ...(taskId !== undefined ? { taskId } : {}),
    transcript,
  };
}

// ── Identity masking (blind-council surfaces — pass 68) ───────────────────────

/**
 * Masking scheme for blind-council runs.
 *
 * Blind mode deliberately strips model identity before a deliberation is
 * recorded, so an emitted transcript must not carry which models advised.
 * Every STRUCTURED model-identity field is anonymized — the mapping is built
 * deterministically from the model identities the run itself records, in
 * first-encounter order (`assigned_models`, then vote-stage names, dissent,
 * and model-call traces), so the same blind run always yields the same
 * `voter_1..n` placeholders:
 *
 *   • routing.assigned_models       → ["voter_1", …]
 *   • per-vote stage names          → "vote:voter_1" (stage `model` fields too)
 *   • transcript.dissent            → ["voter_3", …] (in original order)
 *   • modelCallTraces[].model       → "voter_1"
 *   • the routing audit-trail copy  → same masked list
 *
 * Free-text fields (query, finalAnswer, reasoning, warnings) are the proposer's
 * own content and are left untouched — only structured model identity is
 * masked, and non-identity fields (protocol, stages, verdict, dissent count
 * semantics, confidence, metrics, degraded) keep their exact values so the
 * observability semantics stay identical to the unmasked transcript.
 */

/** Deterministic first-encounter model list for a built run transcript. */
function collectModelIdentities(t: CouncilTranscript): string[] {
  const seen: string[] = [];
  const add = (m: unknown): void => {
    const s = str(m);
    if (s && !seen.includes(s)) seen.push(s);
  };
  const assigned = Array.isArray(t.routing.assigned_models)
    ? (t.routing.assigned_models as unknown[])
    : [];
  for (const m of assigned) add(m);
  for (const s of t.stages) {
    if (typeof s.name === "string" && s.name.startsWith("vote:")) add(s.name.slice("vote:".length));
    add(s.model);
  }
  for (const d of t.dissent) add(d);
  for (const tr of t.modelCallTraces) add(tr.model);
  return seen;
}

const repl = (map: Map<string, string>, v: unknown): string => {
  const s = str(v);
  return map.get(s) ?? s;
};

/**
 * Mask every structured model-identity field of a built transcript into
 * deterministic `voter_1..n` placeholders (see the scheme above). Returns a
 * deep copy — the caller's transcript is never mutated.
 */
export function maskModelIdentity(transcript: CouncilTranscript): CouncilTranscript {
  const models = collectModelIdentities(transcript);
  const voter = new Map(models.map((m, i) => [m, `voter_${i + 1}`]));
  // Plain-JSON clone: the transcript is JSON-safe and this avoids structuredClone lib typing.
  const clone = JSON.parse(JSON.stringify(transcript)) as CouncilTranscript;

  if (Array.isArray(clone.routing.assigned_models)) {
    clone.routing.assigned_models = (clone.routing.assigned_models as unknown[]).map((m) =>
      repl(voter, m),
    );
  }
  for (const entry of clone.auditTrail) {
    if (entry.step === "routing" && Array.isArray(entry.assigned_models)) {
      entry.assigned_models = (entry.assigned_models as unknown[]).map((m) => repl(voter, m));
    }
  }
  for (const stage of clone.stages) {
    if (typeof stage.name === "string" && stage.name.startsWith("vote:")) {
      stage.name = `vote:${repl(voter, stage.name.slice("vote:".length))}`;
    }
    if (stage.model !== undefined) stage.model = repl(voter, stage.model);
  }
  clone.dissent = clone.dissent.map((d) => repl(voter, d));
  clone.modelCallTraces = clone.modelCallTraces.map((tr) => ({
    ...tr,
    model: repl(voter, tr.model),
  }));
  return clone;
}

/**
 * Build the run transcript and mask it for a blind-council surface.
 * Composes {@link buildCouncilRunTranscript} first (so the OR-of-five
 * degradation / confidence / metrics semantics are computed identically) and
 * then masks model identity — see the scheme above.
 */
export function maskedCouncilTranscript(input: CouncilRunInput): CouncilTranscript {
  return maskModelIdentity(buildCouncilRunTranscript(input));
}
