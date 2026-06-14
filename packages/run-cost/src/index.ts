// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/run-cost — Per-run cost aggregation.
 *
 * gateway-log tracks cost per LLM call.  This package aggregates across an
 * entire agent run (research loop, code loop, multi-step pipeline) and
 * produces a total tokens + USD summary with per-step breakdown.
 *
 * Architecture
 * ────────────
 *   RunCostTracker   — tracks steps within a run, computes totals.
 *   MODEL_PRICING    — per-1k-token price table (input + output, USD).
 *   estimateCost()   — pure function: tokens × price → USD.
 *   IRunCostStore    — injectable store for persistent run data.
 *   InMemoryRunCostStore — default in-process implementation.
 *
 * Usage
 * ─────
 * ```ts
 * const tracker = new RunCostTracker();
 * const runId = tracker.startRun("research-loop");
 *
 * // After each LLM call:
 * tracker.recordStep(runId, {
 *   step: "summarise",
 *   model: "gpt-4o",
 *   inputTokens: 1200,
 *   outputTokens: 400,
 * });
 *
 * const summary = tracker.endRun(runId);
 * console.log(summary.totalUsd, summary.totalTokens, summary.steps);
 * ```
 */

import { randomUUID } from "node:crypto";

// ── Injectable now ────────────────────────────────────────────────────────────

export type NowFn = () => number;

// ── Pricing table (USD per 1k tokens) ────────────────────────────────────────

export interface ModelPrice {
  inputPer1k: number;
  outputPer1k: number;
}

/**
 * Per-1k-token pricing in USD.
 * Prices are approximate — update as providers change.
 */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  // OpenAI
  "gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01 },
  "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  "gpt-5": { inputPer1k: 0.015, outputPer1k: 0.06 },
  "gpt-5.2": { inputPer1k: 0.012, outputPer1k: 0.048 },
  "gpt-5.3-chat": { inputPer1k: 0.01, outputPer1k: 0.04 },
  "gpt-5.4": { inputPer1k: 0.02, outputPer1k: 0.08 },
  // Anthropic
  "claude-3.5-sonnet": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "claude-sonnet-4": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "claude-sonnet-4.6": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "claude-opus-4": { inputPer1k: 0.015, outputPer1k: 0.075 },
  "claude-opus-4.6": { inputPer1k: 0.015, outputPer1k: 0.075 },
  // Google
  "gemini-2.5-flash": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  "gemini-2.5-pro": { inputPer1k: 0.00125, outputPer1k: 0.005 },
  "gemini-3-pro-preview": { inputPer1k: 0.0035, outputPer1k: 0.014 },
  // xAI
  "grok-4": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "grok-4-fast": { inputPer1k: 0.001, outputPer1k: 0.005 },
  // Groq
  "llama-3.1-8b-instant": { inputPer1k: 0.00005, outputPer1k: 0.0001 },
  "llama-3.1-70b-versatile": { inputPer1k: 0.00059, outputPer1k: 0.00079 },
  "llama-3.3-70b-versatile": { inputPer1k: 0.00059, outputPer1k: 0.00079 },
  // DeepSeek
  "deepseek-chat": { inputPer1k: 0.00014, outputPer1k: 0.00028 },
  "deepseek-v3.2": { inputPer1k: 0.00014, outputPer1k: 0.00028 },
  "deepseek-r1": { inputPer1k: 0.00055, outputPer1k: 0.00219 },
};

const DEFAULT_PRICE: ModelPrice = { inputPer1k: 0.001, outputPer1k: 0.002 };

/**
 * Estimate cost in USD for a single LLM call.
 * Falls back to DEFAULT_PRICE if model is unknown.
 */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = MODEL_PRICING[model] ?? MODEL_PRICING[model.split("/").pop() ?? ""] ?? DEFAULT_PRICE;
  return (inputTokens / 1000) * price.inputPer1k + (outputTokens / 1000) * price.outputPer1k;
}

// ── Step record ───────────────────────────────────────────────────────────────

export interface RunStep {
  step: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  startedAt: number;
  durationMs?: number;
}

export interface RunStepInput {
  step: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs?: number;
}

// ── Run record ────────────────────────────────────────────────────────────────

export interface RunRecord {
  runId: string;
  label: string;
  startedAt: number;
  endedAt?: number;
  steps: RunStep[];
}

