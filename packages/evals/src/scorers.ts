// SPDX-License-Identifier: Apache-2.0
/**
 * Built-in scorers for common evaluation patterns.
 *
 * Each scorer is a factory that returns an (output) => EvalScore function,
 * suitable for the `scorer` field of a TaskEvalCase.
 */

import type { EvalScore } from "./types.js";

// ── exactMatch ────────────────────────────────────────────────────────────────

/**
 * Passes when the output deeply equals the expected value.
 * Uses JSON round-trip for comparison so undefined fields are ignored.
 */
export function exactMatch(expected: unknown): (output: unknown) => EvalScore {
  return (output) => {
    const a = JSON.stringify(output);
    const b = JSON.stringify(expected);
    const pass = a === b;
    return {
      pass,
      score: pass ? 1 : 0,
      reason: pass ? undefined : `Expected ${b.slice(0, 200)} but got ${a.slice(0, 200)}`,
    };
  };
}

// ── fieldsPresent ─────────────────────────────────────────────────────────────

/**
 * Passes when all listed keys are present and non-null in the output object.
 * Score is the fraction of required keys present (0-1).
 */
export function fieldsPresent(...keys: string[]): (output: unknown) => EvalScore {
  return (output) => {
    if (typeof output !== "object" || output === null) {
      return { pass: false, score: 0, reason: "Output is not an object" };
    }
    const obj = output as Record<string, unknown>;
    const present = keys.filter((k) => obj[k] != null);
    const score = keys.length === 0 ? 1 : present.length / keys.length;
    const missing = keys.filter((k) => obj[k] == null);
    return {
      pass: missing.length === 0,
      score,
      reason: missing.length > 0 ? `Missing required fields: ${missing.join(", ")}` : undefined,
    };
  };
}

// ── containsString ────────────────────────────────────────────────────────────

/**
 * Passes when JSON.stringify(output) contains the given substring.
 * Case-sensitive by default; pass { ignoreCase: true } to override.
 */
export function containsString(
  needle: string,
  options: { ignoreCase?: boolean } = {},
): (output: unknown) => EvalScore {
  return (output) => {
    const haystack = JSON.stringify(output) ?? "";
    const h = options.ignoreCase ? haystack.toLowerCase() : haystack;
    const n = options.ignoreCase ? needle.toLowerCase() : needle;
    const pass = h.includes(n);
    return {
      pass,
      score: pass ? 1 : 0,
      reason: pass ? undefined : `Output does not contain "${needle}"`,
    };
  };
}

// ── matchesSchema ─────────────────────────────────────────────────────────────

/**
 * Lightweight structural schema check.
 * schema is a record of { key: "string" | "number" | "boolean" | "array" | "object" | "any" }
 * Passes when all declared keys satisfy their type constraint.
 */
export type SchemaFieldType = "string" | "number" | "boolean" | "array" | "object" | "any";
export type FieldSchema = Record<string, SchemaFieldType>;

export function matchesSchema(schema: FieldSchema): (output: unknown) => EvalScore {
  return (output) => {
    if (typeof output !== "object" || output === null) {
      return { pass: false, score: 0, reason: "Output is not an object" };
    }
    const obj = output as Record<string, unknown>;
    const failures: string[] = [];
    const keys = Object.keys(schema);

    for (const key of keys) {
      const expected = schema[key];
      const actual = obj[key];
      if (expected === "any") continue;
      if (actual === undefined || actual === null) {
        failures.push(`${key}: missing`);
        continue;
      }
      if (expected === "array" && !Array.isArray(actual)) {
        failures.push(`${key}: expected array, got ${typeof actual}`);
      } else if (expected !== "array" && typeof actual !== expected) {
        failures.push(`${key}: expected ${expected}, got ${typeof actual}`);
      }
    }

    const score = keys.length === 0 ? 1 : (keys.length - failures.length) / keys.length;
    return {
      pass: failures.length === 0,
      score,
      reason: failures.length > 0 ? `Schema violations: ${failures.join("; ")}` : undefined,
    };
  };
}

// ── allOf ─────────────────────────────────────────────────────────────────────

/**
 * Composes multiple scorers: passes only when ALL scorers pass.
 * Final score is the minimum of all individual scores.
 */
export function allOf(
  ...scorers: ((output: unknown) => EvalScore)[]
): (output: unknown) => EvalScore {
  return (output) => {
    const results = scorers.map((s) => s(output));
    const pass = results.every((r) => r.pass);
    const score = results.reduce((min, r) => Math.min(min, r.score), 1);
    const reasons = results.filter((r) => !r.pass && r.reason).map((r) => r.reason!);
    return { pass, score, reason: reasons.length > 0 ? reasons.join("; ") : undefined };
  };
}
