// SPDX-License-Identifier: Apache-2.0
/**
 * LLM-based evaluators and benchmark infrastructure.
 *
 * Patterns extracted from:
 *   ml-intern (huggingface/ml-intern)  — autonomous ML researcher using smolagents;
 *     key pattern: generate eval cases from natural-language task specs,
 *     auto-generate test inputs, self-score with a judge model.
 *   spec-kit (github/spec-kit)         — spec-driven development; key pattern:
 *     executable scenario specs that generate test cases automatically.
 *
 * Provides:
 *   • llmJudgeScorer     — use a secondary LLM to rate output quality (0-1)
 *   • semanticSimilarity — keyword-overlap approximation (no embedding required)
 *   • notContains        — inverse containsString
 *   • wordCount          — min/max word count bounds
 *   • ScenarioSpec       — executable scenario: goal + acceptance criteria
 *   • ScenarioRunner     — runs scenario specs against a subject LLM
 *   • BenchmarkTracker   — persist pass/fail history and detect regressions
 *   • MLResearchEval     — ml-intern-style autonomous eval case generation
 */

import type { EvalScore } from "./types.js";

// ── LLM judge scorer ──────────────────────────────────────────────────────────

export type JudgeLlmFn = (prompt: string) => Promise<string>;

/**
 * Use a secondary LLM to judge output quality.
 * Returns 1.0 if the judge rates it good, 0.0 if bad, partial scores in between.
 * Falls back to keyword heuristic if LLM call fails.
 */
export function llmJudgeScorer(
  criteria: string,
  judgeLlm: JudgeLlmFn,
  opts: { threshold?: number } = {},
): (output: unknown) => Promise<EvalScore> {
  return async (output) => {
    const text = typeof output === "string" ? output : JSON.stringify(output);
    const threshold = opts.threshold ?? 0.7;

    try {
      const judgment = await judgeLlm(
        `You are an evaluator. Rate the following output for this criterion: "${criteria}"\n\n` +
        `Output:\n${text.slice(0, 2000)}\n\n` +
        `Respond with a score from 0 to 10 (10 = perfect) on the FIRST line, then explain.`,
      );

      const match = judgment.match(/^(\d+(?:\.\d+)?)/);
      const raw = match ? parseFloat(match[1]!) : null;
      if (raw !== null) {
        const score = Math.min(1, Math.max(0, raw / 10));
        return { pass: score >= threshold, score, reason: judgment.split("\n").slice(1).join(" ").slice(0, 200) };
      }

      // Keyword fallback
      const lower = judgment.toLowerCase();
      const positive = ["excellent", "good", "correct", "accurate", "meets", "satisfies", "pass"].some((w) => lower.includes(w));
      const negative = ["poor", "incorrect", "fails", "wrong", "missing", "incomplete"].some((w) => lower.includes(w));
      const score = positive && !negative ? 0.85 : negative ? 0.2 : 0.5;
      return { pass: score >= threshold, score };
    } catch {
      return { pass: false, score: 0, reason: "LLM judge call failed" };
    }
  };
}

// ── semanticSimilarity — keyword-overlap approximation ────────────────────────

/**
 * Measures lexical overlap between output and a reference string.
 * Not a semantic embedding — uses token Jaccard similarity as a fast proxy.
 * For real semantic similarity, wire in an embedding model.
 */
export function semanticSimilarity(
  reference: string,
  opts: { minScore?: number } = {},
): (output: unknown) => EvalScore {
  const refTokens = new Set(tokenize(reference));
  const minScore = opts.minScore ?? 0.3;

  return (output) => {
    const text = typeof output === "string" ? output : JSON.stringify(output);
    const outTokens = new Set(tokenize(text));
    const intersection = [...refTokens].filter((t) => outTokens.has(t)).length;
    const union = new Set([...refTokens, ...outTokens]).size;
    const score = union > 0 ? intersection / union : 0;
    return { pass: score >= minScore, score: Math.round(score * 1000) / 1000, reason: score < minScore ? `Jaccard similarity ${score.toFixed(2)} < threshold ${minScore}` : undefined };
  };
}

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((t) => t.length > 2);
}

// ── notContains ───────────────────────────────────────────────────────────────

export function notContains(needle: string, opts: { ignoreCase?: boolean } = {}): (output: unknown) => EvalScore {
  return (output) => {
    const haystack = JSON.stringify(output) ?? "";
    const h = opts.ignoreCase ? haystack.toLowerCase() : haystack;
    const n = opts.ignoreCase ? needle.toLowerCase() : needle;
    const pass = !h.includes(n);
    return { pass, score: pass ? 1 : 0, reason: pass ? undefined : `Output must not contain "${needle}"` };
  };
}

// ── wordCount ─────────────────────────────────────────────────────────────────

export function wordCount(min: number, max: number): (output: unknown) => EvalScore {
  return (output) => {
    const text = typeof output === "string" ? output : JSON.stringify(output);
    const words = text.trim().split(/\s+/).length;
    if (words < min) return { pass: false, score: words / min, reason: `Too short: ${words} words (min ${min})` };
    if (words > max) return { pass: false, score: max / words, reason: `Too long: ${words} words (max ${max})` };
    return { pass: true, score: 1 };
  };
}

// ── ScenarioSpec — spec-kit-inspired executable scenario definition ────────────

export interface AcceptanceCriterion {
  description: string;
  scorer: (output: unknown) => EvalScore | Promise<EvalScore>;
}

export interface ScenarioSpec {
  name: string;
  goal: string;
  inputs: Record<string, unknown>[];  // multiple test inputs per scenario
  criteria: AcceptanceCriterion[];
  passThreshold?: number;              // fraction of criteria that must pass (default: 1.0)
}

