// SPDX-License-Identifier: Apache-2.0
import type { IExecutionContext, IExecutionAdapter } from "@nexus/plugin-sdk";

// ── Scoring ───────────────────────────────────────────────────────────────────

export interface EvalScore {
  /** Whether the eval case passed (score >= threshold, default 1.0) */
  pass: boolean;
  /** Numeric score in [0, 1] */
  score: number;
  /** Human-readable explanation for failures */
  reason?: string;
}

// ── Eval case ─────────────────────────────────────────────────────────────────

export interface TaskEvalCase<TOutput = unknown> {
  /** Unique name for this eval case — used in reports and regression diffs */
  name: string;
  /** The task payload to execute */
  task: Record<string, unknown>;
  /** Partial context override (adapter tests typically only need `environment`) */
  context?: Partial<Pick<IExecutionContext, "environment">>;
  /** Minimum score to pass (default: 1.0) */
  passThreshold?: number;
  /**
   * Scorer receives the adapter output and returns a score.
   * Throw or return pass:false to mark as failed.
   */
  scorer: (output: TOutput) => EvalScore;
}

// ── Eval result ───────────────────────────────────────────────────────────────

export interface EvalResult {
  name: string;
  pass: boolean;
  score: number;
  durationMs: number;
  reason?: string;
  /** Populated when the adapter threw an error */
  error?: string;
}

// ── Suite result ──────────────────────────────────────────────────────────────

export interface EvalSuiteResult {
  suiteName: string;
  total: number;
  passed: number;
  failed: number;
  /** Aggregate pass rate 0-1 */
  passRate: number;
  results: EvalResult[];
}

// ── Adapter under evaluation ──────────────────────────────────────────────────

export type EvalAdapter = Pick<IExecutionAdapter, "execute" | "name">;
