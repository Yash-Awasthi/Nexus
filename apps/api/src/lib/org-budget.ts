// SPDX-License-Identifier: Apache-2.0
/**
 * Budgets for a company, an agent or a goal, with warnings and hard stops.
 *
 * Spend lands in a ledger keyed by scope and window (day, UTC month,
 * lifetime) as each run settles, so a budget check is one lookup and survives
 * run-history pruning. Crossing the warning share opens a soft incident;
 * crossing the limit opens a hard one, pauses the scope and cancels its queued
 * runs. Raising the limit above observed spend lifts the pause.
 *
 * Unlike a post-hoc check, the stop also holds *during* a run: before each
 * model call the native adapter asks `callAllowance`, which prices the call at
 * its worst case (prompt plus the full output allowance) and refuses one that
 * could cross the limit.
 *
 * Policy, incident and hard-stop semantics are ported from Paperclip's budget
 * service — https://github.com/paperclipai/paperclip, MIT License,
 * Copyright (c) 2025 Paperclip AI.
 */

import crypto from "node:crypto";

import { priceOf } from "./cost-log.js";
import { createNotification } from "./notifications-store.js";
import {
  addCallGuard,
  addRunGate,
  allRuns,
  cancelRun,
  onRunFinished,
  stepsCostUsd,
  type Run,
} from "./org-runtime.js";
import {
  OrgError,
  getAgent,
  getCompany,
  invalid,
  listAgents,
  logActivity,
  notFound,
  now,
  onOrgLoad,
  registerCompanyScoped,
  setAgentStatus,
  setCompanyStatus,
  type Agent,
} from "./org-store.js";
import { getGoal, getTask, whyChain, type Task } from "./org-work.js";
import { PersistentStore } from "./persistent-store.js";

export const SCOPE_TYPES = ["company", "agent", "goal"] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];
export const WINDOWS = ["day", "month", "lifetime"] as const;
export type WindowKind = (typeof WINDOWS)[number];

