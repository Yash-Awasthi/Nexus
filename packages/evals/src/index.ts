// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/evals — lightweight task-completion scoring and adapter regression suite.
 *
 * Core API
 * --------
 *   EvalRunner   — runs TaskEvalCase[] against any IExecutionAdapter
 *   EvalSuite    — named collection of cases for vitest regression runs
 *
 * Built-in scorers
 * ----------------
 *   exactMatch       — deep equality
 *   fieldsPresent    — required keys present and non-null
 *   containsString   — substring in JSON-serialized output
 *   matchesSchema    — structural type checking
 *   allOf            — compose multiple scorers (min score, all must pass)
 */

export { EvalRunner, EvalSuite } from "./runner.js";
export { exactMatch, fieldsPresent, containsString, matchesSchema, allOf } from "./scorers.js";
export type { SchemaFieldType, FieldSchema } from "./scorers.js";
export type { EvalScore, EvalResult, EvalSuiteResult, TaskEvalCase, EvalAdapter } from "./types.js";