export interface ScenarioResult {
  scenarioName: string;
  input: Record<string, unknown>;
  criteriaResults: Array<{ criterion: string; pass: boolean; score: number; reason?: string }>;
  overallPass: boolean;
  overallScore: number;
}

export interface ScenarioRunResult {
  scenario: string;
  results: ScenarioResult[];
  passRate: number;
  timestamp: string;
}

export type ScenarioSubjectFn = (input: Record<string, unknown>) => Promise<unknown>;

/** Scenario runner */
export class ScenarioRunner {
  async run(spec: ScenarioSpec, subject: ScenarioSubjectFn): Promise<ScenarioRunResult> {
    const threshold = spec.passThreshold ?? 1.0;
    const results: ScenarioResult[] = [];

    for (const input of spec.inputs) {
      let output: unknown;
      try { output = await subject(input); }
      catch (e) { output = `Error: ${String(e)}`; }

      const criteriaResults = await Promise.all(
        spec.criteria.map(async (c) => {
          try {
            const score = await c.scorer(output);
            return { criterion: c.description, pass: score.pass, score: score.score, reason: score.reason };
          } catch (e) {
            return { criterion: c.description, pass: false, score: 0, reason: String(e) };
          }
        }),
      );

      const passedCount = criteriaResults.filter((r) => r.pass).length;
      const passRate = criteriaResults.length > 0 ? passedCount / criteriaResults.length : 1;
      const overallScore = criteriaResults.reduce((s, r) => s + r.score, 0) / Math.max(criteriaResults.length, 1);

      results.push({ input, criteriaResults, overallPass: passRate >= threshold, overallScore: Math.round(overallScore * 1000) / 1000, scenarioName: spec.name });
    }

    const passed = results.filter((r) => r.overallPass).length;
    return { scenario: spec.name, results, passRate: results.length > 0 ? passed / results.length : 1, timestamp: new Date().toISOString() };
  }
}

// ── BenchmarkTracker — regression detection across runs ───────────────────────

export interface BenchmarkRun {
  runId: string;
  suiteName: string;
  passRate: number;
  timestamp: string;
  results: Array<{ name: string; pass: boolean; score: number }>;
}

export interface RegressionAlert {
  suiteName: string;
  caseName: string;
  previousPass: boolean;
  currentPass: boolean;
  scoreDelta: number;
  severity: "regression" | "improvement";
}

/** Benchmark tracker */
export class BenchmarkTracker {
  private runs: BenchmarkRun[] = [];
  private maxHistory: number;

  constructor(maxHistory = 50) { this.maxHistory = maxHistory; }

  record(run: BenchmarkRun): void {
    this.runs.unshift(run);
    if (this.runs.length > this.maxHistory) this.runs.pop();
  }

  /** Compare latest run for a suite against the previous run. */
  detectRegressions(suiteName: string): RegressionAlert[] {
    const suiteRuns = this.runs.filter((r) => r.suiteName === suiteName);
    if (suiteRuns.length < 2) return [];

    const current = suiteRuns[0]!;
    const previous = suiteRuns[1]!;
    const alerts: RegressionAlert[] = [];

    for (const curr of current.results) {
      const prev = previous.results.find((r) => r.name === curr.name);
      if (!prev) continue;
      const scoreDelta = curr.score - prev.score;
      if (prev.pass && !curr.pass) {
        alerts.push({ suiteName, caseName: curr.name, previousPass: true, currentPass: false, scoreDelta, severity: "regression" });
      } else if (!prev.pass && curr.pass) {
        alerts.push({ suiteName, caseName: curr.name, previousPass: false, currentPass: true, scoreDelta, severity: "improvement" });
      }
    }
    return alerts;
  }

  history(suiteName?: string): BenchmarkRun[] {
    return suiteName ? this.runs.filter((r) => r.suiteName === suiteName) : [...this.runs];
  }

  latestPassRate(suiteName: string): number | null {
    const run = this.runs.find((r) => r.suiteName === suiteName);
    return run?.passRate ?? null;
  }
}

// ── MLResearchEval — ml-intern-style autonomous eval case generation ───────────
//
// ml-intern pattern: given a task spec, autonomously generate test inputs
// and expected outputs using a planning LLM, then run them.

export interface MLEvalSpec {
  task: string;          // "Summarise financial reports in < 100 words"
  domain: string;        // "financial", "medical", "legal", etc.
  nCases?: number;       // number of test cases to generate (default: 5)
}

export interface GeneratedEvalCase {
  input: string;
  expectedPattern: string;   // describes what a good output looks like
  scorerDescription: string; // human-readable scoring criterion
}

export type EvalGeneratorFn = (spec: MLEvalSpec) => Promise<GeneratedEvalCase[]>;

/** Ml research eval */
export class MLResearchEval {
  private generatorFn: EvalGeneratorFn;

  constructor(generatorFn: EvalGeneratorFn) {
    this.generatorFn = generatorFn;
  }

  /**
   * Generate eval cases from a spec, then run them against a subject function.
   * Returns a ScenarioRunResult compatible format.
   */
  async evaluate(spec: MLEvalSpec, subject: ScenarioSubjectFn, judgeLlm?: JudgeLlmFn): Promise<ScenarioRunResult> {
    const cases = await this.generatorFn(spec);
    const runner = new ScenarioRunner();

    const scenario: ScenarioSpec = {
      name: spec.task,
      goal: spec.task,
      inputs: cases.map((c) => ({ input: c.input })),
      criteria: cases.map((c, i) => ({
        description: c.scorerDescription,
        scorer: judgeLlm
          ? llmJudgeScorer(c.scorerDescription, judgeLlm)
          : semanticSimilarity(c.expectedPattern, { minScore: 0.2 }),
        _caseIndex: i,
      })),
    };

    return runner.run(scenario, subject);
  }
}
