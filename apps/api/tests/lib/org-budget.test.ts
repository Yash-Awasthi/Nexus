// SPDX-License-Identifier: Apache-2.0
/**
 * Budgets: warnings, hard stops that pause the scope and hold across runs,
 * goal-scoped limits, and the per-call check that refuses a model call which
 * could cross a limit before any money is spent.
 */

import type { LlmDriver } from "@nexus/llm-drivers";
import { describe, it, expect } from "vitest";

import { bootOrg, useOrgDataDir } from "./org-test-env.js";

type Runtime = typeof import("../../src/lib/org-runtime.js");

const boot = () =>
  bootOrg(async () => ({
    budget: await import("../../src/lib/org-budget.js"),
    adapters: await import("../../src/lib/org-adapters.js"),
    failover: await import("../../src/lib/llm-failover.js"),
  }));

/** A run that spends $0.0025: 1000 input and 500 output tokens on an unpriced model. */
function spendingAdapter(rt: Runtime, status = "in_progress") {
  rt.registerAdapter("nexus", async (ctx) => {
    ctx.run.steps.push({
      provider: "x",
      model: "unpriced",
      inputTokens: 1000,
      outputTokens: 500,
      latencyMs: 1,
      cached: false,
    });
    return { ok: true, output: `done\n\`\`\`json\n{"status":"${status}"}\n\`\`\`` };
  });
}

useOrgDataDir();

