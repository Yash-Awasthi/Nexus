// SPDX-License-Identifier: Apache-2.0
/**
 * Replaying a run sends its exact prompt to another model, bills the call to
 * the run's scopes, refuses when a hard stop could be crossed, and diffs the answers.
 */
import { describe, it, expect } from "vitest";

import { bootOrg, useOrgDataDir } from "./org-test-env.js";

useOrgDataDir();

const boot = () =>
  bootOrg(async () => ({
    budget: await import("../../src/lib/org-budget.js"),
    replay: await import("../../src/lib/org-replay.js"),
  }));

describe("run replay", () => {
  it("re-asks the same prompt on another model and bills it to the run's agent", async () => {
    const { org, work, rt, budget, replay } = await boot();
    rt.registerAdapter("nexus", async () => ({
      ok: true,
      output: 'Red\nGreen\nBlue\n```json\n{"status":"done"}\n```',
    }));
    const c = org.createCompany("alice", { name: "Replay Co" });
    const a = org.createAgent("alice", c.id, { name: "A" });
    work.createTask("alice", c.id, { title: "Name three colours", assigneeAgentId: a.id });
    rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    const run = rt.listRuns("alice", c.id)[0]!;
    expect(run.prompt?.user).toContain("Name three colours");

    const asked: { model: string; user: string }[] = [];
    replay.setReplayCaller(async (model, prompt, steps) => {
      asked.push({ model, user: prompt.user });
      steps.push({
        provider: "x",
        model: "unpriced",
        inputTokens: 1000,
        outputTokens: 500,
        latencyMs: 1,
        cached: false,
      });
      return { content: 'Red\nYellow\nBlue\n```json\n{"status":"done"}\n```', model: "other-1" };
    });

    const r = await replay.replayRun("alice", run.id, "groq:other-1");
    expect(asked).toEqual([{ model: "groq:other-1", user: run.prompt!.user }]);
    expect(r.replay).toMatchObject({ model: "other-1", costUsd: 0.0025 });
    expect(r.diff.filter((d) => d.op !== " ").map((d) => `${d.op}${d.line}`)).toEqual([
      "-Green",
      "+Yellow",
    ]);
    expect(work.getTask("alice", run.taskId!).status).toBe("done");
    expect(
      budget.budgetOverview("alice", c.id).spend.byAgent.find((x) => x.agentId === a.id)
        ?.monthMicros,
    ).toBe(2500);

    await expect(replay.replayRun("bob", run.id, "groq:x")).rejects.toThrow(/not found/);

    budget.upsertPolicy("alice", c.id, { scopeType: "agent", scopeId: a.id, amountUsd: 0.003 });
    await expect(replay.replayRun("alice", run.id, "groq:other-1")).rejects.toThrow(/budget/);
    expect(asked).toHaveLength(1);
  });

  it("refuses on a paused company or agent unless the company lets replays run while paused", async () => {
    const { org, work, rt, replay } = await boot();
    rt.registerAdapter("nexus", async () => ({ ok: true, output: "Hi" }));
    const c = org.createCompany("alice", { name: "Paused Co" });
    const boss = org.createAgent("alice", c.id, { name: "Boss" });
    const a = org.createAgent("alice", c.id, { name: "A", reportsTo: boss.id });
    work.createTask("alice", c.id, { title: "Say hi", assigneeAgentId: a.id });
    rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    const run = rt.listRuns("alice", c.id)[0]!;
    let calls = 0;
    replay.setReplayCaller(async () => {
      calls++;
      return { content: "Hello", model: "m" };
    });

    for (const pause of [
      () => org.setCompanyStatus("alice", c.id, "paused"),
      () => org.setAgentStatus("alice", a.id, "paused"),
      () => org.setAgentStatus("alice", boss.id, "paused"),
    ]) {
      pause();
      await expect(replay.replayRun("alice", run.id, "groq:m")).rejects.toMatchObject({
        status: 409,
      });
      org.updateCompany("alice", c.id, { replaysWhilePaused: true });
      await replay.replayRun("alice", run.id, "groq:m");
      org.updateCompany("alice", c.id, { replaysWhilePaused: false });
      org.setCompanyStatus("alice", c.id, "active");
      org.setAgentStatus("alice", a.id, "idle");
      org.setAgentStatus("alice", boss.id, "idle");
    }
    expect(calls).toBe(3);
    expect(org.getCompany("alice", c.id).replaysWhilePaused).toBe(false);
  });
});

