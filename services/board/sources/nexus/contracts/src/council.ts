// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/contracts — council deliberation types
 *
 * Shared shapes for @nexus/council deliberation requests and results.
 */

// ── Proposal ──────────────────────────────────────────────────────────────────

export interface ProposalInput {
  /** Short title for the proposal, e.g. "Should we invest in AAPL?" */
  title: string;
  /** Full description / context fed to the council */
  description: string;
  /** Additional structured context (tickers, events, etc.) */
  context?: Record<string, unknown>;
  /** Optional: constrain to these model keys from @nexus/shared */
  models?: string[];
}

export type ProposalOutcome = "approved" | "rejected" | "deferred";

export interface ModelVote {
  model: string;
  provider: string;
  vote: "yes" | "no" | "abstain";
  reasoning: string;
  confidence: number;
  latencyMs: number;
}

export interface ProposalResult {
  proposalId: string;
  title: string;
  outcome: ProposalOutcome;
  votes: ModelVote[];
  consensus: number;
  dissent: number;
  majority: "yes" | "no" | "tie";
  summary: string;
  deliberatedAt: string;
  totalLatencyMs: number;
  /** Sum of per-vote LLM token costs in USD (computed from usage.promptTokens + completionTokens). */
  totalCostUsd: number;
}

// ── Council request / response ────────────────────────────────────────────────

export interface CouncilRequest {
  proposal: ProposalInput;
  /** Max total cost in USD — council aborts if exceeded */
  budgetUsd?: number;
  /** Max wall-clock time for the deliberation in ms */
  timeoutMs?: number;
  /** Number of archetypes to summon (1–14). Defaults to the council config. */
  councilSize?: number;
  /** majority (default): 60% of yes/no votes; unanimous: no dissent; weighted: votes count by confidence. */
  mode?: "majority" | "unanimous" | "weighted";
}

export interface CouncilResponse {
  ok: boolean;
  result?: ProposalResult;
  error?: string;
}
