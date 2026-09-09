// SPDX-License-Identifier: Apache-2.0
/**
 * Crew planner — focused tests for goal → ordered-task decomposition: strict
 * and tolerant parsing, role assignment, format-ignoring degradation, and the
 * end-to-end plan-then-execute loop through {@link Crew}.
 */
import { describe, expect, it } from "vitest";
import { Crew } from "./crew.js";
import { parsePlan, planTasks, type PlanResult } from "./planner.js";

const ROLES = [
  { name: "researcher", role: "Senior Research Analyst", goal: "find and verify facts" },
  { name: "engineer", role: "Software Engineer", goal: "implement and test code" },
  { name: "writer", role: "Technical Writer", goal: "document decisions clearly" },
] as const;

const PLAN =
  "1. locate and summarise the incident report [researcher]\n" +
  "2. draft the fix [engineer]\n" +
  "3. document the change [writer]";

function llmRouting(planText: string, roleOutputs: Record<string, string>) {
  let planDone = false;
  return {
    async chat(messages: readonly { role: string; content: string }[]) {
      const user = messages[messages.length - 1]!.content;
      if (user.includes("You are a crew planner")) {
        planDone = true;
        return { content: planText };
      }
      const system = messages[0]?.content ?? "";
      // RoleAgent.run → system prompt starts "You are <role>. Goal: ..."
      const role = ROLES.find((r) => system.includes(`You are ${r.role}`))?.name ?? "researcher";
      return { content: roleOutputs[role] ?? `output-from-${role}` };
    },
    get planned() {
      return planDone;
    },
  };
}

describe("parsePlan", () => {
  it("parses numbered steps with role markers into ordered TaskConfigs", () => {
    const tasks = parsePlan(PLAN, ROLES);
    expect(tasks).toEqual([
      { description: "locate and summarise the incident report", agent: "researcher" },
      { description: "draft the fix", agent: "engineer" },
      { description: "document the change", agent: "writer" },
    ]);
  });

  it("tolerates markdown fences, bare numbers, and missing markers", () => {
    const tasks = parsePlan("```\n1) research the domain\n2. draft\n3. - ship it\n```", ROLES);
    expect(tasks.map((t) => t.description)).toEqual(["research the domain", "draft", "ship it"]);
    // Steps without a marker default to the first role.
    expect(tasks.every((t) => t.agent === "researcher")).toBe(true);
  });

  it("falls back to the first role for unknown marker names", () => {
    const tasks = parsePlan("1. do the thing [no-such-role]", ROLES);
    expect(tasks[0]!.agent).toBe("researcher");
  });

  it("degrades to one whole-goal task when nothing parses", () => {
    expect(parsePlan("I'd rather not plan.", ROLES)).toEqual([]);
    const tasks = parsePlan("I'd rather not plan.", ROLES, 10, "ship the fix");
    expect(tasks).toEqual([{ description: "ship the fix", agent: "researcher" }]);
  });

  it("caps the plan at maxSteps", () => {
    const tasks = parsePlan(PLAN, ROLES, 2);
    expect(tasks).toHaveLength(2);
  });
});

describe("planTasks", () => {
  it("calls the planner LLM once and returns parsed tasks + raw reply", async () => {
    const llm = llmRouting(PLAN, {});
    const res = await planTasks({ goal: "resolve the outage", roles: ROLES, llm });
    expect(res.tasks).toHaveLength(3);
    expect(res.raw).toBe(PLAN);
  });
});

describe("plan-then-execute end to end", () => {
  it("executes the planned tasks as a Crew and returns the final deliverable", async () => {
    const llm = llmRouting(PLAN, {
      researcher: "report: db timeouts at 02:00",
      engineer: "fix: raise connection pool limit",
      writer: "doc: runbook updated",
    });
    const { tasks } = await planTasks({ goal: "resolve the outage", roles: ROLES, llm });
    const crew = new Crew({ roles: ROLES, tasks, llm });
    const result = await crew.kickoff({});
    expect(result.results).toHaveLength(3);
    expect(result.results[0]!.agent).toBe("researcher");
    expect(result.results[1]!.agent).toBe("engineer");
    expect(result.results[2]!.agent).toBe("writer");
    expect(result.finalOutput).toBe("doc: runbook updated");
  });

  it("still runs a plan when the LLM ignores the format (single fallback task)", async () => {
    const llm = llmRouting("You're on your own.", { researcher: "did it all" });
    const { tasks } = await planTasks({ goal: "resolve the outage", roles: ROLES, llm });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.description).toBe("resolve the outage");
    const crew = new Crew({ roles: ROLES, tasks, llm });
    const result = await crew.kickoff({});
    expect(result.finalOutput).toBe("did it all");
  });

  it("exposes the plan through the raw result", async () => {
    const llm = llmRouting(PLAN, {});
    const res: PlanResult = await planTasks({ goal: "g", roles: ROLES, llm });
    expect(res.raw).toContain("incident report");
  });
});
