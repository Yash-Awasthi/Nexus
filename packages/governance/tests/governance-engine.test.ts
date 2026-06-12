// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";

import {
  GovernanceEngine,
  ResourceScopeConstraint,
  CostBudgetConstraint,
  TimeoutConstraint,
  DangerousOperationPolicy,
  WildcardPermissionsPolicy,
  LoopDetectionGuardrail,
  RunawayRetriesGuardrail,
  TaskGraphLimitGuardrail,
  HighCostPlanGuardrail,
  DuplicateActionGuardrail,
} from "../src/governance-engine.js";
import type {
  ITaskSynthesisResult,
  ICognitiveTrace,
} from "../src/interfaces/governance.interface.js";

function makeTask(overrides: Partial<ITaskSynthesisResult> = {}): ITaskSynthesisResult {
  return {
    taskId: "task-001",
    action: "search.web",
    arguments: {},
    governanceMetadata: { dangerous: false, costEstimate: 0.1 },
    ...overrides,
  };
}

function makeTrace(tasks: ITaskSynthesisResult[]): ICognitiveTrace {
  return { traceId: "trace-001", synthesisResults: tasks, startedAt: new Date() };
}

describe("Constraints", () => {
  describe("ResourceScopeConstraint", () => {
    it("blocks tasks with blocked resource scopes", () => {
      const c = new ResourceScopeConstraint(["system:root"]);
      const task = makeTask({
        governanceMetadata: { resourceScope: "system:root", dangerous: false, costEstimate: 0 },
      });
      expect(c.validate(task).success).toBe(false);
    });

    it("allows tasks with allowed scopes", () => {
      const c = new ResourceScopeConstraint(["system:root"]);
      const task = makeTask({
        governanceMetadata: { resourceScope: "user:standard", dangerous: false, costEstimate: 0 },
      });
      expect(c.validate(task).success).toBe(true);
    });

    it("allows tasks with no resource scope", () => {
      const c = new ResourceScopeConstraint();
      const task = makeTask();
      expect(c.validate(task).success).toBe(true);
    });
  });

  describe("CostBudgetConstraint", () => {
    it("blocks tasks exceeding cost limit", () => {
      const c = new CostBudgetConstraint(0.5);
      const task = makeTask({ governanceMetadata: { costEstimate: 1.0, dangerous: false } });
      const result = c.validate(task);
      expect(result.success).toBe(false);
      expect(result.reason).toMatch(/cost/i);
    });

    it("allows tasks within budget", () => {
      const c = new CostBudgetConstraint(0.5);
      const task = makeTask({ governanceMetadata: { costEstimate: 0.3, dangerous: false } });
      expect(c.validate(task).success).toBe(true);
    });

    it("allows tasks at exactly the budget limit", () => {
      const c = new CostBudgetConstraint(0.5);
      const task = makeTask({ governanceMetadata: { costEstimate: 0.5, dangerous: false } });
      expect(c.validate(task).success).toBe(true);
    });
  });

  describe("TimeoutConstraint", () => {
    it("blocks tasks with declared execution time exceeding ceiling", () => {
      const c = new TimeoutConstraint(60_000);
      const task = makeTask({
        governanceMetadata: { maxExecutionMs: 120_000, dangerous: false, costEstimate: 0 },
      });
      const result = c.validate(task);
      expect(result.success).toBe(false);
    });

    it("allows tasks within timeout ceiling", () => {
      const c = new TimeoutConstraint(60_000);
      const task = makeTask({
        governanceMetadata: { maxExecutionMs: 30_000, dangerous: false, costEstimate: 0 },
      });
      expect(c.validate(task).success).toBe(true);
    });
  });
});

describe("Policies", () => {
  describe("DangerousOperationPolicy", () => {
    it("requiresApproval returns true for dangerous tasks", () => {
      const p = new DangerousOperationPolicy();
      const task = makeTask({ governanceMetadata: { dangerous: true, costEstimate: 0 } });
      expect(p.requiresApproval(task)).toBe(true);
    });

    it("requiresApproval returns false for safe tasks", () => {
      const p = new DangerousOperationPolicy();
      const task = makeTask({ governanceMetadata: { dangerous: false, costEstimate: 0 } });
      expect(p.requiresApproval(task)).toBe(false);
    });

    it("validate always succeeds (approval is handled externally)", () => {
      const p = new DangerousOperationPolicy();
      expect(p.validate(makeTask()).success).toBe(true);
    });
  });

  describe("WildcardPermissionsPolicy", () => {
    it("requiresApproval returns true when permissions includes wildcard", () => {
      const p = new WildcardPermissionsPolicy();
      const task = makeTask({ arguments: { permissions: ["*"] } });
      expect(p.requiresApproval(task)).toBe(true);
    });

    it("requiresApproval returns false for scoped permissions", () => {
      const p = new WildcardPermissionsPolicy();
      const task = makeTask({ arguments: { permissions: ["read:files"] } });
      expect(p.requiresApproval(task)).toBe(false);
    });

    it("requiresApproval returns false with no permissions key", () => {
      const p = new WildcardPermissionsPolicy();
      expect(p.requiresApproval(makeTask())).toBe(false);
    });
  });
});

