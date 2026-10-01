// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  ScenarioBuilder,
  ScenarioPlan,
  predictOutcome,
  sensitivityAnalysis,
  type Scenario,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeScenario(): Scenario {
  return new ScenarioBuilder("Product Launch", "Launch our new SaaS product")
    .variable("marketing_budget", 50000, "USD")
    .variable("target_users", 10000)
    .assume("Market is ready", 0.8)
    .assume("Competition is low", 0.6)
    .outcome("Success", 0.5, 8, "Product reaches target users")
    .outcome("Moderate", 0.35, 3, "Partial adoption")
    .outcome("Failure", 0.15, -5, "Market rejection")
    .tag("saas", "q3")
    .build();
}

// ── ScenarioBuilder ───────────────────────────────────────────────────────────

describe("ScenarioBuilder", () => {
  it("builds a scenario with all fields", () => {
    const s = makeScenario();
    expect(s.name).toBe("Product Launch");
    expect(s.variables).toHaveLength(2);
    expect(s.assumptions).toHaveLength(2);
    expect(s.outcomes).toHaveLength(3);
    expect(s.tags).toContain("saas");
    expect(s.id).toBeTruthy();
    expect(s.createdAt).toBeTruthy();
  });

  it("supports method chaining", () => {
    const b = new ScenarioBuilder("Test");
    expect(b.variable("x", 1)).toBe(b);
    expect(b.assume("y", 0.5)).toBe(b);
    expect(b.outcome("z", 0.5, 1)).toBe(b);
    expect(b.tag("t")).toBe(b);
  });

  it("generates unique ids", () => {
    const a = new ScenarioBuilder("A").build();
    const b = new ScenarioBuilder("B").build();
    expect(a.id).not.toBe(b.id);
  });

  it("clamps assumption confidence to [0,1]", () => {
    const s = new ScenarioBuilder("X").assume("over", 1.5).assume("under", -0.2).build();
    expect(s.assumptions[0]!.confidence).toBe(1);
    expect(s.assumptions[1]!.confidence).toBe(0);
  });
});

// ── predictOutcome ────────────────────────────────────────────────────────────

describe("predictOutcome", () => {
  it("computes expected impact correctly", () => {
    const s = makeScenario();
    const r = predictOutcome(s);
    // 0.5*8 + 0.35*3 + 0.15*(-5) = 4 + 1.05 - 0.75 = 4.3
    expect(r.expectedImpact).toBeCloseTo(4.3, 5);
  });

  it("identifies highest-probability outcome", () => {
    const r = predictOutcome(makeScenario());
    expect(r.highestProbabilityOutcome.name).toBe("Success");
  });

  it("identifies worst-case outcome (lowest impact)", () => {
    const r = predictOutcome(makeScenario());
    expect(r.worstCaseOutcome.name).toBe("Failure");
  });

  it("identifies best-case outcome (highest impact)", () => {
    const r = predictOutcome(makeScenario());
    expect(r.bestCaseOutcome.name).toBe("Success");
  });

  it("computes confidenceScore as average of assumptions", () => {
    const r = predictOutcome(makeScenario());
    // (0.8 + 0.6) / 2 = 0.7
    expect(r.confidenceScore).toBeCloseTo(0.7, 5);
  });

  it("confidenceScore is 1 when no assumptions", () => {
    const s = new ScenarioBuilder("No assumptions").outcome("A", 1, 5).build();
    expect(predictOutcome(s).confidenceScore).toBe(1);
  });

  it("throws when scenario has no outcomes", () => {
    const s = new ScenarioBuilder("Empty").build();
    expect(() => predictOutcome(s)).toThrow();
  });
});

// ── sensitivityAnalysis ───────────────────────────────────────────────────────

describe("sensitivityAnalysis", () => {
  it("returns correct number of steps", () => {
    const s = makeScenario();
    const pts = sensitivityAnalysis(s, "marketing_budget", { steps: 5 });
    expect(pts).toHaveLength(5);
  });

  it("covers the specified range", () => {
    const s = makeScenario();
    const pts = sensitivityAnalysis(s, "marketing_budget", { steps: 3, range: [0, 100000] });
    expect(pts[0]!.variableValue).toBeCloseTo(0);
    expect(pts[2]!.variableValue).toBeCloseTo(100000);
  });

  it("expected impact increases with positive variable scale", () => {
    const s = makeScenario();
    const pts = sensitivityAnalysis(s, "marketing_budget", { steps: 3 });
    // With positive base expected impact, doubling budget should increase impact
    expect(pts[2]!.expectedImpact).toBeGreaterThan(pts[0]!.expectedImpact);
  });

  it("throws for unknown variable", () => {
    const s = makeScenario();
    expect(() => sensitivityAnalysis(s, "nonexistent")).toThrow();
  });

  it("returns 5 points by default", () => {
    const s = makeScenario();
    expect(sensitivityAnalysis(s, "marketing_budget")).toHaveLength(5);
  });
});

// ── ScenarioPlan ──────────────────────────────────────────────────────────────

describe("ScenarioPlan", () => {
  it("adds and lists scenarios", () => {
    const plan = new ScenarioPlan();
    plan.add(makeScenario());
    plan.add(makeScenario());
    expect(plan.list()).toHaveLength(2);
  });

  it("gets scenario by id", () => {
    const plan = new ScenarioPlan();
    const s = makeScenario();
    plan.add(s);
    expect(plan.get(s.id)).toBe(s);
  });

  it("returns undefined for unknown id", () => {
    const plan = new ScenarioPlan();
    expect(plan.get("ghost")).toBeUndefined();
  });

  it("filterByTag returns matching scenarios", () => {
    const plan = new ScenarioPlan();
    plan.add(makeScenario()); // has 'saas' tag
    const noTag = new ScenarioBuilder("Other").outcome("X", 1, 1).build();
    plan.add(noTag);
    expect(plan.filterByTag("saas")).toHaveLength(1);
  });

  it("rank sorts by expected impact descending", () => {
    const plan = new ScenarioPlan();
    const good = new ScenarioBuilder("Good").outcome("Win", 1, 10).build();
    const bad = new ScenarioBuilder("Bad").outcome("Lose", 1, -5).build();
    plan.add(bad).add(good);
    const ranked = plan.rank();
    expect(ranked[0]!.scenario.name).toBe("Good");
  });

  it("supports method chaining", () => {
    const plan = new ScenarioPlan();
    expect(plan.add(makeScenario())).toBe(plan);
  });
});