export interface RunSummary {
  runId: string;
  label: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalUsd: number;
  steps: RunStep[];
  /** Breakdown of cost by model. */
  costByModel: Record<string, number>;
  /** Breakdown of tokens by step name. */
  tokensByStep: Record<string, number>;
}

// ── IRunCostStore ─────────────────────────────────────────────────────────────

export interface IRunCostStore {
  save(run: RunRecord): Promise<void>;
  get(runId: string): Promise<RunRecord | undefined>;
  list(): Promise<RunRecord[]>;
  delete(runId: string): Promise<void>;
}

export class InMemoryRunCostStore implements IRunCostStore {
  private readonly runs = new Map<string, RunRecord>();

  async save(run: RunRecord): Promise<void> {
    this.runs.set(run.runId, run);
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    return this.runs.get(runId);
  }

  async list(): Promise<RunRecord[]> {
    return Array.from(this.runs.values());
  }

  async delete(runId: string): Promise<void> {
    this.runs.delete(runId);
  }
}

// ── RunCostTracker ────────────────────────────────────────────────────────────

export class RunCostTracker {
  private readonly store: IRunCostStore;
  private readonly now: NowFn;
  private readonly activeRuns = new Map<string, RunRecord>();

  constructor(opts: { store?: IRunCostStore; now?: NowFn } = {}) {
    this.store = opts.store ?? new InMemoryRunCostStore();
    this.now = opts.now ?? Date.now;
  }

  /**
   * Start a new run. Returns the runId to pass to recordStep / endRun.
   */
  startRun(label: string): string {
    const runId = randomUUID();
    const run: RunRecord = { runId, label, startedAt: this.now(), steps: [] };
    this.activeRuns.set(runId, run);
    return runId;
  }

  /**
   * Record a single LLM call step within an active run.
   * Throws if runId is unknown.
   */
  recordStep(runId: string, input: RunStepInput): RunStep {
    const run = this.activeRuns.get(runId);
    if (run === undefined) {
      throw new Error(`Unknown runId: ${runId}`);
    }

    const totalTokens = input.inputTokens + input.outputTokens;
    const costUsd = estimateCost(input.model, input.inputTokens, input.outputTokens);

    const step: RunStep = {
      step: input.step,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens,
      costUsd,
      startedAt: this.now(),
      durationMs: input.durationMs,
    };

    run.steps.push(step);
    return step;
  }

  /**
   * End a run and compute the full summary.
   * Persists to the store asynchronously (fire-and-forget — non-fatal).
   */
  endRun(runId: string): RunSummary {
    const run = this.activeRuns.get(runId);
    if (run === undefined) {
      throw new Error(`Unknown runId: ${runId}`);
    }

    const endedAt = this.now();
    run.endedAt = endedAt;
    this.activeRuns.delete(runId);

    // Persist (fire-and-forget)
    this.store.save({ ...run }).catch(() => {/* non-fatal */});

    return buildSummary(run, endedAt);
  }

  /**
   * Get the running summary for an active run (without ending it).
   */
  peekRun(runId: string): RunSummary {
    const run = this.activeRuns.get(runId);
    if (run === undefined) {
      throw new Error(`Unknown runId: ${runId}`);
    }
    return buildSummary(run, this.now());
  }

  /** List all active run IDs. */
  activeRunIds(): string[] {
    return Array.from(this.activeRuns.keys());
  }
}

// ── Summary builder ───────────────────────────────────────────────────────────

function buildSummary(run: RunRecord, endedAt: number): RunSummary {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalUsd = 0;
  const costByModel: Record<string, number> = {};
  const tokensByStep: Record<string, number> = {};

  for (const step of run.steps) {
    totalInputTokens += step.inputTokens;
    totalOutputTokens += step.outputTokens;
    totalUsd += step.costUsd;
    costByModel[step.model] = (costByModel[step.model] ?? 0) + step.costUsd;
    tokensByStep[step.step] = (tokensByStep[step.step] ?? 0) + step.totalTokens;
  }

  return {
    runId: run.runId,
    label: run.label,
    startedAt: run.startedAt,
    endedAt,
    durationMs: endedAt - run.startedAt,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalUsd: Math.round(totalUsd * 1_000_000) / 1_000_000,
    steps: run.steps,
    costByModel,
    tokensByStep,
  };
}