describe("task replay", () => {
  it("replays every run of a task and compares cost and outcome, stopping at a budget", async () => {
    const { org, work, rt, budget, replay } = await boot();
    let n = 0;
    rt.registerAdapter("nexus", async (ctx) => {
      n++;
      ctx.run.steps.push({
        provider: "x",
        model: "unpriced",
        inputTokens: 100,
        outputTokens: 100,
        latencyMs: 1,
        cached: false,
      });
      return {
        ok: true,
        output:
          n === 1
            ? 'Draft\n```json\n{"status":"in_progress"}\n```'
            : 'Final\n```json\n{"status":"done"}\n```',
      };
    });
    const c = org.createCompany("alice", { name: "Task Replay Co" });
    const a = org.createAgent("alice", c.id, { name: "A", heartbeat: { wakeOnAssign: false } });
    const t = work.createTask("alice", c.id, { title: "Write the page", assigneeAgentId: a.id });
    rt.enqueueWake("alice", a.id, { source: "manual", taskId: t.id });
    await rt.idle();
    rt.enqueueWake("alice", a.id, { source: "manual", taskId: t.id });
    await rt.idle();
    expect(rt.listRuns("alice", c.id, { taskId: t.id })).toHaveLength(2);

    replay.setReplayCaller(async (_model, prompt, steps) => {
      steps.push({
        provider: "x",
        model: "unpriced",
        inputTokens: 1000,
        outputTokens: 0,
        latencyMs: 1,
        cached: false,
      });
      return { content: `Other\n\`\`\`json\n{"status":"blocked"}\n\`\`\``, model: "other-1" };
    });
    const r = await replay.replayTask("alice", t.id, "groq:other-1");
    expect(r.rows.map((x) => [x.originalStatus, x.replayStatus])).toEqual([
      ["in_progress", "blocked"],
      ["done", "blocked"],
    ]);
    expect(r.totals.replayCostUsd).toBeCloseTo(0.002);
    expect(r.totals.originalCostUsd).toBeCloseTo(0.0008);

    budget.upsertPolicy("alice", c.id, { scopeType: "agent", scopeId: a.id, amountUsd: 0.0045 });
    const capped = await replay.replayTask("alice", t.id, "groq:other-1");
    expect(capped.rows.length).toBeLessThan(2);
    expect(capped.stopped).toMatch(/budget/);
    await expect(replay.replayTask("bob", t.id, "groq:x")).rejects.toThrow(/not found/);
  });

  it("scores each model an agent ran or was replayed on, and names a cheaper one that agrees", async () => {
    const { org, work, rt, replay } = await boot();
    rt.registerAdapter("nexus", async (ctx) => {
      ctx.run.steps.push({
        provider: "groq",
        model: "big",
        inputTokens: 1000,
        outputTokens: 1000,
        latencyMs: 1,
        cached: false,
      });
      return { ok: true, output: 'Done\n```json\n{"status":"done"}\n```' };
    });
    const c = org.createCompany("alice", { name: "Scorecard Co" });
    const a = org.createAgent("alice", c.id, {
      name: "A",
      model: "groq/big",
      heartbeat: { wakeOnAssign: false },
    });
    const tasks: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = work.createTask("alice", c.id, { title: `Write it ${i}`, assigneeAgentId: a.id });
      tasks.push(t.id);
      rt.enqueueWake("alice", a.id, { source: "manual", taskId: t.id });
      await rt.idle();
    }
    replay.setReplayCaller(async (model, _prompt, steps) => {
      steps.push({
        provider: "groq",
        model,
        inputTokens: 100,
        outputTokens: 100,
        latencyMs: 1,
        cached: false,
      });
      const status = model === "groq/cheap" ? "done" : "blocked";
      return { content: `x\n\`\`\`json\n{"status":"${status}"}\n\`\`\``, model };
    });
    for (const id of tasks) {
      await replay.replayTask("alice", id, "groq/cheap");
      await replay.replayTask("alice", id, "groq/wrong");
    }

    const card = replay.modelScorecard("alice", a.id);
    expect(card.current).toBe("groq/big");
    const row = (m: string) => card.models.find((x) => x.model === m)!;
    expect(row("groq/big")).toMatchObject({ runs: 3, doneRate: 1 });
    expect(row("groq/cheap")).toMatchObject({ replayed: 3, agreement: 1 });
    expect(row("groq/wrong")).toMatchObject({ replayed: 3, agreement: 0 });
    expect(row("groq/cheap").avgCostUsd!).toBeLessThan(row("groq/big").avgCostUsd!);
    expect(card.recommendation?.model).toBe("groq/cheap");
    // The replays a recommendation rests on survive a restart.
    const after = await boot();
    expect(after.replay.modelScorecard("alice", a.id).recommendation?.model).toBe("groq/cheap");
    expect(
      replay.modelScorecard("alice", org.createAgent("alice", c.id, { name: "B" }).id)
        .recommendation,
    ).toBeNull();
    expect(() => replay.modelScorecard("bob", a.id)).toThrow(/not found/);
  });

  it("moves an opted-in company's agent to its recommended model, logs it, and lets it go back", async () => {
    const { org, work, rt, replay } = await boot();
    rt.registerAdapter("nexus", async (ctx) => {
      ctx.run.steps.push({
        provider: "groq",
        model: "big",
        inputTokens: 1000,
        outputTokens: 1000,
        latencyMs: 1,
        cached: false,
      });
      return { ok: true, output: 'Done\n```json\n{"status":"done"}\n```' };
    });
    replay.setReplayCaller(async (model, _prompt, steps) => {
      steps.push({
        provider: "groq",
        model,
        inputTokens: 100,
        outputTokens: 100,
        latencyMs: 1,
        cached: false,
      });
      return { content: 'x\n```json\n{"status":"done"}\n```', model };
    });
    const setUp = async (autoModel: boolean) => {
      const c = org.createCompany("alice", { name: `Auto ${String(autoModel)}`, autoModel });
      const a = org.createAgent("alice", c.id, {
        name: "A",
        model: "groq/big",
        heartbeat: { wakeOnAssign: false },
      });
      for (let i = 0; i < 3; i++) {
        const t = work.createTask("alice", c.id, { title: `Job ${i}`, assigneeAgentId: a.id });
        rt.enqueueWake("alice", a.id, { source: "manual", taskId: t.id });
        await rt.idle();
        await replay.replayTask("alice", t.id, "groq/cheap");
      }
      return { c, a };
    };

    const off = await setUp(false);
    expect(org.getAgent("alice", off.a.id).model).toBe("groq/big");

    const on = await setUp(true);
    expect(org.getAgent("alice", on.a.id).model).toBe("groq/cheap");
    const logged = org
      .listActivity("alice", on.c.id)
      .find((x) => x.action === "agent.model_switched");
    expect(logged?.details).toMatchObject({ from: "groq/big", to: "groq/cheap" });
    expect(replay.modelScorecard("alice", on.a.id).autoSwitch).toMatchObject({ from: "groq/big" });

    // Switching back holds: the scorecard does not move it to the same model again.
    org.updateAgent("alice", on.a.id, { model: "groq/big" });
    const t = work.createTask("alice", on.c.id, { title: "Job again", assigneeAgentId: on.a.id });
    rt.enqueueWake("alice", on.a.id, { source: "manual", taskId: t.id });
    await rt.idle();
    await replay.replayTask("alice", t.id, "groq/cheap");
    expect(org.getAgent("alice", on.a.id).model).toBe("groq/big");
  });
});
