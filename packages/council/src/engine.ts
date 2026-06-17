// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/council — DeliberationEngine
 *
 * Orchestrates multi-model deliberation using the archetype council system.
 * Each archetype casts a vote (yes/no/abstain + reasoning) via an LLM call.
 * The engine aggregates votes, computes consensus, and returns a ProposalResult.
 *
 * LLM transport is injected via the ILLMTransport interface so the engine is
 * not coupled to any specific provider (Groq, Anthropic, OpenAI, etc.).
 */

import { randomUUID } from "crypto";

import type { CouncilRequest, CouncilResponse, ProposalResult, ModelVote } from "@nexus/contracts";
import { BudgetExceededError, applySTMs, COUNCIL_STM_PRESET } from "@nexus/shared";
import type { STMModule } from "@nexus/shared";

import { summonArchetypes, type TaskCategory } from "./archetypes.js";

// ── LLM transport interface ───────────────────────────────────────────────────

export interface ILLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ILLMResponse {
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
  latencyMs: number;
}

export interface ILLMTransport {
  chat(
    messages: ILLMMessage[],
    options?: { model?: string; temperature?: number; maxTokens?: number },
  ): Promise<ILLMResponse>;
}

// ── Engine config ─────────────────────────────────────────────────────────────

export interface DeliberationEngineConfig {
  /** LLM transport used to call each archetype */
  llm: ILLMTransport;
  /** Default archetype count per deliberation (default: 5) */
  defaultCouncilSize?: number;
  /** Default model to use when none specified (default: "llama-3.3-70b-versatile") */
  defaultModel?: string;
  /** Cost per 1k input tokens in USD for budget tracking */
  inputCostPer1k?: number;
  /** Cost per 1k output tokens in USD for budget tracking */
  outputCostPer1k?: number;
  /**
   * STM (Semantic Transformation Modules) applied to each archetype's reasoning
   * text before it is surfaced in the vote.  Strips hedges and preambles by default.
   * Pass an empty array to disable all post-processing.
   * Default: COUNCIL_STM_PRESET (hedgeReducer + directMode, both enabled).
   */
  stmModules?: STMModule[];
}

// ── Vote parsing ──────────────────────────────────────────────────────────────

const YES_PATTERNS = /\b(yes|approve|support|agree|favor|proceed)\b/i;
const NO_PATTERNS = /\b(no|reject|oppose|disagree|against|decline)\b/i;

function parseVote(content: string): "yes" | "no" | "abstain" {
  const lower = content.toLowerCase();
  const yesScore = (YES_PATTERNS.exec(lower) ?? []).length;
  const noScore = (NO_PATTERNS.exec(lower) ?? []).length;
  if (yesScore === 0 && noScore === 0) return "abstain";
  return yesScore >= noScore ? "yes" : "no";
}

function parseConfidence(content: string): number {
  // Look for explicit confidence statements: "confidence: 0.8", "80% confident", etc.
  const pct = /(\d{1,3})\s*%\s*confident/i.exec(content);
  if (pct?.[1]) return Math.min(1, parseInt(pct[1], 10) / 100);
  const dec = /confidence[:\s]+([0-9.]+)/i.exec(content);
  if (dec?.[1]) {
    const v = parseFloat(dec[1]);
    return v > 1 ? v / 100 : v;
  }
  // Default based on vote strength
  return 0.65;
}

// ── DeliberationEngine ────────────────────────────────────────────────────────

export class DeliberationEngine {
  private readonly config: Required<DeliberationEngineConfig>;

  constructor(config: DeliberationEngineConfig) {
    this.config = {
      defaultCouncilSize: 5,
      defaultModel: "llama-3.3-70b-versatile",
      inputCostPer1k: 0.0006, // Groq llama-3.3-70b default
      outputCostPer1k: 0.0008,
      stmModules: COUNCIL_STM_PRESET,
      ...config,
    };
  }

