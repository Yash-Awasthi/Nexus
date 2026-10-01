// SPDX-License-Identifier: Apache-2.0
/**
 * The overview counts what needs the board and what the org did, per company
 * and across the owner's portfolio, and never another owner's rows.
 */

import { describe, it, expect } from "vitest";

import { bootOrg, useOrgDataDir } from "./org-test-env.js";

useOrgDataDir();

describe("org overview", () => {
  it("summarises needs, work and spend for one company and the portfolio", async () => {
    const { overview, rt, work, org } = await bootOrg(async () => ({
      overview: await import("../../src/lib/org-overview.js"),
    }));

    const c = org.createCompany("alice", { name: "Look Co", requireHireApproval: true });
    org.createCompany("alice", { name: "Second" });
    org.createCompany("bob", { name: "Not yours" });
    org.createAgent("alice", c.id, { name: "Pending" });
    const c2 = org.updateCompany("alice", c.id, { requireHireApproval: false });
    const a = org.createAgent("alice", c2.id, { name: "Doer", heartbeat: { wakeOnAssign: false } });
    const review = work.createTask("alice", c.id, { title: "Check me", assigneeAgentId: a.id });
    work.createTask("alice", c.id, { title: "Stuck", assigneeAgentId: a.id });
    rt.registerAdapter("nexus", async (ctx) => {
      ctx.run.steps.push({
        provider: "x",
        model: "unpriced",
        inputTokens: 1000,
        outputTokens: 0,
        latencyMs: 1,
        cached: false,
      });
      return ctx.task?.title === "Stuck"
        ? { ok: false, output: "", error: "boom" }
        : { ok: true, output: 'done\n```json\n{"status":"in_review"}\n```' };
    });
    rt.enqueueWake("alice", a.id, { source: "manual", taskId: review.id });
    await rt.idle();
    rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();

    const o = overview.companyOverview("alice", c.id);
    expect(o.needsYou.approvalCount).toBe(1);
    expect(o.needsYou.reviews.map((r) => r.title)).toEqual(["LC-1 Check me"]);
    expect(o.needsYou.failedRuns).toMatchObject([{ agent: "Doer", error: "boom" }]);
    expect(o.agents).toMatchObject({ error: 1, pending_approval: 1 });
    expect(o.tasks.in_review).toBe(1);
    expect(o.days).toHaveLength(14);
    expect(o.days.at(-1)).toMatchObject({ runs: 2, failed: 1 });
    expect(o.spend.todayUsd).toBeCloseTo(0.002, 6);

    const p = overview.portfolio("alice");
    expect(p.map((x) => x.name)).toEqual(["Look Co", "Second"]);
    expect(p[0]).toMatchObject({ pendingApprovals: 1, agents: 2 });
    expect(() => overview.companyOverview("bob", c.id)).toThrow(/not found/);
  });
});