export interface BudgetPolicy {
  id: string;
  ownerId: string;
  companyId: string;
  scopeType: ScopeType;
  scopeId: string;
  windowKind: WindowKind;
  /** Limit in micro-dollars (1e-6 USD); agent runs often cost fractions of a cent. */
  amountMicros: number;
  warnPercent: number;
  hardStop: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetIncident {
  id: string;
  ownerId: string;
  companyId: string;
  policyId: string;
  scopeType: ScopeType;
  scopeId: string;
  windowKey: string;
  threshold: "soft" | "hard";
  limitMicros: number;
  observedMicros: number;
  status: "open" | "resolved" | "dismissed";
  createdAt: string;
  resolvedAt: string | null;
}

interface SpendRow {
  id: string;
  companyId: string;
  micros: number;
}

const policies = new PersistentStore<BudgetPolicy>("org_budget_policies");
const incidents = new PersistentStore<BudgetIncident>("org_budget_incidents");
const spend = new PersistentStore<SpendRow>("org_spend");
registerCompanyScoped(policies);
registerCompanyScoped(incidents);
registerCompanyScoped(spend);
onOrgLoad(() =>
  Promise.all([policies.load(), incidents.load(), spend.load()]).then(() => undefined),
);

export const toMicros = (usd: number) => Math.round(usd * 1_000_000);
export const toUsd = (micros: number) => micros / 1_000_000;

export function windowKey(kind: WindowKind, at = new Date()): string {
  if (kind === "lifetime") return "all";
  const iso = at.toISOString();
  return kind === "day" ? iso.slice(0, 10) : iso.slice(0, 7);
}

const spendId = (companyId: string, scope: ScopeType, scopeId: string, key: string) =>
  `${companyId}:${scope}:${scopeId}:${key}`;

export function observed(
  companyId: string,
  scope: ScopeType,
  scopeId: string,
  kind: WindowKind,
): number {
  return spend.get(spendId(companyId, scope, scopeId, windowKey(kind)))?.micros ?? 0;
}

/** The scopes one run's spend counts against: company, agent, and every goal up its task's chain. */
function scopesOf(ownerId: string, companyId: string, agentId: string, task: Task | null) {
  const out: { scope: ScopeType; id: string }[] = [
    { scope: "company", id: companyId },
    { scope: "agent", id: agentId },
  ];
  if (task) for (const g of whyChain(ownerId, task).goals) out.push({ scope: "goal", id: g.id });
  return out;
}

function taskOf(ownerId: string, taskId: string | null): Task | null {
  if (!taskId) return null;
  try {
    return getTask(ownerId, taskId);
  } catch {
    return null;
  }
}

// ── Policies ─────────────────────────────────────────────────────────────────

export interface PolicyInput {
  scopeType?: unknown;
  scopeId?: unknown;
  windowKind?: unknown;
  amountUsd?: unknown;
  warnPercent?: unknown;
  hardStop?: unknown;
}

function scopeName(ownerId: string, p: Pick<BudgetPolicy, "scopeType" | "scopeId">): string {
  try {
    if (p.scopeType === "company") return getCompany(ownerId, p.scopeId).name;
    if (p.scopeType === "agent") return getAgent(ownerId, p.scopeId).name;
    return getGoal(ownerId, p.scopeId).title;
  } catch {
    return "(removed)";
  }
}

/** One policy per scope and window: setting it again replaces the limit. */
export function upsertPolicy(ownerId: string, companyId: string, input: PolicyInput): BudgetPolicy {
  getCompany(ownerId, companyId);
  const scopeType = input.scopeType ?? "company";
  if (!SCOPE_TYPES.includes(scopeType as ScopeType))
    throw invalid("scopeType must be company, agent or goal.");
  const windowKind = input.windowKind ?? "month";
  if (!WINDOWS.includes(windowKind as WindowKind))
    throw invalid("windowKind must be day, month or lifetime.");
  const scopeId = scopeType === "company" ? companyId : String(input.scopeId ?? "");
  if (scopeType === "agent" && getAgent(ownerId, scopeId).companyId !== companyId)
    throw invalid("That agent is not in this company.");
  if (scopeType === "goal" && getGoal(ownerId, scopeId).companyId !== companyId)
    throw invalid("That goal is not in this company.");
  const amount = Number(input.amountUsd);
  if (!Number.isFinite(amount) || amount < 0) throw invalid("amountUsd must be zero or more.");
  const warn = input.warnPercent === undefined ? 80 : Number(input.warnPercent);
  if (!Number.isInteger(warn) || warn < 1 || warn > 100)
    throw invalid("warnPercent must be 1–100.");

  const existing = [...policies.values()].find(
    (p) =>
      p.ownerId === ownerId &&
      p.companyId === companyId &&
      p.scopeType === scopeType &&
      p.scopeId === scopeId &&
      p.windowKind === windowKind,
  );
  const policy: BudgetPolicy = {
    id: existing?.id ?? crypto.randomUUID(),
    ownerId,
    companyId,
    scopeType: scopeType as ScopeType,
    scopeId,
    windowKind: windowKind as WindowKind,
    amountMicros: toMicros(amount),
    warnPercent: warn,
    hardStop: input.hardStop !== false,
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
  };
  policies.set(policy.id, policy);
  logActivity(getCompany(ownerId, companyId), {
    actorType: "user",
    actorId: ownerId,
    action: existing ? "budget.updated" : "budget.created",
    entityType: "budget",
    entityId: policy.id,
    details: { name: scopeName(ownerId, policy), limitUsd: amount, window: policy.windowKind },
  });
  // A raised limit may already clear a hard stop.
  evaluate(policy);
  return policy;
}

export function deletePolicy(ownerId: string, id: string): void {
  const p = policies.get(id);
  if (!p || p.ownerId !== ownerId) throw notFound("Budget");
  policies.delete(id);
  for (const i of incidents.values())
    if (i.policyId === id && i.status === "open")
      incidents.set(i.id, { ...i, status: "dismissed", resolvedAt: now() });
}

export function listPolicies(ownerId: string, companyId: string): BudgetPolicy[] {
  return companyPolicies(ownerId, companyId);
}

function companyPolicies(ownerId: string, companyId: string): BudgetPolicy[] {
  return [...policies.values()].filter((p) => p.ownerId === ownerId && p.companyId === companyId);
}

export type BudgetState = "ok" | "warning" | "hard_stop";

function stateOf(p: BudgetPolicy): { observedMicros: number; state: BudgetState } {
  const o = observed(p.companyId, p.scopeType, p.scopeId, p.windowKind);
  if (p.amountMicros <= 0) return { observedMicros: o, state: "ok" };
  if (o >= p.amountMicros)
    return { observedMicros: o, state: p.hardStop ? "hard_stop" : "warning" };
  if (o >= Math.ceil((p.amountMicros * p.warnPercent) / 100))
    return { observedMicros: o, state: "warning" };
  return { observedMicros: o, state: "ok" };
}

// ── Incidents and enforcement ────────────────────────────────────────────────

function openIncident(
  p: BudgetPolicy,
  threshold: "soft" | "hard",
  observedMicros: number,
): BudgetIncident | null {
  const key = windowKey(p.windowKind);
  const exists = [...incidents.values()].some(
    (i) =>
      i.policyId === p.id &&
      i.windowKey === key &&
      i.threshold === threshold &&
      i.status !== "dismissed",
  );
  if (exists) return null;
  const inc: BudgetIncident = {
    id: crypto.randomUUID(),
    ownerId: p.ownerId,
    companyId: p.companyId,
    policyId: p.id,
    scopeType: p.scopeType,
    scopeId: p.scopeId,
    windowKey: key,
    threshold,
    limitMicros: p.amountMicros,
    observedMicros,
    status: "open",
    createdAt: now(),
    resolvedAt: null,
  };
  incidents.set(inc.id, inc);
  return inc;
}

/** Hooks other modules attach to a new hard stop (the approvals inbox). */
const hardStopListeners: ((incident: BudgetIncident) => void)[] = [];
export function onHardStop(l: (incident: BudgetIncident) => void): void {
  hardStopListeners.push(l);
}

function pauseScope(p: BudgetPolicy): void {
  const sys = { actorType: "system" as const, actorId: "budget", reason: "budget" as const };
  if (p.scopeType === "company") {
    const c = getCompany(p.ownerId, p.companyId);
    if (c.status === "active") setCompanyStatus(p.ownerId, c.id, "paused", sys);
  } else if (p.scopeType === "agent") {
    const a = getAgent(p.ownerId, p.scopeId);
    if (a.status === "idle" || a.status === "running" || a.status === "error")
      setAgentStatus(p.ownerId, a.id, "paused", sys);
  }
  // A goal has no status to pause; the run gate refuses its tasks instead.
  for (const r of allRuns())
    if (r.ownerId === p.ownerId && r.companyId === p.companyId && r.status === "queued")
      if (p.scopeType === "company" || (p.scopeType === "agent" && r.agentId === p.scopeId))
        cancelRun(p.ownerId, r.id);
}

function resumeScope(p: BudgetPolicy): void {
  const sys = { actorType: "system" as const, actorId: "budget", reason: "budget" as const };
  try {
    if (p.scopeType === "company") {
      const c = getCompany(p.ownerId, p.companyId);
      if (c.status === "paused" && c.pauseReason === "budget")
        setCompanyStatus(p.ownerId, c.id, "active", sys);
    } else if (p.scopeType === "agent") {
      const a = getAgent(p.ownerId, p.scopeId);
      if (a.status === "paused" && a.pauseReason === "budget")
        setAgentStatus(p.ownerId, a.id, "idle", { actorType: "system", actorId: "budget" });
    }
  } catch {
    /* scope removed */
  }
}

/** Whether any hard-stop policy on this scope is still at or over its limit. */
function scopeStillOver(p: BudgetPolicy): boolean {
  return companyPolicies(p.ownerId, p.companyId).some(
    (q) =>
      q.scopeType === p.scopeType &&
      q.scopeId === p.scopeId &&
      q.hardStop &&
      q.amountMicros > 0 &&
      observed(q.companyId, q.scopeType, q.scopeId, q.windowKind) >= q.amountMicros,
  );
}

/** Check one policy against its ledger and act on any threshold it crossed. */
function evaluate(p: BudgetPolicy): void {
  const { observedMicros, state } = stateOf(p);
  const company = getCompany(p.ownerId, p.companyId);
  const name = scopeName(p.ownerId, p);
  const pct = p.amountMicros > 0 ? Math.round((observedMicros / p.amountMicros) * 100) : 0;

  if (state !== "hard_stop") {
    // Under the limit (or no longer a hard stop): close this policy's hard incidents,
    // and lift the pause unless a sibling policy still holds it.
    for (const i of incidents.values())
      if (i.policyId === p.id && i.status === "open" && i.threshold === "hard")
        incidents.set(i.id, { ...i, status: "resolved", resolvedAt: now() });
    if (!scopeStillOver(p)) resumeScope(p);
  }

  if (state === "warning" && openIncident(p, "soft", observedMicros)) {
    logActivity(company, {
      actorType: "system",
      actorId: "budget",
      action: "budget.warning",
      entityType: "budget",
      entityId: p.id,
      details: { name, reason: `${pct}% used` },
    });
    void createNotification(p.ownerId, {
      type: "org",
      title: `${name} has used ${pct}% of its ${p.windowKind} budget`,
      link: `/org?c=${p.companyId}&tab=budgets`,
    });
  }

  if (state === "hard_stop") {
    const inc = openIncident(p, "hard", observedMicros);
    pauseScope(p);
    if (inc) {
      logActivity(company, {
        actorType: "system",
        actorId: "budget",
        action: "budget.hard_stop",
        entityType: "budget",
        entityId: p.id,
        details: {
          name,
          reason: `$${toUsd(observedMicros).toFixed(4)} of $${toUsd(p.amountMicros).toFixed(4)}`,
        },
      });
      void createNotification(p.ownerId, {
        type: "org",
        title: `${name} hit its ${p.windowKind} budget and was paused`,
        message: "Raise the budget to resume, or keep it paused.",
        link: `/org?c=${p.companyId}&tab=budgets`,
      });
      for (const l of hardStopListeners) l(inc);
    }
  }
}

/** Book one settled run's spend and re-check every policy it touches. */
/** Book a run's cost, or any spend made on an agent's behalf, to every scope it touches. */
export function recordRunSpend(
  run: Pick<Run, "ownerId" | "companyId" | "agentId" | "taskId" | "costUsd">,
): void {
  const micros = toMicros(run.costUsd);
  if (micros <= 0) return;
  const task = taskOf(run.ownerId, run.taskId);
  for (const { scope, id } of scopesOf(run.ownerId, run.companyId, run.agentId, task)) {
    for (const kind of WINDOWS) {
      const sid = spendId(run.companyId, scope, id, windowKey(kind));
      const row = spend.get(sid) ?? { id: sid, companyId: run.companyId, micros: 0 };
      spend.set(sid, { ...row, micros: row.micros + micros });
    }
  }
  const touched = new Set(scopesOf(run.ownerId, run.companyId, run.agentId, task).map((s) => s.id));
  for (const p of companyPolicies(run.ownerId, run.companyId))
    if (touched.has(p.scopeId)) evaluate(p);
}

onRunFinished(recordRunSpend);

/** Book spend that is not a run (a council review) against the company. */
export function bookCompanySpend(ownerId: string, companyId: string, usd: number): void {
  const micros = toMicros(usd);
  if (micros <= 0) return;
  for (const kind of WINDOWS) {
    const sid = spendId(companyId, "company", companyId, windowKey(kind));
    const row = spend.get(sid) ?? { id: sid, companyId, micros: 0 };
    spend.set(sid, { ...row, micros: row.micros + micros });
  }
  for (const p of companyPolicies(ownerId, companyId)) if (p.scopeType === "company") evaluate(p);
}

/** Dollars left before the tightest company-wide hard stop, or null when none is set. */
export function companyHeadroomUsd(ownerId: string, companyId: string): number | null {
  let least: number | null = null;
  for (const p of companyPolicies(ownerId, companyId)) {
    if (p.scopeType !== "company" || !p.hardStop || p.amountMicros <= 0) continue;
    const left = Math.max(
      0,
      p.amountMicros - observed(companyId, "company", companyId, p.windowKind),
    );
    least = least === null ? left : Math.min(least, left);
  }
  return least === null ? null : toUsd(least);
}

/** Why this agent may not start on this task, from any exhausted hard stop. */
export function budgetBlock(agent: Agent, task: Task | null): string | null {
  const touched = scopesOf(agent.ownerId, agent.companyId, agent.id, task);
  for (const p of companyPolicies(agent.ownerId, agent.companyId)) {
    if (!p.hardStop || p.amountMicros <= 0) continue;
    if (!touched.some((s) => s.scope === p.scopeType && s.id === p.scopeId)) continue;
    if (observed(p.companyId, p.scopeType, p.scopeId, p.windowKind) >= p.amountMicros)
      return `${scopeName(agent.ownerId, p)} is over its ${p.windowKind} budget.`;
  }
  return null;
}

addRunGate(budgetBlock);

/** Worst-case price of one model call: the prompt plus its whole output allowance. */
export function estimateCallMicros(model: string, promptChars: number, maxTokens: number): number {
  const [pi, po] = priceOf(model);
  return toMicros((Math.ceil(promptChars / 4) * pi + maxTokens * po) / 1_000_000);
}

/**
 * Whether the run may make one more call of this worst-case price. Counts what
 * the run has spent so far, which the ledger does not hold until it settles.
 */
export function callAllowance(
  run: Pick<Run, "ownerId" | "companyId" | "agentId" | "steps">,
  task: Task | null,
  callMicros: number,
): string | null {
  const soFar = toMicros(stepsCostUsd(run.steps));
  const touched = scopesOf(run.ownerId, run.companyId, run.agentId, task);
  for (const p of companyPolicies(run.ownerId, run.companyId)) {
    if (!p.hardStop || p.amountMicros <= 0) continue;
    if (!touched.some((s) => s.scope === p.scopeType && s.id === p.scopeId)) continue;
    const o = observed(p.companyId, p.scopeType, p.scopeId, p.windowKind);
    if (o + soFar + callMicros > p.amountMicros)
      return `This call could cost up to $${toUsd(callMicros).toFixed(4)}, which would take ${scopeName(run.ownerId, p)} past its ${p.windowKind} budget ($${toUsd(o + soFar).toFixed(4)} of $${toUsd(p.amountMicros).toFixed(4)} used).`;
  }
  return null;
}

addCallGuard((run, task, model, promptChars, maxTokens) =>
  callAllowance(run, task, estimateCallMicros(model, promptChars, maxTokens)),
);

// ── Reads + resolution ───────────────────────────────────────────────────────

export function budgetOverview(ownerId: string, companyId: string) {
  getCompany(ownerId, companyId);
  const rows = companyPolicies(ownerId, companyId).map((p) => {
    const s = stateOf(p);
    return {
      ...p,
      scopeName: scopeName(ownerId, p),
      observedMicros: s.observedMicros,
      state: s.state,
    };
  });
  const open = [...incidents.values()]
    .filter((i) => i.ownerId === ownerId && i.companyId === companyId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50)
    .map((i) => ({ ...i, scopeName: scopeName(ownerId, i) }));
  const agents = listAgents(ownerId, companyId).map((a) => ({
    agentId: a.id,
    name: a.name,
    monthMicros: observed(companyId, "agent", a.id, "month"),
    lifetimeMicros: observed(companyId, "agent", a.id, "lifetime"),
  }));
  return {
    forecast: forecast(ownerId, companyId),
    policies: rows,
    incidents: open,
    spend: {
      dayMicros: observed(companyId, "company", companyId, "day"),
      monthMicros: observed(companyId, "company", companyId, "month"),
      lifetimeMicros: observed(companyId, "company", companyId, "lifetime"),
      byAgent: agents,
    },
  };
}

/**
 * Where spend is heading: the last seven days' daily average carried to the end
 * of the month, and for each limit the day it would be reached at that pace.
 */
export function forecast(ownerId: string, companyId: string, now = new Date()) {
  getCompany(ownerId, companyId);
  const DAY = 86_400_000;
  let week = 0;
  for (let i = 0; i < 7; i++) {
    const day = new Date(now.getTime() - i * DAY).toISOString().slice(0, 10);
    week += spend.get(spendId(companyId, "company", companyId, day))?.micros ?? 0;
  }
  const perDay = week / 7;
  const endOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const daysLeft = Math.max(0, (endOfMonth - now.getTime()) / DAY);
  const month = observed(companyId, "company", companyId, "month");
  const exhaustion = companyPolicies(ownerId, companyId)
    .filter((p) => p.amountMicros > 0 && p.windowKind !== "day")
    .map((p) => {
      const o = observed(p.companyId, p.scopeType, p.scopeId, p.windowKind);
      // Only company-wide spend has a daily history; scoped limits use their share of it.
      const share = month > 0 && p.scopeType !== "company" ? Math.min(1, o / month) : 1;
      const rate = perDay * share;
      const left = p.amountMicros - o;
      let at: string | null = null;
      if (left <= 0) at = now.toISOString();
      else if (rate > 0) {
        const t = now.getTime() + (left / rate) * DAY;
        if (p.windowKind === "lifetime" || t < endOfMonth) at = new Date(t).toISOString();
      }
      return { policyId: p.id, scopeName: scopeName(ownerId, p), windowKind: p.windowKind, at };
    });
  return {
    perDayUsd: toUsd(perDay),
    projectedMonthUsd: toUsd(month + perDay * daysLeft),
    exhaustion,
  };
}

export function resolveIncident(
  ownerId: string,
  id: string,
  input: { action?: unknown; amountUsd?: unknown },
): BudgetIncident {
  const inc = incidents.get(id);
  if (!inc || inc.ownerId !== ownerId) throw notFound("Budget incident");
  const policy = policies.get(inc.policyId);
  if (input.action === "raise_and_resume") {
    if (!policy) throw new OrgError(409, "conflict", "That budget no longer exists.");
    const amount = Number(input.amountUsd);
    const o = observed(policy.companyId, policy.scopeType, policy.scopeId, policy.windowKind);
    if (!Number.isFinite(amount) || toMicros(amount) <= o)
      throw invalid(`The new budget must be above current spend ($${toUsd(o).toFixed(4)}).`);
    upsertPolicy(ownerId, policy.companyId, {
      scopeType: policy.scopeType,
      scopeId: policy.scopeId,
      windowKind: policy.windowKind,
      amountUsd: amount,
      warnPercent: policy.warnPercent,
      hardStop: policy.hardStop,
    });
    for (const i of incidents.values())
      if (i.policyId === policy.id && i.status === "open")
        incidents.set(i.id, { ...i, status: "resolved", resolvedAt: now() });
    resumeScope(policy);
  } else if (input.action === "dismiss") {
    incidents.set(id, { ...inc, status: "dismissed", resolvedAt: now() });
  } else throw invalid("action must be raise_and_resume or dismiss.");
  return incidents.get(id)!;
}

export function getIncident(ownerId: string, id: string): BudgetIncident {
  const inc = incidents.get(id);
  if (!inc || inc.ownerId !== ownerId) throw notFound("Budget incident");
  return inc;
}