describe("org budgets", () => {
  it("warns, then pauses the agent and holds it until the budget is raised", async () => {
    const { org, work, rt, budget } = await boot();
    const c = org.createCompany("alice", { name: "Spend Co" });
    const a = org.createAgent("alice", c.id, { name: "A" });
    work.createTask("alice", c.id, { title: "T", assigneeAgentId: a.id });
    budget.upsertPolicy("alice", c.id, { scopeType: "agent", scopeId: a.id, amountUsd: 0.006 });
    spendingAdapter(rt);

    rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    let view = budget.budgetOverview("alice", c.id);
    expect(view.policies[0]).toMatchObject({ observedMicros: 5000, state: "warning" });
    expect(view.incidents.map((i) => i.threshold)).toEqual(["soft"]);

    rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    view = budget.budgetOverview("alice", c.id);
    expect(view.policies[0]!.state).toBe("hard_stop");
    expect(org.getAgent("alice", a.id)).toMatchObject({ status: "paused", pauseReason: "budget" });
    expect(() => org.setAgentStatus("alice", a.id, "idle")).toThrow(/budget/);

    const hard = view.incidents.find((i) => i.threshold === "hard")!;
    expect(() =>
      budget.resolveIncident("alice", hard.id, { action: "raise_and_resume", amountUsd: 0.005 }),
    ).toThrow(/above current spend/);
    budget.resolveIncident("alice", hard.id, { action: "raise_and_resume", amountUsd: 1 });
    expect(org.getAgent("alice", a.id).status).toBe("idle");
    expect(() => budget.resolveIncident("bob", hard.id, { action: "dismiss" })).toThrow(
      /not found/,
    );
  });

  it("stops a whole company and refuses runs under an exhausted goal", async () => {
    const { org, work, rt, budget } = await boot();
    const c = org.createCompany("alice", { name: "Goal Co" });
    const a = org.createAgent("alice", c.id, { name: "A" });
    const g = work.createGoal("alice", c.id, { title: "Ads" });
    const inGoal = work.createTask("alice", c.id, {
      title: "ad",
      goalId: g.id,
      assigneeAgentId: a.id,
    });
    const other = work.createTask("alice", c.id, { title: "other", assigneeAgentId: a.id });
    budget.upsertPolicy("alice", c.id, { scopeType: "goal", scopeId: g.id, amountUsd: 0.002 });
    spendingAdapter(rt);

    rt.enqueueWake("alice", a.id, { source: "manual", taskId: inGoal.id });
    await rt.idle();
    expect(
      budget.budgetBlock(org.getAgent("alice", a.id), work.getTask("alice", inGoal.id)),
    ).toMatch(/Ads is over its month budget/);
    const refused = rt.enqueueWake("alice", a.id, { source: "manual", taskId: inGoal.id });
    await rt.idle();
    expect(rt.getRun("alice", refused.id).status).toBe("skipped");
    const allowed = rt.enqueueWake("alice", a.id, { source: "manual", taskId: other.id });
    await rt.idle();
    expect(rt.getRun("alice", allowed.id).status).toBe("succeeded");

    budget.upsertPolicy("alice", c.id, {
      scopeType: "company",
      amountUsd: 0.004,
      windowKind: "day",
    });
    expect(org.getCompany("alice", c.id)).toMatchObject({
      status: "paused",
      pauseReason: "budget",
    });
    budget.upsertPolicy("alice", c.id, { scopeType: "company", amountUsd: 1, windowKind: "day" });
    expect(org.getCompany("alice", c.id).status).toBe("active");
  });

  it("forecasts the month and when each limit runs out", async () => {
    const { org, work, rt, budget } = await boot();
    const c = org.createCompany("alice", { name: "Forecast Co" });
    const a = org.createAgent("alice", c.id, { name: "A" });
    budget.upsertPolicy("alice", c.id, {
      scopeType: "company",
      amountUsd: 1,
      windowKind: "lifetime",
    });
    spendingAdapter(rt, "done");
    for (let i = 0; i < 7; i++) {
      work.createTask("alice", c.id, { title: `t${i}`, assigneeAgentId: a.id });
      rt.enqueueWake("alice", a.id, { source: "manual" });
      await rt.idle();
    }
    const f = budget.forecast("alice", c.id);
    // $0.0175 spent today; averaged over a week that is $0.0025 a day.
    expect(f.perDayUsd).toBeCloseTo(0.0025, 6);
    expect(f.projectedMonthUsd).toBeGreaterThanOrEqual(0.0175);
    const at = Date.parse(f.exhaustion[0]!.at!);
    const days = (at - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(385);
    expect(days).toBeLessThan(400);
  });

  it("refuses a model call that could cross the limit before spending anything", async () => {
    const { org, work, rt, budget, adapters, failover } = await boot();
    const c = org.createCompany("alice", { name: "Guard Co" });
    const a = org.createAgent("alice", c.id, { name: "A", adapterConfig: { maxTokens: 2048 } });
    const t = work.createTask("alice", c.id, { title: "T", assigneeAgentId: a.id });
    budget.upsertPolicy("alice", c.id, { scopeType: "agent", scopeId: a.id, amountUsd: 0.001 });
    let called = 0;
    const driver = {
      provider: "fake",
      model: "unpriced",
      complete: async () => {
        called++;
        return { id: "1", content: "x", model: "unpriced", finishReason: "stop", durationMs: 1 };
      },
    } as unknown as LlmDriver;
    rt.registerAdapter(
      "nexus",
      adapters.nativeAdapter(
        () => ({
          driver: new failover.FailoverDriver([{ id: "fake", driver }]),
          model: "unpriced",
          label: "fake",
        }),
        () => null,
      ),
    );
    const r = rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    expect(called).toBe(0);
    expect(rt.getRun("alice", r.id)).toMatchObject({ status: "skipped" });
    expect(rt.getRun("alice", r.id).error).toMatch(/past its month budget/);
    expect(work.getTask("alice", t.id).checkoutRunId).toBeNull();
    expect(org.getAgent("alice", a.id).status).toBe("idle");
  });

  it("lets failover skip a model the budget refuses, and refuses only when none fits", async () => {
    const { org, work, rt, budget, adapters, failover } = await boot();
    const c = org.createCompany("alice", { name: "Chain Co" });
    const a = org.createAgent("alice", c.id, { name: "A", adapterConfig: { maxTokens: 2048 } });
    budget.upsertPolicy("alice", c.id, { scopeType: "agent", scopeId: a.id, amountUsd: 0.05 });
    const served: string[] = [];
    // "provider/model", as a real driver splits it.
    const fake = (model: string) =>
      ({
        provider: model.includes("/") ? model.split("/")[0] : "local",
        model: model.slice(model.indexOf("/") + 1),
        complete: async () => {
          served.push(model);
          return { id: "1", content: "x", model, finishReason: "stop", durationMs: 1 };
        },
        countTokens: (t: string) => t.length,
      }) as unknown as LlmDriver;
    let chain: string[] = [];
    rt.registerAdapter(
      "nexus",
      adapters.nativeAdapter(
        () => ({
          driver: new failover.FailoverDriver(
            chain.map((m, i) => ({ id: m, driver: fake(m), ownModel: i > 0 })),
          ),
          model: chain[0]!.slice(chain[0]!.indexOf("/") + 1),
          label: "fake",
        }),
        () => null,
      ),
    );
    const runOn = async (models: string[]) => {
      chain = models;
      work.createTask("alice", c.id, { title: models.join(","), assigneeAgentId: a.id });
      const r = rt.enqueueWake("alice", a.id, { source: "manual" });
      await rt.idle();
      return rt.getRun("alice", r.id);
    };

    // A cheap primary runs although a dear fallback would not fit.
    expect((await runOn(["unpriced", "anthropic/claude-3-opus"])).status).toBe("succeeded");
    // A dear primary is skipped and the cheap fallback answers.
    expect((await runOn(["anthropic/claude-3-opus", "unpriced"])).status).toBe("succeeded");
    expect(served).toEqual(["unpriced", "unpriced"]);
    // Nothing in the chain fits: refused before any call.
    const none = await runOn(["anthropic/claude-3-opus"]);
    expect(none.status).toBe("skipped");
    expect(none.error).toMatch(/past its month budget/);
    expect(served).toHaveLength(2);
  });

  it("sends answer-only work to the agent's quick model and the rest to its main one", async () => {
    const { org, work, rt, adapters, failover } = await boot();
    const c = org.createCompany("alice", { name: "Route Co" });
    const a = org.createAgent("alice", c.id, {
      name: "A",
      model: "big-model",
      adapterConfig: { quickModel: "small-model" },
      heartbeat: { wakeOnAssign: false },
    });
    const chosen: (string | null)[] = [];
    const driver = {
      provider: "fake",
      model: "m",
      complete: async () => ({
        id: "1",
        content: "ok",
        model: "m",
        finishReason: "stop",
        durationMs: 1,
      }),
    } as unknown as LlmDriver;
    rt.registerAdapter(
      "nexus",
      adapters.nativeAdapter(
        (choice) => {
          chosen.push(choice);
          return {
            driver: new failover.FailoverDriver([{ id: "fake", driver }]),
            model: "m",
            label: "fake",
          };
        },
        (agent) => agent.model,
      ),
    );
    work.createTask("alice", c.id, { title: "Quick q", assigneeAgentId: a.id, workMode: "ask" });
    rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    work.createTask("alice", c.id, { title: "Real work", assigneeAgentId: a.id });
    rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    expect(chosen).toEqual(["small-model", "big-model"]);
  });
});
