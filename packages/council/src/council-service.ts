// SPDX-License-Identifier: Apache-2.0
/**
 * CouncilService — high-level facade over DeliberationEngine.
 *
 * Responsibilities:
 *  - Constructs a DeliberationEngine with a concrete LLM transport (Groq by default)
 *  - Accepts an optional `onResult` callback so the caller (apps/api) can
 *    persist verdicts + transcripts to DB without this package depending on @nexus/db
 *  - Exposes deliberate() + evaluate() as the public API
 *
 * The `onResult` pattern keeps @nexus/council free of direct DB dependencies
 * while still enabling persistence at the application layer.
 */

import type { CouncilRequest, CouncilResponse, ProposalResult, ModelVote } from "@nexus/contracts";

import { DeliberationEngine, type ILLMTransport } from "./engine.js";
import { GroqTransport } from "./groq-transport.js";

// ── Persistence callback shape ────────────────────────────────────────────────

export interface CouncilPersistPayload {
  result: ProposalResult;
  votes: ModelVote[];
  /** If provided, links the verdict to a pre-existing signal row */
  signalId?: string;
  /** Computed total cost in USD across all votes */
  totalCostUsd: number;
}

export type OnResultFn = (payload: CouncilPersistPayload) => Promise<void>;

// ── Config ────────────────────────────────────────────────────────────────────

export interface CouncilServiceConfig {
  /** Custom LLM transport — if omitted, GroqTransport is instantiated */
  llm?: ILLMTransport;
  /** Only used when `llm` is not provided */
  groqApiKey?: string;
  /** Called after each successful deliberation for DB persistence */
  onResult?: OnResultFn;
  defaultCouncilSize?: number;
  defaultModel?: string;
  /** USD cost per 1k input tokens (default: Groq llama-3.3-70b rate) */
  inputCostPer1k?: number;
  /** USD cost per 1k output tokens */
  outputCostPer1k?: number;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class CouncilService {
  private readonly engine: DeliberationEngine;
  private readonly onResult?: OnResultFn;

  constructor(config: CouncilServiceConfig = {}) {
    const transport = config.llm ?? new GroqTransport(config.groqApiKey);
    this.engine = new DeliberationEngine({
      llm: transport,
      defaultCouncilSize: config.defaultCouncilSize ?? 5,
      ...(config.defaultModel !== undefined ? { defaultModel: config.defaultModel } : {}),
      ...(config.inputCostPer1k !== undefined ? { inputCostPer1k: config.inputCostPer1k } : {}),
      ...(config.outputCostPer1k !== undefined ? { outputCostPer1k: config.outputCostPer1k } : {}),
    });
    if (config.onResult !== undefined) {
      this.onResult = config.onResult;
    }
  }

  /**
   * Run a full council deliberation.
   * @param request   CouncilRequest from @nexus/contracts
   * @param opts.signalId  Optional FK to link the resulting verdict to a Signal row
   */
  async deliberate(
    request: CouncilRequest,
    opts?: { signalId?: string },
  ): Promise<CouncilResponse> {
    const response = await this.engine.deliberate(request);

    if (this.onResult && response.ok && response.result) {
      const result = response.result;

      // totalCostUsd is computed from per-vote token usage in DeliberationEngine
      // and surfaced on ProposalResult — read it directly (no recomputation needed).
      const totalCostUsd = result.totalCostUsd;

      await this.onResult({
        result,
        votes: result.votes,
        ...(opts?.signalId !== undefined ? { signalId: opts.signalId } : {}),
        totalCostUsd,
      }).catch((err: unknown) => {
        console.error("[CouncilService] onResult persistence failed:", err);
      });
    }

    return response;
  }

  /**
   * Alias for deliberate — used when framing the request as an evaluation
   * rather than a full debate (e.g. single policy-check calls).
   */
  async evaluate(request: CouncilRequest): Promise<CouncilResponse> {
    return this.deliberate(request);
  }
}
