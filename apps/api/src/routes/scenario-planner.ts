// SPDX-License-Identifier: Apache-2.0
/**
 * Scenario-planner routes — structured scenario modelling and prediction engine.
 *
 * POST /scenarios                  — create a scenario (variables, assumptions, outcomes)
 * GET  /scenarios                  — list all scenarios (optional tag filter)
 * GET  /scenarios/:id              — get a single scenario
 * DELETE /scenarios/:id            — delete a scenario
 * POST /scenarios/:id/predict      — compute predictOutcome (expected impact, worst/best case)
 * POST /scenarios/:id/sensitivity  — run sensitivityAnalysis on a named variable
 * GET  /scenarios/plan/rank        — rank all scenarios by expected impact
 *
 * Store: in-process ScenarioPlan singleton.
 */

import {
  ScenarioBuilder,
  ScenarioPlan,
  predictOutcome,
  sensitivityAnalysis,
  type Assumption,
  type Outcome,
  type SensitivityOptions,
  type Variable,
} from "@nexus/scenario-planner";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Singleton ─────────────────────────────────────────────────────────────────

// One plan per account: scenarios are their author's.
const plans = new Map<string, ScenarioPlan>();
function planFor(req: { nexusUserId?: string }): ScenarioPlan {
  const id = req.nexusUserId ?? "local";
  let p = plans.get(id);
  if (!p) plans.set(id, (p = new ScenarioPlan()));
  return p;
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function scenarioPlannerRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /scenarios/plan/rank
   *
   * Rank all scenarios by expected impact (highest first).
   * Must be registered BEFORE /scenarios/:id or Fastify matches "plan" as an id.
   */
  app.get(
    "/scenarios/plan/rank",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const ranked = planFor(request).rank();
      return reply.send({
        ranked: ranked.map(({ scenario, prediction }) => ({
          scenario,
          prediction,
        })),
        total: ranked.length,
      });
    },
  );

  /**
   * GET /scenarios?tag=<tag>
   *
   * List all scenarios. Optionally filter by tag.
   */
  app.get<{
    Querystring: { tag?: string };
  }>("/scenarios", { preHandler: requireAuth }, async (request, reply) => {
    const { tag } = request.query;
    const scenarios = tag ? planFor(request).filterByTag(tag) : planFor(request).list();
    return reply.send({ scenarios, total: scenarios.length });
  });

  /**
   * POST /scenarios
   *
   * Create a scenario.
   *
   * Body:
   *   name         — scenario name (required)
   *   description  — optional description
   *   variables    — [{ name, value, unit? }]
   *   assumptions  — [{ description, confidence }]  (confidence 0–1)
   *   outcomes     — [{ name, probability, impact, description? }]
   *   tags         — optional string[]
   *
   * Outcomes' probabilities should sum to 1 (not enforced; caller's responsibility).
   */
  app.post<{
    Body: {
      name: string;
      description?: string;
      variables?: Variable[];
      assumptions?: Assumption[];
      outcomes?: Outcome[];
      tags?: string[];
    };
  }>("/scenarios", { preHandler: requireAuth }, async (request, reply) => {
    const {
      name,
      description,
      variables = [],
      assumptions = [],
      outcomes = [],
      tags = [],
    } = request.body;

    if (!name) return reply.code(400).send({ error: "name is required" });
    if (outcomes.length === 0)
      return reply.code(400).send({ error: "at least one outcome is required" });

    const builder = new ScenarioBuilder(name, description);
    for (const v of variables) builder.variable(v.name, v.value, v.unit);
    for (const a of assumptions) builder.assume(a.description, a.confidence);
    for (const o of outcomes) builder.outcome(o.name, o.probability, o.impact, o.description);
    if (tags.length > 0) builder.tag(...tags);

    const scenario = builder.build();
    planFor(request).add(scenario);

    return reply.code(201).send(scenario);
  });

  /**
   * GET /scenarios/:id
   *
   * Get a single scenario by ID.
   */
  app.get<{ Params: { id: string } }>(
    "/scenarios/:id",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const scenario = planFor(request).get(request.params.id);
      if (!scenario) return reply.code(404).send({ error: "Scenario not found" });
      return reply.send(scenario);
    },
  );

  /**
   * DELETE /scenarios/:id
   *
   * Remove a scenario from the planFor(request).
   */
  app.delete<{ Params: { id: string } }>(
    "/scenarios/:id",
    {
      schema: {
        response: { 200: { type: "object", additionalProperties: true }, 204: { type: "null" } },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const current = planFor(request);
      if (!current.get(request.params.id))
        return reply.code(404).send({ error: "Scenario not found" });
      // ScenarioPlan has no remove, so the account's plan is rebuilt without it.
      const next = new ScenarioPlan();
      for (const s of current.list()) if (s.id !== request.params.id) next.add(s);
      plans.set(request.nexusUserId ?? "local", next);
      return reply.send({ deleted: true, id: request.params.id });
    },
  );

  /**
   * POST /scenarios/:id/predict
   *
   * Compute outcome prediction for a scenario.
   * Returns: { expectedImpact, highestProbabilityOutcome, worstCaseOutcome, bestCaseOutcome, confidenceScore }
   */
  app.post<{ Params: { id: string } }>(
    "/scenarios/:id/predict",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const scenario = planFor(request).get(request.params.id);
      if (!scenario) return reply.code(404).send({ error: "Scenario not found" });

      try {
        const prediction = predictOutcome(scenario);
        return reply.send({ scenario: { id: scenario.id, name: scenario.name }, prediction });
      } catch (err) {
        return reply.code(422).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  /**
   * POST /scenarios/:id/sensitivity
   *
   * Run sensitivity analysis by varying a named variable.
   *
   * Body:
   *   variable  — variable name (must exist in scenario.variables)
   *   steps     — number of steps (default: 5)
   *   range     — [min, max] value range (default: [0, 2x current value])
   */
  app.post<{
    Params: { id: string };
    Body: {
      variable: string;
      steps?: number;
      range?: [number, number];
    };
  }>("/scenarios/:id/sensitivity", { preHandler: requireAuth }, async (request, reply) => {
    const scenario = planFor(request).get(request.params.id);
    if (!scenario) return reply.code(404).send({ error: "Scenario not found" });

    const { variable, steps, range } = request.body;
    if (!variable) return reply.code(400).send({ error: "variable is required" });

    try {
      const opts: SensitivityOptions = {};
      if (steps) opts.steps = steps;
      if (range) opts.range = range;

      const points = sensitivityAnalysis(scenario, variable, opts);
      return reply.send({ variable, points });
    } catch (err) {
      return reply.code(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
