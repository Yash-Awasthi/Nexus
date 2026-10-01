// SPDX-License-Identifier: Apache-2.0
/**
 * Company bundles: a round trip rebuilds the org chart, goals, routines,
 * budgets and lessons under a new owner; secrets and machine paths never leave;
 * templates start working companies.
 */

import { describe, it, expect } from "vitest";

import { bootOrg, useOrgDataDir } from "./org-test-env.js";

const boot = () =>
  bootOrg(async () => ({
    port: await import("../../src/lib/org-portability.js"),
    budget: await import("../../src/lib/org-budget.js"),
    sched: await import("../../src/lib/org-scheduler.js"),
    memory: await import("../../src/lib/org-memory.js"),
  }));

useOrgDataDir();

describe("org portability", () => {
  it("round-trips a company without its secrets", async () => {
    const { port, budget, sched, memory, work, org } = await boot();
    const c = org.createCompany("alice", { name: "Export Co", mission: "Ship" });
    const ceo = org.createAgent("alice", c.id, { name: "Boss", role: "ceo" });
    const hook = org.createAgent("alice", c.id, {
      name: "Hook",
      reportsTo: ceo.id,
      adapterType: "http",
      adapterConfig: {
        url: "https://example.com/agent",
        cwd: "C:/secret/path",
        headers: { Authorization: "Bearer sk-live-123", "X-Key": "secret:HOOK_KEY" },
      },
    });
    const top = work.createGoal("alice", c.id, { title: "Top" });
    work.createGoal("alice", c.id, { title: "Child", parentId: top.id });
    sched.createRoutine("alice", c.id, {
      title: "Daily",
      assigneeAgentId: hook.id,
      cron: "0 9 * * *",
    });
    budget.upsertPolicy("alice", c.id, { scopeType: "agent", scopeId: hook.id, amountUsd: 2 });
    memory.addLesson({
      ownerId: "alice",
      companyId: c.id,
      agentId: null,
      kind: "note",
      text: "Be brief.",
      source: null,
    });

    const bundle = port.exportCompany("alice", c.id);
    const text = JSON.stringify(bundle);
    expect(text).not.toContain("sk-live-123");
    expect(text).not.toContain("secret/path");
    expect(bundle.agents[1]!.adapterConfig.headers).toEqual({
      Authorization: "secret:REPLACE_ME",
      "X-Key": "secret:HOOK_KEY",
    });

    const copy = port.importCompany("bob", JSON.parse(text));
    expect(copy.name).toBe("Export Co");
    const agents = org.listAgents("bob", copy.id);
    expect(agents.map((a) => a.name)).toEqual(["Boss", "Hook"]);
    expect(agents[1]!.reportsTo).toBe(agents[0]!.id);
    const goals = work.listGoals("bob", copy.id);
    expect(goals.find((g) => g.title === "Child")!.parentId).toBe(
      goals.find((g) => g.title === "Top")!.id,
    );
    expect(sched.listRoutines("bob", copy.id)[0]).toMatchObject({
      title: "Daily",
      assigneeAgentId: agents[1]!.id,
    });
    expect(budget.listPolicies("bob", copy.id)[0]).toMatchObject({
      scopeId: agents[1]!.id,
      amountMicros: 2_000_000,
    });
    expect(memory.listLessons("bob", copy.id).map((l) => l.text)).toEqual(["Be brief."]);

    expect(port.importCompany("bob", bundle).name).toBe("Export Co (2)");
    expect(() => port.importCompany("bob", { format: "other" })).toThrow(/bundle/);
    expect(() => port.exportCompany("bob", c.id)).toThrow(/not found/);
  });

  it("starts a working company from each template", async () => {
    const { port, org, sched } = await boot();
    for (const t of port.TEMPLATES) {
      const c = port.instantiateTemplate("carol", t.id);
      const agents = org.listAgents("carol", c.id);
      expect(agents.length).toBeGreaterThanOrEqual(3);
      expect(agents.filter((a) => a.reportsTo === null)).toHaveLength(1);
      expect(sched.listRoutines("carol", c.id).length).toBe(t.bundle.routines.length);
    }
    expect(() => port.instantiateTemplate("carol", "nope")).toThrow(/not found/);
  });
});
