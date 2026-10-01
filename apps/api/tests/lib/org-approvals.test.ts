// SPDX-License-Identifier: Apache-2.0
/**
 * The approvals inbox: each kind of request is filed by what it governs, each
 * decision carries out its effect, and a council review attaches a verdict and
 * books its cost against the company.
 */

import { describe, it, expect, vi } from "vitest";

import { bootOrg, useOrgDataDir } from "./org-test-env.js";

const boot = () =>
  bootOrg(async () => ({
    approvals: await import("../../src/lib/org-approvals.js"),
    budget: await import("../../src/lib/org-budget.js"),
  }));

const reply = (body: string, ctl: Record<string, unknown>) =>
  `${body}\n\n\`\`\`json\n${JSON.stringify(ctl)}\n\`\`\``;

useOrgDataDir();

describe("org approvals", () => {
  it("holds hires until the board decides", async () => {
    const { approvals, org } = await boot();
    const c = org.createCompany("alice", { name: "Strict", requireHireApproval: true });
    const good = org.createAgent("alice", c.id, { name: "Good" });
    const bad = org.createAgent("alice", c.id, { name: "Bad" });
    const [second, first] = approvals.listApprovals("alice", c.id, "pending");
    expect([first!.type, first!.subject.agentId]).toEqual(["hire_agent", good.id]);
    expect(approvals.pendingCount("alice")).toBe(2);
    expect(() => approvals.getApproval("bob", first!.id)).toThrow(/not found/);

    approvals.decide("alice", first!.id, "approve");
    approvals.decide("alice", second!.id, "reject");
    expect(org.getAgent("alice", good.id).status).toBe("idle");
    expect(org.getAgent("alice", bad.id).status).toBe("terminated");
    expect(() => approvals.decide("alice", first!.id, "reject")).toThrow(/already approved/);
  });

  it("turns a budget hard stop into an override request", async () => {
    const { approvals, budget, rt, work, org } = await boot();
    const c = org.createCompany("alice", { name: "Budget" });
    const a = org.createAgent("alice", c.id, { name: "A", heartbeat: { wakeOnAssign: false } });
    work.createTask("alice", c.id, { title: "T", assigneeAgentId: a.id });
    budget.upsertPolicy("alice", c.id, { scopeType: "agent", scopeId: a.id, amountUsd: 0.001 });
    rt.registerAdapter("nexus", async (ctx) => {
      ctx.run.steps.push({
        provider: "x",
        model: "unpriced",
        inputTokens: 1000,
        outputTokens: 500,
        latencyMs: 1,
        cached: false,
      });
      return { ok: true, output: reply("x", { status: "in_progress" }) };
    });
    rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    expect(org.getAgent("alice", a.id).status).toBe("paused");
    const [req] = approvals.listApprovals("alice", c.id, "pending");
    expect(req!.type).toBe("budget_override");
    approvals.decide("alice", req!.id, "approve", { amountUsd: 5 });
    expect(org.getAgent("alice", a.id).status).toBe("idle");
    expect(budget.budgetOverview("alice", c.id).policies[0]!.amountMicros).toBe(5_000_000);
  });

  it("gates a planning task on plan approval, with a revision loop", async () => {
    const { approvals, rt, work, org } = await boot();
    const c = org.createCompany("alice", { name: "Plans" });
    const a = org.createAgent("alice", c.id, {
      name: "Planner",
      heartbeat: { wakeOnAssign: false },
    });
    const t = work.createTask("alice", c.id, {
      title: "Launch",
      assigneeAgentId: a.id,
      workMode: "planning",
    });
    let n = 0;
    rt.registerAdapter("nexus", async (ctx) => {
      n++;
      if (ctx.task?.workMode === "standard")
        return { ok: true, output: reply("Built it", { status: "done" }) };
      return { ok: true, output: reply(`Plan v${n}`, { status: "done" }) };
    });
    rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    let [plan] = approvals.listApprovals("alice", c.id, "pending");
    expect(plan).toMatchObject({ type: "plan", body: "Plan v1" });

    expect(() => approvals.decide("alice", plan!.id, "request_revision")).toThrow(/Say what/);
    approvals.decide("alice", plan!.id, "request_revision", { note: "add a budget" });
    await rt.idle();
    [plan] = approvals.listApprovals("alice", c.id, "pending");
    expect(plan!.body).toBe("Plan v2");
    expect(work.listComments("alice", t.id).map((x) => x.body)).toContain(
      "Revise the plan: add a budget",
    );

    approvals.decide("alice", plan!.id, "approve");
    await rt.idle();
    expect(work.getTask("alice", t.id)).toMatchObject({ workMode: "standard", status: "done" });
  });

  it("files an agent's own request and wakes it with the answer", async () => {
    const { approvals, rt, work, org } = await boot();
    const c = org.createCompany("alice", { name: "Asks" });
    const a = org.createAgent("alice", c.id, {
      name: "Mailer",
      heartbeat: { wakeOnAssign: false },
    });
    const t = work.createTask("alice", c.id, { title: "Email customers", assigneeAgentId: a.id });
    const seen: string[] = [];
    rt.registerAdapter("nexus", async (ctx) => {
      seen.push(ctx.run.source);
      return ctx.run.source === "approval"
        ? { ok: true, output: reply("Sent.", { status: "done" }) }
        : {
            ok: true,
            output: reply("Draft ready.", {
              status: "in_progress",
              approval: { title: "Send to 2,000 customers", reason: "External email" },
            }),
          };
    });
    rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    expect(work.getTask("alice", t.id).status).toBe("blocked");
    const [ask] = approvals.listApprovals("alice", c.id, "pending");
    expect(ask).toMatchObject({ type: "action", title: "Mailer asks: Send to 2,000 customers" });
    approvals.decide("alice", ask!.id, "approve", { note: "go" });
    await rt.idle();
    expect(seen).toEqual(["manual", "approval"]);
    expect(work.getTask("alice", t.id).status).toBe("done");
  });

  it("lets an agent propose a hire that always waits for the board", async () => {
    const { approvals, rt, work, org } = await boot();
    const c = org.createCompany("alice", { name: "Grow" });
    const lead = org.createAgent("alice", c.id, {
      name: "Lead",
      heartbeat: { wakeOnAssign: false },
    });
    work.createTask("alice", c.id, { title: "Ship docs", assigneeAgentId: lead.id });
    rt.registerAdapter("nexus", async () => ({
      ok: true,
      output: reply("Need a writer.", {
        status: "in_progress",
        hire: [{ name: "Scribe", role: "writer", capabilities: "Docs" }],
      }),
    }));
    rt.enqueueWake("alice", lead.id, { source: "manual" });
    await rt.idle();
    const scribe = org.listAgents("alice", c.id).find((a) => a.name === "Scribe")!;
    expect(scribe).toMatchObject({
      status: "pending_approval",
      reportsTo: lead.id,
      role: "writer",
    });
    const [ask] = approvals.listApprovals("alice", c.id, "pending");
    expect(ask).toMatchObject({ type: "hire_agent", requestedBy: { type: "agent", id: lead.id } });
    approvals.decide("alice", ask!.id, "approve");
    expect(org.getAgent("alice", scribe.id).status).toBe("idle");
  });

  it("attaches a council verdict and books its cost", async () => {
    const { approvals, budget, org } = await boot();
    const c = org.createCompany("alice", {
      name: "Council",
      requireHireApproval: true,
      councilReviewsApprovals: true,
    });
    const asked: string[] = [];
    approvals.setCouncilRunner(async (_owner, req) => {
      asked.push(req.proposal.title);
      return {
        ok: true,
        result: {
          proposalId: "p",
          title: req.proposal.title,
          outcome: "rejected",
          votes: [
            {
              model: "skeptic",
              provider: "x",
              vote: "no",
              reasoning: "No clear role.",
              confidence: 0.8,
              latencyMs: 1,
            },
          ],
          consensus: 0.8,
          dissent: 0.2,
          majority: "no",
          summary: "Reject: role unclear.",
          deliberatedAt: new Date().toISOString(),
          totalLatencyMs: 1,
          totalCostUsd: 0.002,
        },
      };
    });
    org.createAgent("alice", c.id, { name: "Vague" });
    await vi.waitFor(() =>
      expect(approvals.listApprovals("alice", c.id)[0]!.review?.status).toBe("done"),
    );
    const [a] = approvals.listApprovals("alice", c.id);
    expect(a!.review).toMatchObject({ verdict: "reject", summary: "Reject: role unclear." });
    expect(asked[0]).toMatch(/Hire Vague/);
    expect(budget.budgetOverview("alice", c.id).spend.monthMicros).toBe(2000);
  });

  it("lets the council check work before it counts as done", async () => {
    const { approvals, rt, work, org } = await boot();
    const c = org.createCompany("alice", { name: "Gate Co", councilGatesDone: true });
    const a = org.createAgent("alice", c.id, { name: "Dev", heartbeat: { wakeOnAssign: false } });
    const verdicts = ["rejected", "approved"];
    approvals.setCouncilRunner(async (_owner, req) => ({
      ok: true,
      result: {
        proposalId: "p",
        title: req.proposal.title,
        outcome: verdicts.shift() as "approved" | "rejected",
        votes: [],
        consensus: 1,
        dissent: 0,
        majority: "yes",
        summary: "Checked the tests.",
        deliberatedAt: new Date().toISOString(),
        totalLatencyMs: 1,
        totalCostUsd: 0,
      },
    }));
    let runs = 0;
    rt.registerAdapter("nexus", async () => {
      runs++;
      return { ok: true, output: reply(`Attempt ${runs}`, { status: "done" }) };
    });
    const t = work.createTask("alice", c.id, { title: "Ship it", assigneeAgentId: a.id });
    rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    // Sent back: the task returns to the agent, who is woken and tries again.
    await vi.waitFor(() => expect(runs).toBe(2));
    await rt.idle();
    await vi.waitFor(() => expect(work.getTask("alice", t.id).status).toBe("done"));
    const said = work.listComments("alice", t.id).map((x) => x.body);
    expect(said.filter((b) => b.startsWith("The council sent this back"))).toHaveLength(1);
    expect(said.at(-1)).toMatch(/^The council passed this/);

    const quick = work.createTask("alice", c.id, {
      title: "Quick answer",
      assigneeAgentId: a.id,
      workMode: "ask",
    });
    rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    expect(work.getTask("alice", quick.id).status).toBe("done");
  });

  it("books the council's spend even when the board moves the task mid-check", async () => {
    const { approvals, budget, rt, work, org } = await boot();
    const c = org.createCompany("alice", { name: "Race Co", councilGatesDone: true });
    const a = org.createAgent("alice", c.id, { name: "Dev", heartbeat: { wakeOnAssign: false } });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    approvals.setCouncilRunner(async (_owner, req) => {
      await held;
      return {
        ok: true,
        result: {
          proposalId: "p",
          title: req.proposal.title,
          outcome: "approved",
          votes: [],
          consensus: 1,
          dissent: 0,
          majority: "yes",
          summary: "ok",
          deliberatedAt: new Date().toISOString(),
          totalLatencyMs: 1,
          totalCostUsd: 0.25,
        },
      };
    });
    rt.registerAdapter("nexus", async () => ({
      ok: true,
      output: reply("Done", { status: "done" }),
    }));
    const t = work.createTask("alice", c.id, { title: "Race it", assigneeAgentId: a.id });
    rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    await vi.waitFor(() => expect(work.getTask("alice", t.id).status).toBe("in_review"));
    work.setTaskStatus("alice", t.id, "cancelled");
    release();
    await vi.waitFor(() =>
      expect(budget.budgetOverview("alice", c.id).spend.monthMicros).toBe(250_000),
    );
    expect(work.getTask("alice", t.id).status).toBe("cancelled");
  });
});
