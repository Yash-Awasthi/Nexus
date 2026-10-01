// SPDX-License-Identifier: Apache-2.0
/**
 * An agent's record is arithmetic over its runs and tasks; a council review
 * reads its recent output, keeps the verdict and books the cost.
 */

import { describe, it, expect } from "vitest";

import { bootOrg, useOrgDataDir } from "./org-test-env.js";

useOrgDataDir();

describe("agent performance", () => {
  it("scores the record and keeps the council's verdict", async () => {
    const { perf, budget, rt, work, org } = await bootOrg(async () => ({
      perf: await import("../../src/lib/org-performance.js"),
      budget: await import("../../src/lib/org-budget.js"),
    }));

    const c = org.createCompany("alice", { name: "Perf Co" });
    const a = org.createAgent("alice", c.id, { name: "A", heartbeat: { wakeOnAssign: false } });
    let n = 0;
    rt.registerAdapter("nexus", async (ctx) => {
      n++;
      ctx.run.steps.push({
        provider: "x",
        model: "m1",
        inputTokens: 1000,
        outputTokens: 0,
        latencyMs: 1,
        cached: false,
      });
      if (n === 2) throw new Error("flaky");
      return { ok: true, output: 'Good work\n```json\n{"status":"done","summary":"did it"}\n```' };
    });
    for (const title of ["one", "two", "three"]) {
      work.createTask("alice", c.id, { title, assigneeAgentId: a.id });
      rt.enqueueWake("alice", a.id, { source: "manual" });
      await rt.idle();
    }
    const rec = perf.agentRecord("alice", a.id);
    expect(rec).toMatchObject({
      runs: 3,
      succeeded: 2,
      failed: 1,
      tasksDone: 2,
      byModel: { m1: 3 },
    });
    expect(rec.successRate).toBeCloseTo(2 / 3);
    expect(rec.costPerDoneTaskUsd).toBeCloseTo(0.0015, 6);
    expect(() => perf.agentRecord("bob", a.id)).toThrow(/not found/);

    await expect(perf.reviewAgent("alice", a.id)).rejects.toThrow(/not available/);
    perf.setPerformanceCouncil(async (_o, req) => {
      expect(req.proposal.description).toContain("Good work");
      return {
        ok: true,
        result: {
          proposalId: "p",
          title: "t",
          outcome: "approved",
          consensus: 0.9,
          dissent: 0.1,
          majority: "yes",
          summary: "Solid.",
          deliberatedAt: "",
          totalLatencyMs: 1,
          totalCostUsd: 0.003,
          votes: [
            {
              model: "m",
              provider: "x",
              vote: "yes",
              reasoning: "Fine",
              confidence: 0.9,
              latencyMs: 1,
            },
          ],
        },
      };
    });
    const review = await perf.reviewAgent("alice", a.id);
    expect(review).toMatchObject({ verdict: "strong", summary: "Solid." });
    expect(perf.agentRecord("alice", a.id).review?.verdict).toBe("strong");
    expect(budget.budgetOverview("alice", c.id).spend.monthMicros).toBe(6000);
  });
});
