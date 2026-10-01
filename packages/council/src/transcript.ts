// SPDX-License-Identifier: Apache-2.0
/**
 * Inspectable deliberation transcript (Weiping Council / llm-debate-system
 * parity, row 128 — pass 58).
 *
 * The deliberation mechanisms (DeliberativeCouncil, protocols) exist; what the
 * repo adds on top is a run-level observability ARTIFACT: a structured record
 * of a deliberation run that stays inspectable after the fact — route evidence
 * (routing), per-phase timings (metrics), model-call traces with error kinds,
 * provider health, dissent, warnings, and an honest `degraded` verdict.
 *
 * Ported from llm-debate-system's SessionResult + Orchestrator._attach_observability:
 *   • degraded is the OR of five independent sources — protocol, provider
 *     readiness, model-call trace errors, context recall, confidence validity;
 *   • each source appends its own warning string (faithful text);
 *   • out-of-range/non-finite confidence is clamped AND flagged;
 *   • when traces carry errors, confidence is additionally capped at the
 *     successful-call ratio;
 *   • warnings are deduped and sorted before finalization.
 *
 * The recorder is transport-agnostic: callers (DeliberativeCouncil, debate
 * runs, apps) push stages/audit entries and supply traces + provider health.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** One phase of the run (e.g. "Council Round 1", "Self-Refine"). */
export interface TranscriptStage {
  name: string;
  [key: string]: unknown;
}

/** A single model call during the run; `error_kind` marks failures. */
export interface ModelCallTrace {
  model: string;
  role?: string;
  error_kind?: string;
  latencyMs?: number;
  [key: string]: unknown;
}

/** Provider readiness snapshot entry. */
export interface ProviderHealthEntry {
  id: string;
  ready: boolean;
  [key: string]: unknown;
}

/** One audit-trail entry (step name + free-form fields). */
export interface AuditEntry {
  step: string;
  [key: string]: unknown;
}

export interface CouncilTranscript {
  id: string;
  query: string;
  protocol: string;
  createdAt: string;
  stages: TranscriptStage[];
  finalAnswer: string;
  confidence: number;
  dissent: string[];
  auditTrail: AuditEntry[];
  routing: Record<string, unknown>;
  metrics: Record<string, number>;
  providerHealth: ProviderHealthEntry[];
  modelCallTraces: ModelCallTrace[];
  degraded: boolean;
  warnings: string[];
}

export interface FinalizeOptions {
  /** Per-phase timings (ms) recorded during the run. */
  metrics?: Record<string, number>;
  /** Run-scoped warnings collected during the run. */
  warnings?: string[];
  /** Provider readiness snapshot at run end. */
  providerHealth?: ProviderHealthEntry[];
  /** Every model call made during the run (error_kind marks failures). */
  modelCallTraces?: ModelCallTrace[];
  /** Whether the protocol itself reported degradation. */
  protocolDegraded?: boolean;
  /** Start timestamp (ms) — sets metrics.total_ms when provided. */
  startedAt?: number;
}

export interface TranscriptInit {
  id: string;
  query: string;
  protocol: string;
  createdAt?: string;
}

// ── Construction ──────────────────────────────────────────────────────────────

/** Fresh transcript with all artifact fields initialized. */
export function createTranscript(init: TranscriptInit): CouncilTranscript {
  return {
    id: init.id,
    query: init.query,
    protocol: init.protocol,
    createdAt: init.createdAt ?? new Date().toISOString(),
    stages: [],
    finalAnswer: "",
    confidence: 0,
    dissent: [],
    auditTrail: [],
    routing: {},
    metrics: {},
    providerHealth: [],
    modelCallTraces: [],
    degraded: false,
    warnings: [],
  };
}

/** Append a stage record (e.g. "Council Round 1", "Self-Refine"). */
export function recordStage(
  transcript: CouncilTranscript,
  stage: TranscriptStage,
): CouncilTranscript {
  transcript.stages.push(stage);
  return transcript;
}

/** Append an audit-trail entry with a step name and optional fields. */
export function appendAudit(
  transcript: CouncilTranscript,
  step: string,
  fields: Record<string, unknown> = {},
): CouncilTranscript {
  transcript.auditTrail.push({ step, ...fields });
  return transcript;
}

/** Record route evidence (Weiping Council's routing dict + audit entry). */
export function recordRouting(
  transcript: CouncilTranscript,
  routing: Record<string, unknown>,
): CouncilTranscript {
  transcript.routing = routing;
  transcript.auditTrail.unshift({ step: "routing", ...routing });
  return transcript;
}

// ── Finalization (Orchestrator._attach_observability port) ────────────────────

/**
 * Compute the run-level observability verdict: degraded = OR of protocol /
 * provider / trace / context / confidence sources, with per-source warnings,
 * confidence clamping + failure-ratio capping, and metrics totals.
 * Mutates and returns the transcript.
 */
export function finalizeTranscript(
  transcript: CouncilTranscript,
  opts: FinalizeOptions = {},
): CouncilTranscript {
  const metrics = { ...opts.metrics };
  const warnings = [...(opts.warnings ?? [])];
  const providerHealth = opts.providerHealth ?? [];
  const traces = opts.modelCallTraces ?? [];

  const protocolDegraded = opts.protocolDegraded ?? transcript.degraded;
  const providerDegraded = providerHealth.some((p) => !p.ready);
  const traceDegraded = traces.some((t) => Boolean(t.error_kind));
  const contextDegraded = warnings.some((w) => /agentmemory|context/i.test(w));
  // confidence is typed number but may be NaN (an invalid model report) —
  // isFinite is the real gate; Number() would be an identity call here.
  const rawConfidence: number = transcript.confidence;
  const confidenceDegraded =
    !Number.isFinite(rawConfidence) || rawConfidence < 0 || rawConfidence > 1;

  // Weiping: non-finite → 0, otherwise clamp after the validity check
  transcript.confidence = Number.isFinite(rawConfidence)
    ? Math.max(0, Math.min(1, rawConfidence))
    : 0;

  if (providerDegraded) {
    warnings.push("One or more providers are not ready; check environment configuration.");
  }
  if (traceDegraded) {
    warnings.push("One or more model calls returned an error or degraded response.");
  }
  if (contextDegraded) {
    warnings.push("Context recall is unavailable or degraded for this run.");
  }
  if (confidenceDegraded) {
    warnings.push("Model-reported confidence was invalid and has been clamped.");
  }

  const successfulCalls = traces.filter((t) => !t.error_kind).length;
  const failedCalls = traces.length - successfulCalls;
  metrics["successful_model_calls"] = successfulCalls;
  metrics["failed_model_calls"] = failedCalls;
  if (opts.startedAt !== undefined) {
    metrics["total_ms"] = Math.round((Date.now() - opts.startedAt) * 100) / 100;
  }

  transcript.degraded =
    protocolDegraded || providerDegraded || traceDegraded || contextDegraded || confidenceDegraded;
  transcript.metrics = metrics;
  transcript.providerHealth = providerHealth;
  transcript.modelCallTraces = traces;

  if (traces.length > 0 && traceDegraded) {
    transcript.confidence = Math.min(transcript.confidence, successfulCalls / traces.length);
  }
  transcript.warnings = [...new Set(warnings)].sort();
  return transcript;
}

/** Serialize the transcript to a plain JSON string (SessionResult.to_dict analog). */
export function transcriptToJson(transcript: CouncilTranscript): string {
  return JSON.stringify(transcript);
}
