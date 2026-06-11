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
import { BudgetExceededError } from "@nexus/shared";
import { summonArchetypes, type Archetype, type TaskCategory } from "./archetypes.js";

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
  chat(messages: ILLMMessage[], options?: { model?: string; temperature?: number; maxTokens?: number }): Promise<ILLMResponse>;
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
}

// ── Vote parsing ──────────────────────────────────────────────────────────────

const YES_PATTERNS = /\b(yes|approve|support|agree|favor|proceed)\b/i;
const NO_PATTERNS = /\b(no|reject|oppose|disagree|against|decline)\b/i;

function parseVote(content: string): "yes" | "no" | "abstain" {
  const lower = content.toLowerCase();
  const yesScore = (lower.match(YES_PATTERNS) ?? []).length;
  const noScore = (lower.match(NO_PATTERNS) ?? []).length;
  if (yesScore === 0 && noScore === 0) return "abstain";
  return yesScore >= noScore ? "yes" : "no";
}

function parseConfidence(content: string): number {
  // Look for explicit confidence statements: "confidence: 0.8", "80% confident", etc.
  const pct = content.match(/(\d{1,3})\s*%\s*confident/i);
  if (pct?.[1]) return Math.min(1, parseInt(pct[1], 10) / 100);
  const dec = content.match(/confidence[:\s]+([0-9.]+)/i);
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
      inputCostPer1k: 0.0006,   // Groq llama-3.3-70b default
      outputCostPer1k: 0.0008,
      ...config,
    };
  }

  /**
   * Run a full deliberation and return a CouncilResponse.
   */
  async deliberate(request: CouncilRequest): Promise<CouncilResponse> {
    const startTime = Date.now();
    const proposalId = randomUUID();

    const { proposal, budgetUsd = Infinity, timeoutMs = 60_000 } = request;

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
        const response = await Promise.race([
          this.config.llm.chat(
            [
              { role: "system", content: archetype.systemPrompt },
              { role: "user", content: userPrompt },
            ],
            { model: this.config.defaultModel, temperature: 0.7, maxTokens: 512 },
          ),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Vote timeout")), timeoutMs),
          ),
        ]);

        const costUsd =
          (response.usage.promptTokens / 1000) * this.config.inputCostPer1k +
          (response.usage.completionTokens / 1000) * this.config.outputCostPer1k;

        totalCostUsd += costUsd;
        if (totalCostUsd > budgetUsd) {
          throw new BudgetExceededError({ totalCostUsd, budgetUsd });
        }

        return {
          model: response.model,
          provider: "groq",
          vote: parseVote(response.content),
          reasoning: response.content,
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

    const rawVotes = await Promise.all(votePromises);
    votes.push(...rawVotes);

    // Tally
    const yesVotes = votes.filter(v => v.vote === "yes").length;
    const noVotes = votes.filter(v => v.vote === "no").length;
    const totalNonAbstain = yesVotes + noVotes;
    const consensus = totalNonAbstain > 0 ? yesVotes / totalNonAbstain : 0;
    const majority: "yes" | "no" | "tie" = yesVotes > noVotes ? "yes" : noVotes > yesVotes ? "no" : "tie";

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
    const yesCount = votes.filter(v => v.vote === "yes").length;
    const noCount = votes.filter(v => v.vote === "no").length;
    const abstainCount = votes.filter(v => v.vote === "abstain").length;
    return `Council ${outcome}. ${yesCount} YES / ${noCount} NO / ${abstainCount} ABSTAIN. Majority: ${majority.toUpperCase()}.`;
  }
}
