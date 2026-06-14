// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";

import type {
  IWorkflowTemplate,
  IWorkflowDefinition,
} from "../src/interfaces/workflow.interface.js";
import type { Task } from "../src/task-router.js";
import {
  WorkflowConstraint,
  WorkflowApprovalPolicy,
  WorkflowRegistry,
} from "../src/workflow-engine.js";

function makeTask(id: string, priority = "medium"): Task {
  return { id, title: "T", description: "", priority, status: "pending", dependencies: [] };
}

function makeDefinition(id: string): IWorkflowDefinition {
  return {
    id,
    name: `Workflow ${id}`,
    description: "A test workflow",
    tasks: [],
  };
}

function makeTemplate(id: string): IWorkflowTemplate {
  return {
    templateId: id,
    name: `Template ${id}`,
    description: "A test template",
    createWorkflow: (_params: Record<string, unknown>) => makeDefinition(`${id}-wf`),
  };
}

// ─── WorkflowConstraint ───────────────────────────────────────────────────────

describe("WorkflowConstraint", () => {
  it("returns allowed=true when checker approves", async () => {
    const checker = vi.fn().mockResolvedValue({ allowed: true });
    const constraint = new WorkflowConstraint("max-tasks", checker);

    const result = await constraint.evaluate([makeTask("t1")]);
    expect(result.allowed).toBe(true);
    expect(checker).toHaveBeenCalledOnce();
  });

  it("returns allowed=false with reason when checker rejects", async () => {
    const checker = vi.fn().mockResolvedValue({ allowed: false, reason: "Too many tasks" });
    const constraint = new WorkflowConstraint("task-limit", checker);

    const result = await constraint.evaluate([makeTask("t1"), makeTask("t2")]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("Too many tasks");
  });

  it("passes tasks to the checker", async () => {
    const checker = vi.fn().mockResolvedValue({ allowed: true });
    const constraint = new WorkflowConstraint("check", checker);
    const tasks = [makeTask("a"), makeTask("b")];

    await constraint.evaluate(tasks);
    expect(checker).toHaveBeenCalledWith(tasks);
  });

  it("exposes the constraint name", () => {
    const constraint = new WorkflowConstraint("my-constraint", vi.fn());
    expect(constraint.name).toBe("my-constraint");
  });
});

// ─── WorkflowApprovalPolicy ───────────────────────────────────────────────────

describe("WorkflowApprovalPolicy", () => {
  it("returns true (requires approval) when decider returns true", async () => {
    const decider = vi.fn().mockResolvedValue(true);
    const policy = new WorkflowApprovalPolicy("dangerous-workflow", decider);

    const result = await policy.requiresApproval([makeTask("t1")]);
    expect(result).toBe(true);
  });

  it("returns false when decider returns false", async () => {
    const decider = vi.fn().mockResolvedValue(false);
    const policy = new WorkflowApprovalPolicy("safe-workflow", decider);

    const result = await policy.requiresApproval([makeTask("t1")]);
    expect(result).toBe(false);
  });

  it("passes tasks to the decider", async () => {
    const decider = vi.fn().mockResolvedValue(false);
    const policy = new WorkflowApprovalPolicy("wf", decider);
    const tasks = [makeTask("x")];

    await policy.requiresApproval(tasks);
    expect(decider).toHaveBeenCalledWith(tasks);
  });

  it("exposes the workflowName", () => {
    const policy = new WorkflowApprovalPolicy("my-workflow", vi.fn());
    expect(policy.workflowName).toBe("my-workflow");
  });
});

// ─── WorkflowRegistry ─────────────────────────────────────────────────────────

describe("WorkflowRegistry", () => {
  describe("templates", () => {
    it("registers and retrieves a template by ID", () => {
      const registry = new WorkflowRegistry();
      const tpl = makeTemplate("tpl-001");
      registry.registerTemplate(tpl);
      expect(registry.getTemplate("tpl-001")).toBe(tpl);
    });

    it("returns undefined for an unknown template ID", () => {
      const registry = new WorkflowRegistry();
      expect(registry.getTemplate("does-not-exist")).toBeUndefined();
    });

    it("lists all registered templates", () => {
      const registry = new WorkflowRegistry();
      registry.registerTemplate(makeTemplate("t1"));
      registry.registerTemplate(makeTemplate("t2"));
      const templates = registry.listTemplates();
      expect(templates).toHaveLength(2);
      expect(templates.map((t) => t.templateId)).toEqual(expect.arrayContaining(["t1", "t2"]));
    });

    it("overwrites an existing template with the same ID", () => {
      const registry = new WorkflowRegistry();
      const tplV1 = { ...makeTemplate("tpl-x"), name: "Name V1" };
      const tplV2 = { ...makeTemplate("tpl-x"), name: "Name V2" };
      registry.registerTemplate(tplV1);
      registry.registerTemplate(tplV2);
      expect(registry.getTemplate("tpl-x")?.name).toBe("Name V2");
    });
  });

  describe("definitions", () => {
    it("registers and retrieves a workflow definition by ID", () => {
      const registry = new WorkflowRegistry();
      const def = makeDefinition("wf-001");
      registry.registerWorkflow(def);
      expect(registry.getWorkflow("wf-001")).toBe(def);
    });

    it("returns undefined for an unknown workflow ID", () => {
      const registry = new WorkflowRegistry();
      expect(registry.getWorkflow("unknown")).toBeUndefined();
    });

    it("lists all registered workflow definitions", () => {
      const registry = new WorkflowRegistry();
      registry.registerWorkflow(makeDefinition("wf-a"));
      registry.registerWorkflow(makeDefinition("wf-b"));
      const defs = registry.listWorkflows();
      expect(defs).toHaveLength(2);
    });
  });
});
