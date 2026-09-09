// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/ensemble-refinement — Ensemble refinement for improved LLM accuracy.
 *
 * Inspired by DebateLLM's EnsembleRefinementDebate (arxiv:2305.09617).
 * Generates multiple independent reasoning samples via temperature sampling,
 * then aggregates them through iterative refinement rounds.
 */

import type { LLMRouter, LLMMessage } from "@nexus/llm-router";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EnsembleConfig {
  /** Model alias to use */
  alias: string;
  /** Number of independent reasoning samples */
  numReasoningSteps: number;
  /** Number of aggregation rounds */
  numAggregationSteps: number;
  /** Temperature for sampling diversity */
  temperature?: number;
}

export interface ReasoningSample {
  id: number;
  answer: string;
  reasoning: string;
  confidence?: number;
}

export interface EnsembleResult {
  finalAnswer: string;
  samples: ReasoningSample[];
  aggregatedRound: string;
  consensus: number; // fraction of samples that agree
  durationMs: number;
}

// ── Ensemble Refinement Engine ───────────────────────────────────────────────

export class EnsembleRefinement {
  private router: LLMRouter;

  constructor(router: LLMRouter) {
    this.router = router;
  }

  /**
   * Run ensemble refinement on a question.
   */
  async answer(question: string, config: EnsembleConfig): Promise<EnsembleResult> {
    const start = Date.now();

    // Phase 1: Generate multiple independent reasoning samples
    const samples = await this.generateSamples(question, config);

    // Phase 2: Iterative aggregation
    let aggregated = await this.aggregate(question, samples, config);

    for (let i = 1; i < config.numAggregationSteps; i++) {
      aggregated = await this.refineAggregation(question, aggregated, config);
    }

    // Phase 3: Extract final answer
    const finalAnswer = this.extractAnswer(aggregated);
    const consensus = this.computeConsensus(samples, finalAnswer);

    return {
      finalAnswer,
      samples,
      aggregatedRound: aggregated,
      consensus,
      durationMs: Date.now() - start,
    };
  }

  // ── Phase 1: Independent Sampling ─────────────────────────────────────

  private async generateSamples(
    question: string,
    config: EnsembleConfig,
  ): Promise<ReasoningSample[]> {
    const prompt = [
      `Question: ${question}`,
      ``,
      `Please answer this question step by step.`,
      `First, provide your detailed reasoning.`,
      `Then, state your final answer on a new line starting with "Answer:".`,
    ].join("\n");

    const samples: ReasoningSample[] = [];

    // Generate samples in parallel with temperature variation
    const results = await Promise.all(
      Array.from({ length: config.numReasoningSteps }, (_, i) =>
        this.router
          .complete({
            model: config.alias,
            messages: [{ role: "user", content: prompt }],
            maxTokens: 1024,
            temperature: config.temperature ?? 0.7,
          })
          .then((resp) => ({ id: i, content: resp.content })),
      ),
    );

    for (const result of results) {
      const { answer, reasoning } = this.parseResponse(result.content);
      samples.push({
        id: result.id,
        answer,
        reasoning,
      });
    }

    return samples;
  }

  // ── Phase 2: Aggregation ──────────────────────────────────────────────

  private async aggregate(
    question: string,
    samples: ReasoningSample[],
    config: EnsembleConfig,
  ): Promise<string> {
    const sampleSummaries = samples
      .map(
        (s, i) =>
          `Reasoning ${i + 1}:\nAnswer: ${s.answer}\nReasoning: ${s.reasoning.slice(0, 300)}`,
      )
      .join("\n\n");

    const prompt = [
      `Question: ${question}`,
      ``,
      `Multiple independent reasonings have been generated:`,
      sampleSummaries,
      ``,
      `Your task: Review all reasonings above. Consider which answers appear most`,
      `frequently and which reasoning chains are most sound. Provide your aggregated`,
      `analysis and final answer.`,
      ``,
      `Start your response with "Aggregated Analysis:" and end with "Answer:".`,
    ].join("\n");

    const resp = await this.router.complete({
      model: config.alias,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 1024,
      temperature: 0.3, // Lower temperature for aggregation
    });

    return resp.content;
  }

  private async refineAggregation(
    question: string,
    previousAggregation: string,
    config: EnsembleConfig,
  ): Promise<string> {
    const prompt = [
      `Question: ${question}`,
      ``,
      `Previous aggregation:`,
      previousAggregation.slice(0, 800),
      ``,
      `Review and refine this aggregation. Consider:`,
      `1. Are there any logical gaps?`,
      `2. Is the reasoning sound?`,
      `3. Is the final answer well-supported?`,
      ``,
      `Provide a refined analysis and answer.`,
    ].join("\n");

    const resp = await this.router.complete({
      model: config.alias,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 1024,
      temperature: 0.2,
    });

    return resp.content;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private parseResponse(content: string): { answer: string; reasoning: string } {
    const lines = content.split("\n");
    let answerStart = -1;

    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.toLowerCase().startsWith("answer:")) {
        answerStart = i;
        break;
      }
    }

    if (answerStart >= 0) {
      const answer = lines[answerStart]!.replace(/^answer:\s*/i, "").trim();
      const reasoning = lines.slice(0, answerStart).join("\n").trim();
      return { answer, reasoning };
    }

    // Fallback: last non-empty line is the answer
    const lastLine = lines.reverse().find((l) => l.trim()) ?? "";
    return { answer: lastLine, reasoning: content };
  }

  private extractAnswer(text: string): string {
    const lines = text.split("\n").reverse();
    for (const line of lines) {
      if (line.toLowerCase().startsWith("answer:")) {
        return line.replace(/^answer:\s*/i, "").trim();
      }
    }
    // Return last non-empty line
    return lines.find((l) => l.trim()) ?? text;
  }

  private computeConsensus(samples: ReasoningSample[], finalAnswer: string): number {
    if (samples.length === 0) return 0;
    const normalized = finalAnswer.toLowerCase().trim();
    const matching = samples.filter((s) => s.answer.toLowerCase().trim() === normalized).length;
    return matching / samples.length;
  }
}

export default EnsembleRefinement;
