// SPDX-License-Identifier: Apache-2.0
/**
 * How well an agent works: its record from run history, and on request a
 * council review of its recent output. The record is arithmetic over runs and
 * tasks; the review asks several personas on the owner's own models whether
 * the work is good, and keeps the latest verdict with the agent.
 */

import type { CouncilRequest, CouncilResponse } from "@nexus/contracts";

import { bookCompanySpend, companyHeadroomUsd } from "./org-budget.js";
import { allRuns } from "./org-runtime.js";
import { OrgError, getAgent, getCompany, onOrgLoad, registerCompanyScoped } from "./org-store.js";
import { getTask, listTasks } from "./org-work.js";
import { PersistentStore } from "./persistent-store.js";

export interface PerformanceReview {
  id: string;
  ownerId: string;
  companyId: string;
  verdict: "strong" | "weak" | "mixed";
  consensus: number;
  summary: string;
  votes: { member: string; vote: string; reasoning: string }[];
  costUsd: number;
  at: string;
}

const reviews = new PersistentStore<PerformanceReview>("org_reviews");
registerCompanyScoped(reviews);
onOrgLoad(() => reviews.load());

type CouncilRunner = (ownerId: string, request: CouncilRequest) => Promise<CouncilResponse>;
let council: CouncilRunner | null = null;
export function setPerformanceCouncil(r: CouncilRunner): void {
  council = r;
}

export function agentRecord(ownerId: string, agentId: string) {
  const agent = getAgent(ownerId, agentId);
  const runs = allRuns()
    .filter((r) => r.ownerId === ownerId && r.agentId === agentId)
    .sort((a, b) => b.seq - a.seq);
  const worked = runs.filter((r) => r.status !== "skipped" && r.status !== "queued");
  const ok = worked.filter((r) => r.status === "succeeded");
  const done = listTasks(ownerId, agent.companyId, { assigneeAgentId: agentId, status: "done" });
  const cost = worked.reduce((s, r) => s + r.costUsd, 0);
  const durations = worked
    .filter((r) => r.startedAt && r.finishedAt)
    .map((r) => (Date.parse(r.finishedAt!) - Date.parse(r.startedAt!)) / 1000);
  const byModel: Record<string, number> = {};
  for (const r of worked) if (r.model) byModel[r.model] = (byModel[r.model] ?? 0) + 1;
  return {
    agentId,
    runs: worked.length,
    succeeded: ok.length,
    failed: worked.filter((r) => r.status === "failed" || r.status === "timed_out").length,
    skipped: runs.filter((r) => r.status === "skipped").length,
    successRate: worked.length ? ok.length / worked.length : null,
    tasksDone: done.length,
    totalCostUsd: cost,
    costPerDoneTaskUsd: done.length ? cost / done.length : null,
    avgDurationSec: durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : null,
    byModel,
    recent: runs.slice(0, 10).map((r) => ({
      id: r.id,
      status: r.status,
      summary: r.outcome?.summary ?? r.error ?? "",
      costUsd: r.costUsd,
      at: r.queuedAt,
    })),
    review: reviews.get(agentId) ?? null,
  };
}

/** Ask the council whether this agent's recent work is good. Its cost is booked to the company. */
export async function reviewAgent(ownerId: string, agentId: string): Promise<PerformanceReview> {
  const agent = getAgent(ownerId, agentId);
  const company = getCompany(ownerId, agent.companyId);
  if (!council) throw new OrgError(503, "unavailable", "The council is not available.");
  const record = agentRecord(ownerId, agentId);
  const samples = allRuns()
    .filter(
      (r) => r.ownerId === ownerId && r.agentId === agentId && r.status === "succeeded" && r.output,
    )
    .sort((a, b) => b.seq - a.seq)
    .slice(0, 4);
  if (samples.length === 0)
    throw new OrgError(409, "conflict", "This agent has no finished work to review yet.");
  const headroom = companyHeadroomUsd(ownerId, company.id);
  if (headroom !== null && headroom <= 0)
    throw new OrgError(409, "conflict", "The company budget has no room for a review.");

  const work = samples.map((r) => {
    let task = "(triage)";
    try {
      if (r.taskId) task = getTask(ownerId, r.taskId).title;
    } catch {
      /* task gone */
    }
    return `Task: ${task}\nOutput: ${r.output.slice(0, 1200)}`;
  });
  const res = await council(ownerId, {
    proposal: {
      title: `Is ${agent.name} (${agent.title || agent.role}) doing good work?`,
      description: [
        `Company mission: ${company.mission || "(none)"}`,
        `Role: ${agent.role}. Strengths claimed: ${agent.capabilities || "(none)"}`,
        `Record: ${record.succeeded}/${record.runs} runs succeeded, ${record.tasksDone} tasks done, $${record.totalCostUsd.toFixed(4)} spent.`,
        "Recent work:",
        ...work,
        "Vote yes if the work is good for the role and the mission, no if not. Name the biggest improvement in your reasoning.",
      ]
        .join("\n\n")
        .slice(0, 9500),
    },
    budgetUsd: Math.min(0.05, headroom ?? 0.05),
    councilSize: 3,
    timeoutMs: 120_000,
  });
  if (!res.ok || !res.result)
    throw new OrgError(502, "council_failed", res.error ?? "The council did not answer.");
  const r = res.result;
  bookCompanySpend(ownerId, company.id, r.totalCostUsd);
  const review: PerformanceReview = {
    id: agentId,
    ownerId,
    companyId: company.id,
    verdict: r.outcome === "approved" ? "strong" : r.outcome === "rejected" ? "weak" : "mixed",
    consensus: r.consensus,
    summary: r.summary,
    votes: r.votes.map((v) => ({
      member: v.model,
      vote: v.vote,
      reasoning: v.reasoning.slice(0, 1500),
    })),
    costUsd: r.totalCostUsd,
    at: new Date().toISOString(),
  };
  reviews.set(agentId, review);
  return review;
}
