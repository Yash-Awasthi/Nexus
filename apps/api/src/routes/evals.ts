// SPDX-License-Identifier: Apache-2.0
/**
 * Evals routes — lightweight task-completion scoring via @nexus/evals.
 *
 * POST /evals/score      — score a single (task, output) pair with built-in scorers
 * POST /evals/run        — run a named eval case stub (placeholder for adapter runs)
 * GET  /evals/scorers    — list available built-in scorers
 *
 * This is an evaluation scaffold — production eval suites run via vitest / CI.
 * The HTTP layer enables ad-hoc scoring and integration with external orchestrators.
 */

import {
  allOf,
  containsString,
  exactMatch,
  fieldsPresent,
  matchesSchema,
  type EvalScore,
  type FieldSchema,
} from "@nexus/evals";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Built-in scorer registry ──────────────────────────────────────────────────

type ScorerName =
  | "exact_match"
  | "fields_present"
  | "contains_string"
  | "matches_schema"
  | "all_of";

const SCORERS: ScorerName[] = [
  "exact_match",
  "fields_present",
  "contains_string",
  "matches_schema",
  "all_of",
];

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function evalsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /evals/scorers
   *
   * List available built-in scorers and their required params.
   */
  app.get("/evals/scorers", { preHandler: requireAuth }, async (_request, reply) => {
    return reply.send({
      scorers: [
        {
          name: "exact_match",
          params: ["expected"],
          description: "Deep equality between output and expected",
        },
        {
          name: "fields_present",
          params: ["fields: string[]"],
          description: "Required keys present and non-null in output",
        },
        {
          name: "contains_string",
          params: ["substring"],
          description: "Substring found in JSON-serialized output",
        },
        {
          name: "matches_schema",
          params: ["schema: Record<string, FieldSchema>"],
          description: "Output fields match declared types",
        },
        {
          name: "all_of",
          params: ["scorers: ScorerSpec[]"],
          description: "Compose multiple scorers (all must pass)",
        },
      ],
    });
  });

  /**
   * POST /evals/score
   *
   * Score a single output with one or more scorers.
   *
   * Body:
   *   output    — the value to evaluate (any JSON)
   *   scorer    — scorer name (see GET /evals/scorers)
   *   params    — scorer-specific params:
   *     exact_match:     { expected: unknown }
   *     fields_present:  { fields: string[] }
   *     contains_string: { substring: string }
   *     matches_schema:  { schema: Record<string, { type, required? }> }
   *
   * Returns: { pass, score, reason? }
   */
  app.post<{
    Body: {
      output: unknown;
      scorer: ScorerName;
      params?: Record<string, unknown>;
    };
  }>("/evals/score", { preHandler: requireAuth }, async (request, reply) => {
    const { output, scorer, params = {} } = request.body;

    if (!scorer) return reply.code(400).send({ error: "scorer is required" });
    if (!(SCORERS as string[]).includes(scorer)) {
      return reply
        .code(400)
        .send({ error: `Unknown scorer: ${scorer}. Available: ${SCORERS.join(", ")}` });
    }

    let result: EvalScore;

    try {
      switch (scorer) {
        case "exact_match":
          result = exactMatch(params["expected"])(output);
          break;

        case "fields_present": {
          const fields = params["fields"] as string[] | undefined;
          if (!Array.isArray(fields))
            return reply.code(400).send({ error: "params.fields must be a string[]" });
          result = fieldsPresent(...fields)(output);
          break;
        }

        case "contains_string": {
          const sub = params["substring"] as string | undefined;
          if (!sub) return reply.code(400).send({ error: "params.substring is required" });
          result = containsString(sub)(output);
          break;
        }

        case "matches_schema": {
          const schema = params["schema"] as FieldSchema | undefined;
          if (!schema) return reply.code(400).send({ error: "params.schema is required" });
          result = matchesSchema(schema)(output);
          break;
        }

        case "all_of": {
          // all_of is a composition — accept a list of { scorer, params } objects
          const specs = params["scorers"] as
            | { scorer: ScorerName; params?: Record<string, unknown> }[]
            | undefined;
          if (!Array.isArray(specs))
            return reply.code(400).send({ error: "params.scorers must be an array" });

          const scorerFns = specs.map((s) => {
            switch (s.scorer) {
              case "exact_match":
                return exactMatch(s.params?.["expected"]);
              case "fields_present":
                return fieldsPresent(...((s.params?.["fields"] as string[]) ?? []));
              case "contains_string":
                return containsString((s.params?.["substring"] as string) ?? "");
              case "matches_schema":
                return matchesSchema((s.params?.["schema"] as FieldSchema) ?? {});
              default:
                return exactMatch(undefined);
            }
          });

          result = allOf(...scorerFns)(output);
          break;
        }

        default:
          result = { pass: false, score: 0, reason: "Unknown scorer" };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: message });
    }

    return reply.send(result);
  });

  /**
   * POST /evals/run
   *
   * Stub endpoint for running a named eval case.
   * Full eval suites run via vitest / CI; this endpoint enables external orchestration.
   *
   * Body:
   *   name      — eval case name
   *   task      — task payload (arbitrary JSON)
   *   expected  — expected output for basic exact_match check
   */
  app.post<{
    Body: { name: string; task: Record<string, unknown>; expected?: unknown };
  }>("/evals/run", { preHandler: requireAuth }, async (request, reply) => {
    const { name, task, expected } = request.body;

    if (!name || !task) return reply.code(400).send({ error: "name and task are required" });

    // Stub: return a placeholder result — real runs happen in CI via EvalRunner
    return reply.code(201).send({
      name,
      status: "stub",
      message: "Eval cases run via vitest/CI; this endpoint records the request only",
      task,
      expected: expected ?? null,
      durationMs: 0,
    });
  });
}
