// SPDX-License-Identifier: Apache-2.0
/**
 * The company overview: what is happening, what needs the board, and what it
 * costs — one read for the screen a phone opens first. Pure aggregation over
 * the other org modules; it stores nothing.
 */

import { listApprovals as listExecApprovals } from "./exec-approvals.js";
import { listApprovals } from "./org-approvals.js";
import { budgetOverview, toUsd } from "./org-budget.js";
import { allRuns } from "./org-runtime.js";
import { getCompany, listActivity, listAgents, listCompanies } from "./org-store.js";
import { listTasks, TASK_STATUSES } from "./org-work.js";

const DAY_MS = 86_400_000;

export function companyOverview(ownerId: string, companyId: string) {
  const company = getCompany(ownerId, companyId);
  const agents = listAgents(ownerId, companyId).filter((a) => a.status !== "terminated");
  const tasks = listTasks(ownerId, companyId);
  const runs = allRuns().filter((r) => r.ownerId === ownerId && r.companyId === companyId);
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const titles = new Map(tasks.map((t) => [t.id, `${t.identifier} ${t.title}`]));
  const since = Date.now() - DAY_MS;

  const byStatus = <T extends string>(keys: readonly T[], vals: T[]) =>
    Object.fromEntries(keys.map((k) => [k, vals.filter((v) => v === k).length])) as Record<
      T,
      number
    >;

  const days: { day: string; runs: number; failed: number; costUsd: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
    const those = runs.filter((r) => r.queuedAt.startsWith(day) && r.status !== "skipped");
    days.push({
      day,
      runs: those.length,
      failed: those.filter((r) => r.status === "failed" || r.status === "timed_out").length,
      costUsd: those.reduce((s, r) => s + r.costUsd, 0),
    });
  }

  const budget = budgetOverview(ownerId, companyId);
  const pendingApprovals = listApprovals(ownerId, companyId, "pending");
  const failedRecent = runs.filter(
    (r) => (r.status === "failed" || r.status === "timed_out") && Date.parse(r.queuedAt) > since,
  );

  return {
    company,
    needsYou: {
      approvals: pendingApprovals
        .slice(0, 5)
        .map((a) => ({ id: a.id, title: a.title, type: a.type })),
      approvalCount: pendingApprovals.length,
      commandApprovals: listExecApprovals(ownerId).filter((x) => x.status === "pending").length,
      reviews: tasks
        .filter((t) => t.status === "in_review")
        .slice(0, 5)
        .map((t) => ({ id: t.id, title: `${t.identifier} ${t.title}` })),
      blocked: tasks
        .filter((t) => t.status === "blocked")
        .slice(0, 5)
        .map((t) => ({ id: t.id, title: `${t.identifier} ${t.title}` })),
      failedRuns: failedRecent.slice(0, 5).map((r) => ({
        id: r.id,
        agent: names.get(r.agentId) ?? "agent",
        error: (r.error ?? "").slice(0, 200),
      })),
      budgetStops: budget.incidents.filter((i) => i.status === "open" && i.threshold === "hard")
        .length,
    },
    workingNow: runs
      .filter((r) => r.status === "running" || r.status === "queued")
      .map((r) => ({
        id: r.id,
        agent: names.get(r.agentId) ?? "agent",
        task: r.taskId ? (titles.get(r.taskId) ?? null) : null,
        status: r.status,
        startedAt: r.startedAt ?? r.queuedAt,
      })),
    agents: byStatus(
      ["idle", "running", "paused", "error", "pending_approval"] as const,
      agents.map((a) => a.status as "idle"),
    ),
    tasks: byStatus(
      TASK_STATUSES,
      tasks.map((t) => t.status),
    ),
    spend: {
      todayUsd: toUsd(budget.spend.dayMicros),
      monthUsd: toUsd(budget.spend.monthMicros),
      lifetimeUsd: toUsd(budget.spend.lifetimeMicros),
    },
    days,
    activity: listActivity(ownerId, companyId, 8),
  };
}

/** One line per company for the portfolio strip. */
export function portfolio(ownerId: string) {
  return listCompanies(ownerId).map((c) => {
    const agents = listAgents(ownerId, c.id);
    const budget = budgetOverview(ownerId, c.id);
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      running: agents.filter((a) => a.status === "running").length,
      agents: agents.filter((a) => a.status !== "terminated").length,
      pendingApprovals: listApprovals(ownerId, c.id, "pending").length,
      monthUsd: toUsd(budget.spend.monthMicros),
    };
  });
}