describe("Guardrails", () => {
  describe("LoopDetectionGuardrail", () => {
    it("fails when an action repeats beyond limit", () => {
      const g = new LoopDetectionGuardrail(3);
      const logs = [
        { action: "web_search" },
        { action: "web_search" },
        { action: "web_search" },
        { action: "web_search" },
      ];
      expect(g.check([], logs).success).toBe(false);
    });

    it("passes when actions are within limit", () => {
      const g = new LoopDetectionGuardrail(3);
      const logs = [{ action: "web_search" }, { action: "web_search" }, { action: "llm_call" }];
      expect(g.check([], logs).success).toBe(true);
    });
  });

  describe("RunawayRetriesGuardrail", () => {
    it("fails when retries exceed limit", () => {
      const g = new RunawayRetriesGuardrail(3);
      const logs = [{ retries: 4 }];
      expect(g.check([], logs).success).toBe(false);
    });

    it("passes when retries are within limit", () => {
      const g = new RunawayRetriesGuardrail(5);
      const logs = [{ retries: 3 }];
      expect(g.check([], logs).success).toBe(true);
    });
  });

  describe("TaskGraphLimitGuardrail", () => {
    it("fails when synthesized tasks exceed limit", () => {
      const g = new TaskGraphLimitGuardrail(3);
      const tasks = [makeTask(), makeTask(), makeTask(), makeTask()];
      expect(g.check(tasks, []).success).toBe(false);
    });

    it("passes when tasks are within limit", () => {
      const g = new TaskGraphLimitGuardrail(5);
      expect(g.check([makeTask(), makeTask()], []).success).toBe(true);
    });
  });

  describe("HighCostPlanGuardrail", () => {
    it("fails when total plan cost exceeds ceiling", () => {
      const g = new HighCostPlanGuardrail(5.0);
      const tasks = [
        makeTask({ governanceMetadata: { costEstimate: 3.0, dangerous: false } }),
        makeTask({ governanceMetadata: { costEstimate: 3.0, dangerous: false } }),
      ];
      expect(g.check(tasks, []).success).toBe(false);
    });

    it("passes when total plan cost is within ceiling", () => {
      const g = new HighCostPlanGuardrail(5.0);
      const tasks = [
        makeTask({ governanceMetadata: { costEstimate: 2.0, dangerous: false } }),
        makeTask({ governanceMetadata: { costEstimate: 2.0, dangerous: false } }),
      ];
      expect(g.check(tasks, []).success).toBe(true);
    });
  });

  describe("DuplicateActionGuardrail", () => {
    it("fails when same action appears more than once", () => {
      const g = new DuplicateActionGuardrail(1);
      const tasks = [makeTask({ action: "search.web" }), makeTask({ action: "search.web" })];
      expect(g.check(tasks, []).success).toBe(false);
    });

    it("passes when all actions are unique", () => {
      const g = new DuplicateActionGuardrail(1);
      const tasks = [makeTask({ action: "search.web" }), makeTask({ action: "llm.call" })];
      expect(g.check(tasks, []).success).toBe(true);
    });
  });
});

describe("GovernanceEngine", () => {
  let engine: GovernanceEngine;

  beforeEach(() => {
    engine = new GovernanceEngine();
  });

  describe("registration", () => {
    it("registers constraints, policies, and guardrails", () => {
      engine.registerConstraint(new CostBudgetConstraint());
      engine.registerPolicy(new DangerousOperationPolicy());
      engine.registerGuardrail(new TaskGraphLimitGuardrail());

      expect(engine.getConstraints()).toHaveLength(1);
      expect(engine.getPolicies()).toHaveLength(1);
      expect(engine.getGuardrails()).toHaveLength(1);
    });
  });

  describe("evaluateTask()", () => {
    it("allows a safe, inexpensive task with no registered rules", async () => {
      const result = await engine.evaluateTask(makeTask());
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it("blocks a task when a constraint fails", async () => {
      engine.registerConstraint(new CostBudgetConstraint(0.1));
      const expensiveTask = makeTask({
        governanceMetadata: { costEstimate: 1.0, dangerous: false },
      });
      const result = await engine.evaluateTask(expensiveTask);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/CostBudgetConstraint/);
    });

    it("flags requiresApproval when a policy demands it", async () => {
      engine.registerPolicy(new DangerousOperationPolicy());
      const dangerousTask = makeTask({ governanceMetadata: { dangerous: true, costEstimate: 0 } });
      const result = await engine.evaluateTask(dangerousTask);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
    });

    it("short-circuits on first failing constraint", async () => {
      engine.registerConstraint(new ResourceScopeConstraint(["system:root"]));
      engine.registerConstraint(new CostBudgetConstraint(0.5));
      const task = makeTask({
        governanceMetadata: { resourceScope: "system:root", dangerous: false, costEstimate: 0 },
      });
      const result = await engine.evaluateTask(task);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/ResourceScopeConstraint/);
    });
  });

  describe("evaluatePlan()", () => {
    it("allows a plan that passes all guardrails", async () => {
      engine.registerGuardrail(new TaskGraphLimitGuardrail(10));
      const trace = makeTrace([makeTask(), makeTask()]);
      const result = await engine.evaluatePlan(trace);
      expect(result.allowed).toBe(true);
    });

    it("blocks a plan that exceeds guardrail limits", async () => {
      engine.registerGuardrail(new TaskGraphLimitGuardrail(1));
      const trace = makeTrace([makeTask(), makeTask(), makeTask()]);
      const result = await engine.evaluatePlan(trace);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/TaskGraphLimitGuardrail/);
    });
  });

  describe("evaluateRuntimeLogs()", () => {
    it("allows clean execution logs", async () => {
      engine.registerGuardrail(new LoopDetectionGuardrail(5));
      const result = await engine.evaluateRuntimeLogs([makeTask()], [{ action: "search" }]);
      expect(result.allowed).toBe(true);
    });

    it("blocks execution when a loop is detected", async () => {
      engine.registerGuardrail(new LoopDetectionGuardrail(2));
      const logs = new Array(5).fill({ action: "search" });
      const result = await engine.evaluateRuntimeLogs([], logs);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/LoopDetectionGuardrail/);
    });
  });
});