  /**
   * Run a full deliberation and return a CouncilResponse.
   */
  async deliberate(request: CouncilRequest): Promise<CouncilResponse> {
    const startTime = Date.now();
    const proposalId = randomUUID();

    // Cap timeoutMs to prevent resource exhaustion from user-supplied values.
    const MAX_VOTE_TIMEOUT_MS = 300_000; // 5 minutes hard cap
    const rawTimeout = request.timeoutMs ?? 60_000;
    const { proposal, budgetUsd = Infinity } = request;
    const timeoutMs = Math.min(Math.max(1, rawTimeout), MAX_VOTE_TIMEOUT_MS);

    // Detect task category from title/description
    const category = this._detectCategory(proposal.title + " " + (proposal.description ?? ""));
    const archetypes = summonArchetypes(category, this.config.defaultCouncilSize);

    // Deliberation prompt
    const userPrompt = this._buildPrompt(proposal);

    let totalCostUsd = 0;
    const votes: ModelVote[] = [];

    // Run each archetype vote concurrently (with a timeout guard)
    const votePromises = archetypes.map(async (archetype) => {
      const voteStart = Date.now();
      try {
        // Explicit timer handle so we can clear it when the LLM resolves first,
        // preventing the leaked setTimeout from keeping the event loop alive
        // (resource exhaustion via accumulated timers in high-concurrency runs).
        let voteTimer: ReturnType<typeof setTimeout> | undefined;
        const response = await Promise.race([
          this.config.llm
            .chat(
              [
                { role: "system", content: archetype.systemPrompt },
                { role: "user", content: userPrompt },
              ],
              { model: this.config.defaultModel, temperature: 0.7, maxTokens: 512 },
            )
            .then((r) => {
              clearTimeout(voteTimer);
              return r;
            }),
          new Promise<never>((_, reject) => {
            voteTimer = setTimeout(() => {
              reject(new Error("Vote timeout"));
            }, timeoutMs);
          }),
        ]);

        const costUsd =
          (response.usage.promptTokens / 1000) * this.config.inputCostPer1k +
          (response.usage.completionTokens / 1000) * this.config.outputCostPer1k;

        totalCostUsd += costUsd;
        if (totalCostUsd > budgetUsd) {
          throw new BudgetExceededError({ totalCostUsd, budgetUsd });
        }

        // Apply STM post-processors to reasoning before surfacing it.
        // Vote parsing uses the raw content so signal words aren't stripped.
        const reasoning = applySTMs(response.content, this.config.stmModules);

        return {
          model: response.model,
          provider: "groq",
          vote: parseVote(response.content),
          reasoning,
          confidence: parseConfidence(response.content),
          latencyMs: response.latencyMs,
        } satisfies ModelVote;
      } catch (err) {
        // Non-fatal: record abstain for failed votes
        return {
          model: this.config.defaultModel,
          provider: "unknown",
          vote: "abstain" as const,
          reasoning: `Vote failed: ${err instanceof Error ? err.message : String(err)}`,
          confidence: 0,
          latencyMs: Date.now() - voteStart,
        } satisfies ModelVote;
      }
    });

    // Promise.allSettled so a stray throw that escapes the per-vote try-catch
    // (e.g. an OOM inside an archetype callback) can never abort all N concurrent
    // LLM calls and lose the entire deliberation.  Each vote promise already
    // returns an abstain on expected failures — allSettled is a second safety net.
    const settled = await Promise.allSettled(votePromises);
    const rawVotes = settled.map(
      (s): ModelVote =>
        s.status === "fulfilled"
          ? s.value
          : {
              model: this.config.defaultModel,
              provider: "unknown",
              vote: "abstain",
              reasoning: `Vote rejected: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
              confidence: 0,
              latencyMs: 0,
            },
    );
    votes.push(...rawVotes);

    // Tally
    const yesVotes = votes.filter((v) => v.vote === "yes").length;
    const noVotes = votes.filter((v) => v.vote === "no").length;
    const totalNonAbstain = yesVotes + noVotes;
    const consensus = totalNonAbstain > 0 ? yesVotes / totalNonAbstain : 0;
    const majority: "yes" | "no" | "tie" =
      yesVotes > noVotes ? "yes" : noVotes > yesVotes ? "no" : "tie";

    const outcome: ProposalResult["outcome"] =
      majority === "yes" && consensus >= 0.6
        ? "approved"
        : majority === "no"
          ? "rejected"
          : "deferred";

    const result: ProposalResult = {
      proposalId,
      title: proposal.title,
      outcome,
      votes,
      consensus: Math.round(consensus * 100) / 100,
      dissent: Math.round((1 - consensus) * 100) / 100,
      majority,
      summary: this._buildSummary(outcome, votes, majority),
      deliberatedAt: new Date().toISOString(),
      totalLatencyMs: Date.now() - startTime,
      totalCostUsd: Math.round(totalCostUsd * 1e8) / 1e8, // 8 d.p. = sub-cent precision
    };

    return { ok: true, result };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _detectCategory(text: string): TaskCategory {
    const lower = text.toLowerCase();
    if (/\b(debate|argue|pro|con|versus|vs)\b/.test(lower)) return "debate";
    if (/\b(research|study|analyze|evidence|data)\b/.test(lower)) return "research";
    if (/\b(business|revenue|market|product|strategy)\b/.test(lower)) return "business";
    if (/\b(code|technical|architecture|system|deploy|build)\b/.test(lower)) return "technical";
    if (/\b(creative|design|story|write|art|idea)\b/.test(lower)) return "creative";
    if (/\b(ethical|moral|right|wrong|harm|benefit)\b/.test(lower)) return "ethical";
    if (/\b(strategy|plan|roadmap|growth|competitive)\b/.test(lower)) return "strategy";
    if (/\b(personal|feel|emotion|relationship|life)\b/.test(lower)) return "personal";
    return "default";
  }

  private _buildPrompt(proposal: CouncilRequest["proposal"]): string {
    const contextLines: string[] = [];
    if (proposal.context) {
      for (const [key, value] of Object.entries(proposal.context)) {
        contextLines.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
    return [
      `PROPOSAL: ${proposal.title}`,
      "",
      proposal.description,
      ...(contextLines.length > 0 ? ["", "CONTEXT:", ...contextLines] : []),
      "",
      "Please provide your analysis and vote (YES/NO/ABSTAIN) with your confidence level and reasoning.",
    ].join("\n");
  }

  private _buildSummary(
    outcome: ProposalResult["outcome"],
    votes: ModelVote[],
    majority: "yes" | "no" | "tie",
  ): string {
    const yesCount = votes.filter((v) => v.vote === "yes").length;
    const noCount = votes.filter((v) => v.vote === "no").length;
    const abstainCount = votes.filter((v) => v.vote === "abstain").length;
    return `Council ${outcome}. ${yesCount} YES / ${noCount} NO / ${abstainCount} ABSTAIN. Majority: ${majority.toUpperCase()}.`;
  }
}

// ── Financial deliberation schemas ────────────────────────────────────────────
// Ported from TauricResearch/TradingAgents: tradingagents/agents/schemas.py
// Pattern: multi-agent financial deliberation with 3 structured roles:
//   ResearchManager  → ResearchPlan   (5-tier rating + rationale)
//   Trader           → TraderProposal  (3-tier action + entry/stop/sizing)
//   PortfolioManager → PortfolioDecision (final rating + thesis + price target)
// Plus: SentimentAnalyst → SentimentReport (6-tier band + 0–10 score)
// These types are the council output layer for financial decision deliberation.

/** 5-tier portfolio rating (Research Manager + Portfolio Manager). */
export type PortfolioRating =
  | "Buy"
  | "Overweight"
  | "Hold"
  | "Underweight"
  | "Sell";

/** 3-tier transaction direction (Trader agent). */
export type TraderAction = "Buy" | "Hold" | "Sell";

/** 6-tier sentiment band (Sentiment Analyst). */
export type SentimentBand =
  | "Bullish"
  | "Mildly Bullish"
  | "Neutral"
  | "Mixed"
  | "Mildly Bearish"
  | "Bearish";

/**
 * Structured investment plan from the Research Manager.
 * Synthesises bull/bear debate into a directional recommendation with
 * concrete actions for the downstream Trader agent.
 */
export interface ResearchPlan {
  recommendation: PortfolioRating;
  /** Prose summary of key bull/bear points and the deciding argument. */
  rationale: string;
  /** Concrete entry/sizing/risk instructions for the Trader. */
  strategicActions: string;
}

/**
 * Concrete transaction proposal from the Trader agent.
 * Translates the Research Manager's plan into an executable order proposal.
 */
export interface TraderProposal {
  action: TraderAction;
  /** 2–4 sentence justification anchored in analyst reports. */
  reasoning: string;
  /** Optional limit entry price in quote currency. */
  entryPrice?: number;
  /** Optional stop-loss price. */
  stopLoss?: number;
  /** Optional sizing guidance, e.g. "5% of portfolio". */
  positionSizing?: string;
}

/**
 * Final portfolio decision from the Portfolio Manager.
 * Synthesises all analyst debate into a rated investment thesis.
 */
export interface PortfolioDecision {
  rating: PortfolioRating;
  /** 2–4 sentence action plan covering entry, sizing, risk levels, time horizon. */
  executiveSummary: string;
  /** Detailed thesis anchored in specific analyst evidence. */
  investmentThesis: string;
  /** Optional price target in quote currency. */
  priceTarget?: number;
  /** Optional holding period, e.g. "3–6 months". */
  timeHorizon?: string;
}

/**
 * Structured sentiment report from the Sentiment Analyst.
 * Replaces free-form prose so downstream agents can read overallBand
 * and overallScore without regex fragility.
 */
export interface SentimentReport {
  overallBand: SentimentBand;
  /** Sentiment intensity 0–10 (0 = max bearish, 5 = neutral, 10 = max bullish). */
  overallScore: number;
  /** Data quality confidence of the assessment. */
  confidence: "low" | "medium" | "high";
  /** Full narrative with source breakdown, divergences, themes, risks. */
  narrative: string;
}

/**
 * Post-trade reflection record from the Reflector.
 * Ported from TradingAgents Reflector.reflect_on_final_decision().
 * Stored in the decision log; re-injected into future agent prompts as lessons.
 */
export interface FinancialReflectionRecord {
  /** ISO-8601 timestamp of the reflection. */
  createdAt: string;
  /** The original decision text being reflected on. */
  originalDecision: string;
  /** Actual raw return of the trade (e.g. 0.03 = +3%). */
  rawReturn: number;
  /** Alpha vs benchmark (e.g. -0.01 = underperformed SPY by 1%). */
  alphaReturn: number;
  /** Benchmark name used for alpha comparison (default "SPY"). */
  benchmarkName: string;
  /** 2–4 sentence lesson: directional correctness, thesis assessment, future lesson. */
  lesson: string;
}

/**
 * Parse a PortfolioRating from LLM output text.
 * Handles case-insensitive match and common variations.
 * Ported from TradingAgents agents/utils/rating.py parse_rating().
 */
export function parsePortfolioRating(text: string): PortfolioRating {
  const t = text.toLowerCase();
  if (t.includes("strong buy") || t.includes("buy")) return "Buy";
  if (t.includes("overweight")) return "Overweight";
  if (t.includes("underweight")) return "Underweight";
  if (t.includes("strong sell") || t.includes("sell")) return "Sell";
  return "Hold";
}

/** Convert a PortfolioRating to a numeric signal (-2 to +2). */
export function ratingToSignal(rating: PortfolioRating): number {
  const map: Record<PortfolioRating, number> = {
    Buy: 2,
    Overweight: 1,
    Hold: 0,
    Underweight: -1,
    Sell: -2,
  };
  return map[rating];
}
