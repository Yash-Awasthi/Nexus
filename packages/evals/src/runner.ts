// SPDX-License-Identifier: Apache-2.0
/**
 * EvalRunner — executes a suite of TaskEvalCases against an adapter.
 *
 * Usage:
 *   const runner = new EvalRunner(adapter);
 *   const result = await runner.run("my suite", cases);
 *   console.log(result.passRate);
 */

import { randomUUID } from "node:crypto";

import type { TaskEvalCase, EvalResult, EvalSuiteResult, EvalAdapter } from "./types.js";

// Minimal execution context used for eval runs
function makeContext(env: Record<string, string> = {}) {
  return {
    taskId: randomUUID(),
    startTime: new Date(),
    attempt: 1,
    environment: env as Readonly<Record<string, string>>,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
  };
}

export class EvalRunner {
  constructor(private readonly adapter: EvalAdapter) {}

  async run(suiteName: string, cases: TaskEvalCase[]): Promise<EvalSuiteResult> {
    const results: EvalResult[] = [];

    for (const evalCase of cases) {
      const ctx = makeContext(evalCase.context?.environment ?? {});
      const threshold = evalCase.passThreshold ?? 1.0;
      const start = Date.now();

      try {
        const output = await this.adapter.execute(evalCase.task, ctx);
        const scored = evalCase.scorer(output);

        results.push({
          name: evalCase.name,
          pass: scored.pass && scored.score >= threshold,
          score: scored.score,
          durationMs: Date.now() - start,
          reason: scored.reason,
        });
      } catch (err) {
        results.push({
          name: evalCase.name,
          pass: false,
          score: 0,
          durationMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const passed = results.filter((r) => r.pass).length;
    const failed = results.length - passed;

    return {
      suiteName,
      total: results.length,
      passed,
      failed,
      passRate: results.length === 0 ? 1 : passed / results.length,
      results,
    };
  }
}

// ── Regression suite ──────────────────────────────────────────────────────────

/**
 * EvalSuite — a named collection of eval cases that can be registered and
 * run as a regression batch. Designed to drop into a vitest describe block.
 *
 * @example
 * ```ts
 * const suite = new EvalSuite("groq adapter");
 * suite.add({ name: "basic inference", task: ..., scorer: ... });
 *
 * // In vitest:
 * describe(suite.name, () => {
 *   it.each(suite.cases)("$name", async (evalCase) => {
 *     const runner = new EvalRunner(adapter);
 *     const result = await runner.run(suite.name, [evalCase]);
 *     expect(result.results[0]?.pass).toBe(true);
 *   });
 * });
 * ```
 */
export class EvalSuite {
  readonly cases: TaskEvalCase[] = [];

  constructor(readonly name: string) {}

  add(evalCase: TaskEvalCase): this {
    this.cases.push(evalCase);
    return this;
  }

  addAll(evalCases: TaskEvalCase[]): this {
    this.cases.push(...evalCases);
    return this;
  }
}
