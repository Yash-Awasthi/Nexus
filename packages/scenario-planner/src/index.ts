// SPDX-License-Identifier: Apache-2.0
/**
 * scenario-planner — Structured scenario modelling and prediction engine.
 *
 * Provides:
 *   • Scenario          — a named situation with variables, assumptions, outcomes
 *   • ScenarioBuilder   — fluent builder for composing scenarios
 *   • ScenarioPlan      — a collection of scenarios with comparison utilities
 *   • predictOutcome()  — weighted-probability outcome aggregation
 *   • sensitivityAnalysis() — vary a variable and observe outcome shifts
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Variable {
  name: string;
  value: number;
  unit?: string;
}

export interface Assumption {
  description: string;
  confidence: number; // [0, 1]
}

export interface Outcome {
  name: string;
  probability: number; // [0, 1] — must sum to 1 across the scenario
  impact: number;      // arbitrary scale, e.g. -10 to +10
  description?: string;
}

export interface Scenario {
  id: string;
  name: string;
  description?: string;
  variables: Variable[];
  assumptions: Assumption[];
  outcomes: Outcome[];
  tags?: string[];
  createdAt: string;
}

export interface PredictionResult {
  expectedImpact: number;
  highestProbabilityOutcome: Outcome;
  worstCaseOutcome: Outcome;
  bestCaseOutcome: Outcome;
  confidenceScore: number; // average assumption confidence
}

export interface SensitivityPoint {
  variableValue: number;
  expectedImpact: number;
}

// ── ScenarioBuilder ───────────────────────────────────────────────────────────

let _idCounter = 0;

export class ScenarioBuilder {
  private scenario: Partial<Scenario> & { variables: Variable[]; assumptions: Assumption[]; outcomes: Outcome[] };

  constructor(name: string, description?: string) {
    this.scenario = {
      id: `scenario-${++_idCounter}`,
      name,
      description,
      variables: [],
      assumptions: [],
      outcomes: [],
      tags: [],
      createdAt: new Date().toISOString(),
    };
  }

  variable(name: string, value: number, unit?: string): this {
    this.scenario.variables.push({ name, value, unit });
    return this;
  }

  assume(description: string, confidence: number): this {
    this.scenario.assumptions.push({ description, confidence: Math.min(1, Math.max(0, confidence)) });
    return this;
  }

  outcome(name: string, probability: number, impact: number, description?: string): this {
    this.scenario.outcomes.push({ name, probability, impact, description });
    return this;
  }

  tag(...tags: string[]): this {
    this.scenario.tags = [...(this.scenario.tags ?? []), ...tags];
    return this;
  }

  build(): Scenario {
    return { ...(this.scenario as Scenario) };
  }
}

// ── Prediction ────────────────────────────────────────────────────────────────

export function predictOutcome(scenario: Scenario): PredictionResult {
  const { outcomes, assumptions } = scenario;
  if (outcomes.length === 0) {
    throw new Error("Scenario has no outcomes");
  }

  const expectedImpact = outcomes.reduce(
    (sum, o) => sum + o.probability * o.impact,
    0,
  );

  const highestProbabilityOutcome = [...outcomes].sort(
    (a, b) => b.probability - a.probability,
  )[0]!;

  const worstCaseOutcome = [...outcomes].sort(
    (a, b) => a.impact - b.impact,
  )[0]!;

  const bestCaseOutcome = [...outcomes].sort(
    (a, b) => b.impact - a.impact,
  )[0]!;

  const confidenceScore =
    assumptions.length === 0
      ? 1
      : assumptions.reduce((sum, a) => sum + a.confidence, 0) / assumptions.length;

  return {
    expectedImpact,
    highestProbabilityOutcome,
    worstCaseOutcome,
    bestCaseOutcome,
    confidenceScore,
  };
}

// ── Sensitivity analysis ──────────────────────────────────────────────────────

export interface SensitivityOptions {
  steps?: number;       // default: 5
  range?: [number, number]; // [min, max]; default: [0, 2x current value]
}

/**
 * Vary `variableName` across a range and compute expected impact at each step.
 * The impact scaling is linear: outcomes' impacts are multiplied by the ratio
 * of the new value to the original value.
 */
export function sensitivityAnalysis(
  scenario: Scenario,
  variableName: string,
  opts: SensitivityOptions = {},
): SensitivityPoint[] {
  const variable = scenario.variables.find((v) => v.name === variableName);
  if (!variable) throw new Error(`Variable not found: ${variableName}`);

  const { steps = 5 } = opts;
  const baseValue = variable.value;
  const [min, max] = opts.range ?? [0, baseValue * 2];

  const points: SensitivityPoint[] = [];
  const step = (max - min) / (steps - 1);

  for (let i = 0; i < steps; i++) {
    const newValue = min + i * step;
    const ratio = baseValue === 0 ? 1 : newValue / baseValue;
    const scaledOutcomes = scenario.outcomes.map((o) => ({
      ...o,
      impact: o.impact * ratio,
    }));
    const expectedImpact = scaledOutcomes.reduce(
      (sum, o) => sum + o.probability * o.impact,
      0,
    );
    points.push({ variableValue: newValue, expectedImpact });
  }
  return points;
}

// ── ScenarioPlan ──────────────────────────────────────────────────────────────

export class ScenarioPlan {
  private scenarios: Scenario[] = [];

  add(scenario: Scenario): this {
    this.scenarios.push(scenario);
    return this;
  }

  get(id: string): Scenario | undefined {
    return this.scenarios.find((s) => s.id === id);
  }

  list(): Scenario[] { return [...this.scenarios]; }

  filterByTag(tag: string): Scenario[] {
    return this.scenarios.filter((s) => s.tags?.includes(tag));
  }

  /** Compare all scenarios by expected impact; return sorted descending. */
  rank(): Array<{ scenario: Scenario; prediction: PredictionResult }> {
    return this.scenarios
      .map((s) => ({ scenario: s, prediction: predictOutcome(s) }))
      .sort((a, b) => b.prediction.expectedImpact - a.prediction.expectedImpact);
  }
}
