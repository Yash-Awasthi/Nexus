// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/deliberation — Structured multi-model deliberation with bias mitigation.
 *
 * Inspired by consilium's council mode.
 * Implements blind first phase, cross-pollination, rotating challenger,
 * and anonymous labels to prevent sycophancy cascades and authority anchoring.
 */

import type { LLMRouter, LLMMessage } from "@nexus/llm-router";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DeliberationConfig {
  models: Array<{ alias: string; name: string }>;
  judgeAlias: string;
  numRounds?: number;
  numDebateRounds?: number;
  enableCrossPollination?: boolean;
  enableRotatingChallenger?: boolean;
  enableCollabEval?: boolean;
}

export interface BlindPhaseResult {
  speakerId: string;
  content: string;
  confidence?: number;
  modelAlias: string;
}

export interface DebateRound {
  round: number;
  challenger: string;
  responses: Array<{ speakerId: string; content: string; confidence?: number }>;
}

export interface DeliberationResult {
  blindPhase: BlindPhaseResult[];
  crossPollination?: string[];
  debateRounds: DebateRound[];
  judgeSynthesis: string;
  collabEval?: string;
  finalRecommendation: string;
  totalCost: number;
  durationMs: number;
}

// ── Deliberation Engine ──────────────────────────────────────────────────────

export class DeliberationEngine {
  private router: LLMRouter;
  private config: DeliberationConfig;

  constructor(router: LLMRouter, config: DeliberationConfig) {
    this.router = router;
    this.config = {
      numRounds: 2,
      numDebateRounds: 3,
      enableCrossPollination: true,
      enableRotatingChallenger: true,
      enableCollabEval: true,
      ...config,
    };
  }

  /**
   * Run a full deliberation on a question.
   */
  async deliberate(question: string): Promise<DeliberationResult> {
    const start = Date.now();
    let totalCost = 0;

    // Phase 1: Blind phase — each model answers independently
    const blindPhase = await this.runBlindPhase(question);

    // Phase 2: Cross-pollination — models read each other's claims
    const crossPollination = this.config.enableCrossPollination
      ? await this.runCrossPollination(question, blindPhase)
      : undefined;

    // Phase 3: Debate — structured rounds with rotating challenger
    const debateRounds = await this.runDebateRounds(question, blindPhase);

    // Phase 4: Judge synthesis
    const judgeSynthesis = await this.runJudgeSynthesis(question, blindPhase, debateRounds);

    // Phase 5: CollabEval — critique the judge's synthesis
    const collabEval = this.config.enableCollabEval
      ? await this.runCollabEval(question, judgeSynthesis)
      : undefined;

    // Phase 6: Final extraction
    const finalRecommendation = await this.extractRecommendation(
      question,
      judgeSynthesis,
      collabEval,
    );

    return {
      blindPhase,
      crossPollination,
      debateRounds,
      judgeSynthesis,
      collabEval,
      finalRecommendation,
      totalCost,
      durationMs: Date.now() - start,
    };
  }

  // ── Phase 1: Blind Phase ──────────────────────────────────────────────

  private async runBlindPhase(question: string): Promise<BlindPhaseResult[]> {
    const results = await Promise.all(
      this.config.models.map(async (model, idx) => {
        const prompt = [
          `You are Speaker ${idx + 1}. Answer the following question independently.`,
          `Provide your analysis with confidence level (1-10).\n`,
          `Question: ${question}\n`,
          `Format your response with:\n`,
          `**Confidence: X/10**\n`,
          `**Answer:** your analysis`,
        ].join("\n");

        const resp = await this.router.complete({
          model: model.alias,
          messages: [{ role: "user", content: prompt }],
          maxTokens: 2048,
        });

        const confidence = this.extractConfidence(resp.content);

        return {
          speakerId: `Speaker ${idx + 1}`,
          content: resp.content,
          confidence,
          modelAlias: model.alias,
        };
      }),
    );

    return results;
  }

  // ── Phase 2: Cross-Pollination ────────────────────────────────────────

  private async runCrossPollination(
    question: string,
    blindPhase: BlindPhaseResult[],
  ): Promise<string[]> {
    const allClaims = blindPhase
      .map((r) => `${r.speakerId}: ${r.content.slice(0, 500)}`)
      .join("\n\n");

    const results = await Promise.all(
      this.config.models.map(async (model) => {
        const prompt = [
          `You previously answered: "${question.slice(0, 200)}"`,
          `Now read the blind claims from all speakers:\n\n${allClaims}\n`,
          `Identify gaps, contradictions, and insights you missed.`,
          `Provide a brief analysis of what you would revise.`,
        ].join("\n");

        const resp = await this.router.complete({
          model: model.alias,
          messages: [{ role: "user", content: prompt }],
          maxTokens: 1024,
        });

        return resp.content;
      }),
    );

    return results;
  }

  // ── Phase 3: Debate Rounds ────────────────────────────────────────────

  private async runDebateRounds(
    question: string,
    blindPhase: BlindPhaseResult[],
  ): Promise<DebateRound[]> {
    const rounds: DebateRound[] = [];
    let currentClaims = blindPhase.map((r) => ({
      speakerId: r.speakerId,
      content: r.content,
      confidence: r.confidence,
    }));

    for (let round = 0; round < (this.config.numDebateRounds ?? 3); round++) {
      // Select challenger (rotating)
      const challengerIdx = round % this.config.models.length;
      const challenger = `Speaker ${challengerIdx + 1}`;

      // Challenge prompt
      const challengePrompt = [
        `You are the challenger in debate round ${round + 1}.`,
        `Question: ${question}\n`,
        `Previous claims:\n${currentClaims.map((c) => `${c.speakerId}: ${c.content.slice(0, 300)}`).join("\n\n")}\n`,
        `Challenge the majority position. Identify weaknesses and provide counter-arguments.`,
      ].join("\n");

      const challengeResp = await this.router.complete({
        model: this.config.models[challengerIdx]!.alias,
        messages: [{ role: "user", content: challengePrompt }],
        maxTokens: 1024,
      });

      // Other speakers respond to the challenge
      const responses = await Promise.all(
        this.config.models
          .filter((_, idx) => idx !== challengerIdx)
          .map(async (model, idx) => {
            const respIdx = idx >= challengerIdx ? idx + 1 : idx;
            const prompt = [
              `You are Speaker ${respIdx + 1} in debate round ${round + 1}.`,
              `The challenger (${challenger}) argues:\n${challengeResp.content.slice(0, 500)}\n`,
              `Defend or revise your position. Be specific about where you agree or disagree.`,
            ].join("\n");

            const resp = await this.router.complete({
              model: model.alias,
              messages: [{ role: "user", content: prompt }],
              maxTokens: 1024,
            });

            return {
              speakerId: `Speaker ${respIdx + 1}`,
              content: resp.content,
              confidence: this.extractConfidence(resp.content),
            };
          }),
      );

      rounds.push({
        round: round + 1,
        challenger,
        responses: [
          { speakerId: challenger, content: challengeResp.content },
          ...responses,
        ],
      });

      // Update claims for next round
      currentClaims = responses;
    }

    return rounds;
  }

  // ── Phase 4: Judge Synthesis ──────────────────────────────────────────

  private async runJudgeSynthesis(
    question: string,
    blindPhase: BlindPhaseResult[],
    debateRounds: DebateRound[],
  ): Promise<string> {
    const blindSummary = blindPhase
      .map((r) => `${r.speakerId} (confidence: ${r.confidence ?? "N/A"}): ${r.content.slice(0, 300)}`)
      .join("\n\n");

    const debateSummary = debateRounds
      .map(
        (r) =>
          `Round ${r.round} (challenger: ${r.challenger}):\n${r.responses.map((resp) => `  ${resp.speakerId}: ${resp.content.slice(0, 200)}`).join("\n")}`,
      )
      .join("\n\n");

    const prompt = [
      `You are an impartial judge synthesizing a multi-model deliberation.`,
      `Question: ${question}\n`,
      `Blind Phase Results:\n${blindSummary}\n`,
      `Debate Rounds:\n${debateSummary}\n`,
      `Provide a balanced synthesis that:\n`,
      `1. Identifies the strongest arguments from each side`,
      `2. Notes where consensus emerged`,
      `3. Highlights remaining disagreements`,
      `4. Gives your assessment of the most likely correct answer`,
    ].join("\n");

    const resp = await this.router.complete({
      model: this.config.judgeAlias,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 2048,
    });

    return resp.content;
  }

  // ── Phase 5: CollabEval ───────────────────────────────────────────────

  private async runCollabEval(question: string, synthesis: string): Promise<string> {
    const prompt = [
      `You are a critical evaluator reviewing a judge's synthesis.`,
      `Question: ${question}\n`,
      `Judge's synthesis:\n${synthesis}\n`,
      `Critique the synthesis. Identify:\n`,
      `1. Logical gaps or unsupported claims`,
      `2. Missing perspectives`,
      `3. Whether the synthesis appropriately weighs evidence`,
      `Be constructive but rigorous.`,
    ].join("\n");

    const resp = await this.router.complete({
      model: this.config.judgeAlias,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 1024,
    });

    return resp.content;
  }

  // ── Phase 6: Final Extraction ─────────────────────────────────────────

  private async extractRecommendation(
    question: string,
    synthesis: string,
    collabEval?: string,
  ): Promise<string> {
    const prompt = [
      `Based on the following synthesis${collabEval ? " and critique" : ""}, extract actionable recommendations.`,
      `Question: ${question}\n`,
      `Synthesis: ${synthesis.slice(0, 1000)}\n`,
      collabEval ? `Critique: ${collabEval.slice(0, 500)}\n` : "",
      `Format as:\n`,
      `## Do Now\n- action items\n`,
      `## Consider Later\n- items needing more thought\n`,
      `## Skip\n- items not worth pursuing`,
    ].join("\n");

    const resp = await this.router.complete({
      model: this.config.judgeAlias,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 1024,
    });

    return resp.content;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private extractConfidence(text: string): number | undefined {
    const lines = text.split("\n").slice(-10);
    for (const line of lines.reverse()) {
      const lower = line.toLowerCase();
      if (lower.includes("confidence:")) {
        const match = lower.match(/(\d+)\s*\/\s*10/);
        if (match) {
          const score = parseInt(match[1]!, 10);
          if (score <= 10) return score;
        }
      }
    }
    return undefined;
  }
}

export default DeliberationEngine;
