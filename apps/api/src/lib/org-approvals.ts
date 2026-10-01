// SPDX-License-Identifier: Apache-2.0
/**
 * The board's inbox: decisions agents and the org cannot make alone.
 *
 * Four kinds arrive here — a hire the company holds for approval, a budget
 * hard stop, a plan a planning-mode task produced, and an action an agent
 * asked permission for — and each decision has a defined effect on the thing
 * it governs. Before the human decides, the council can review the request:
 * several personas on the owner's own models vote, and their verdict and
 * reasoning sit next to the approve button. The review is advisory; the
 * board's decision is the one that acts.
 *
 * Approval types, statuses and the revision loop follow Paperclip's approvals
 * service — https://github.com/paperclipai/paperclip, MIT License,
 * Copyright (c) 2025 Paperclip AI.
 */

import crypto from "node:crypto";

import type { CouncilRequest, CouncilResponse } from "@nexus/contracts";

import { createNotification } from "./notifications-store.js";
import {
  bookCompanySpend,
  companyHeadroomUsd,
  getIncident,
  onHardStop,
  resolveIncident,
  toUsd,
} from "./org-budget.js";
import { addDoneGate, enqueueWake, onApprovalRequested } from "./org-runtime.js";
import {
  OrgError,
  getCompany,
  logActivity,
  nextSeq,
  notFound,
  now,
  onAgentHired,
  onOrgLoad,
  registerCompanyScoped,
  setAgentStatus,
} from "./org-store.js";
import {
  addComment,
  getTask,
  listComments,
  orgEvents,
  setTaskStatus,
  updateTask,
  type Actor,
} from "./org-work.js";
import { PersistentStore } from "./persistent-store.js";

export const APPROVAL_TYPES = ["hire_agent", "budget_override", "plan", "action"] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];
export type ApprovalStatus =
  "pending" | "revision_requested" | "approved" | "rejected" | "cancelled";

export interface CouncilReview {
  status: "running" | "done" | "failed";
  verdict: "approve" | "reject" | "revise" | null;
  consensus: number;
  summary: string;
  votes: { member: string; vote: string; confidence: number; reasoning: string }[];
  costUsd: number;
  error: string | null;
  at: string;
}

export interface Approval {
  id: string;
  ownerId: string;
  companyId: string;
  type: ApprovalType;
  status: ApprovalStatus;
  title: string;
  /** What the decision is about, in words the board and the council read. */
  body: string;
  /** Ids of what the decision governs: agentId, taskId, incidentId. */
  subject: { agentId?: string; taskId?: string; incidentId?: string };
  requestedBy: Actor;
  decisionNote: string | null;
  decidedAt: string | null;
  review: CouncilReview | null;
  createdAt: string;
  seq: number;
}

const approvals = new PersistentStore<Approval>("org_approvals");
registerCompanyScoped(approvals);
onOrgLoad(() => approvals.load());

const conflict = (m: string) => new OrgError(409, "conflict", m);

/** Deliberates for an owner; injected so this file stays free of the request stack. */
type CouncilRunner = (ownerId: string, request: CouncilRequest) => Promise<CouncilResponse>;
let council: CouncilRunner | null = null;
export function setCouncilRunner(r: CouncilRunner): void {
  council = r;
}

export function listApprovals(ownerId: string, companyId: string, status?: string): Approval[] {
  getCompany(ownerId, companyId);
  const wanted = status ? new Set(status.split(",")) : null;
  return [...approvals.values()]
    .filter(
      (a) =>
        a.ownerId === ownerId && a.companyId === companyId && (!wanted || wanted.has(a.status)),
    )
    .sort((a, b) => b.seq - a.seq);
}

/** Pending approvals across every company the owner runs: the inbox badge. */
export function pendingCount(ownerId: string): number {
  return [...approvals.values()].filter((a) => a.ownerId === ownerId && a.status === "pending")
    .length;
}

export function getApproval(ownerId: string, id: string): Approval {
  const a = approvals.get(id);
  if (!a || a.ownerId !== ownerId) throw notFound("Approval");
  return a;
}

function file(
  input: Omit<
    Approval,
    "id" | "status" | "decisionNote" | "decidedAt" | "review" | "createdAt" | "seq"
  >,
): Approval {
  const a: Approval = {
    ...input,
    id: crypto.randomUUID(),
    status: "pending",
    decisionNote: null,
    decidedAt: null,
    review: null,
    createdAt: now(),
    seq: nextSeq(),
  };
  approvals.set(a.id, a);
  const company = getCompany(a.ownerId, a.companyId);
  logActivity(company, {
    actorType: a.requestedBy.type,
    actorId: a.requestedBy.id,
    action: "approval.requested",
    entityType: "approval",
    entityId: a.id,
    details: { title: a.title, reason: a.type },
  });
  void createNotification(a.ownerId, {
    type: "org",
    title: `Needs your decision: ${a.title}`,
    link: `/org?c=${a.companyId}&tab=approvals`,
  });
  if (company.councilReviewsApprovals && council) void reviewApproval(a.ownerId, a.id);
  return a;
}

/** One pending approval per governed subject and type; a repeat request reuses it. */
function openFor(ownerId: string, type: ApprovalType, key: keyof Approval["subject"], id: string) {
  return [...approvals.values()].find(
    (a) =>
      a.ownerId === ownerId && a.type === type && a.subject[key] === id && a.status === "pending",
  );
}

// ── Sources ──────────────────────────────────────────────────────────────────

onAgentHired((agent, actor) => {
  if (agent.status !== "pending_approval") return;
  file({
    ownerId: agent.ownerId,
    companyId: agent.companyId,
    type: "hire_agent",
    title: `Hire ${agent.name} as ${agent.title || agent.role}`,
    body: [
      `Name: ${agent.name}`,
      `Role: ${agent.role}${agent.title ? ` (${agent.title})` : ""}`,
      agent.capabilities ? `Capabilities: ${agent.capabilities}` : "",
      agent.model ? `Model: ${agent.model}` : "",
      `Runtime: ${agent.adapterType}`,
      agent.instructions ? `Instructions:\n${agent.instructions.slice(0, 2000)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    subject: { agentId: agent.id },
    requestedBy: actor,
  });
});

onHardStop((incident) => {
  if (openFor(incident.ownerId, "budget_override", "incidentId", incident.id)) return;
  file({
    ownerId: incident.ownerId,
    companyId: incident.companyId,
    type: "budget_override",
    title: `Raise the budget that stopped ${incident.scopeType} work`,
    body: `Spend reached $${toUsd(incident.observedMicros).toFixed(4)} of a $${toUsd(incident.limitMicros).toFixed(4)} limit (${incident.windowKey}). Approving raises the limit and resumes work; rejecting keeps it paused.`,
    subject: { incidentId: incident.id },
    requestedBy: { type: "system", id: "budget" },
  });
});

orgEvents.on("task.status", (task) => {
  if (task.workMode !== "planning" || task.status !== "in_review") return;
  if (openFor(task.ownerId, "plan", "taskId", task.id)) return;
  const plan = listComments(task.ownerId, task.id)
    .filter((c) => c.author.type === "agent" && c.author.id === task.assigneeAgentId)
    .at(-1);
  file({
    ownerId: task.ownerId,
    companyId: task.companyId,
    type: "plan",
    title: `Approve the plan for ${task.identifier}: ${task.title}`,
    body: plan?.body.slice(0, 8000) ?? "(the agent left no plan text)",
    subject: {
      taskId: task.id,
      ...(task.assigneeAgentId ? { agentId: task.assigneeAgentId } : {}),
    },
    requestedBy: plan?.author ?? { type: "system", id: "runtime" },
  });
});

onApprovalRequested((run, agent, task, ask) => {
  if (openFor(run.ownerId, "action", "taskId", task.id)) return;
  file({
    ownerId: run.ownerId,
    companyId: run.companyId,
    type: "action",
    title: `${agent.name} asks: ${ask.title}`,
    body: `${ask.reason}\n\nTask ${task.identifier}: ${task.title}`,
    subject: { taskId: task.id, agentId: agent.id },
    requestedBy: { type: "agent", id: agent.id },
  });
});

// ── Decisions ────────────────────────────────────────────────────────────────

export type Decision = "approve" | "reject" | "request_revision";

function wake(ownerId: string, agentId: string | undefined, taskId: string, reason: string) {
  if (!agentId) return;
  try {
    enqueueWake(ownerId, agentId, { source: "approval", reason, taskId });
  } catch {
    /* agent terminated since */
  }
}

/**
 * Decide an approval and carry out what it governs. A budget approval needs
 * `amountUsd`, the new limit.
 */
export function decide(
  ownerId: string,
  id: string,
  decision: Decision,
  input: { note?: unknown; amountUsd?: unknown } = {},
): Approval {
  const a = getApproval(ownerId, id);
  if (a.status !== "pending")
    throw conflict(`This approval is already ${a.status.replace("_", " ")}.`);
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 4000) : "";
  const board: Actor = { type: "user", id: ownerId };

  if (decision === "request_revision") {
    if (a.type !== "plan" && a.type !== "action")
      throw new OrgError(400, "invalid", "Only plans and agent requests can be sent back.");
    if (!note) throw new OrgError(400, "invalid", "Say what to change.");
  }

  switch (a.type) {
    case "hire_agent": {
      const agentId = a.subject.agentId!;
      if (decision === "approve")
        setAgentStatus(ownerId, agentId, "idle", { viaApproval: true, actorId: ownerId });
      else setAgentStatus(ownerId, agentId, "terminated", { actorId: ownerId });
      break;
    }
    case "budget_override": {
      const incident = getIncident(ownerId, a.subject.incidentId!);
      if (decision === "approve") {
        const amount = Number(input.amountUsd);
        resolveIncident(ownerId, incident.id, {
          action: "raise_and_resume",
          amountUsd:
            Number.isFinite(amount) && amount > 0 ? amount : toUsd(incident.observedMicros) * 2,
        });
      } else if (incident.status === "open")
        resolveIncident(ownerId, incident.id, { action: "dismiss" });
      break;
    }
    case "plan": {
      const task = getTask(ownerId, a.subject.taskId!);
      if (decision === "approve") {
        updateTask(ownerId, task.id, { workMode: "standard" }, board);
        if (note) addComment(ownerId, task.id, `Plan approved. ${note}`, board);
        if (task.status === "in_review") setTaskStatus(ownerId, task.id, "todo", board);
        wake(ownerId, task.assigneeAgentId ?? undefined, task.id, "Plan approved");
      } else if (decision === "request_revision") {
        addComment(ownerId, task.id, `Revise the plan: ${note}`, board);
        if (task.status === "in_review") setTaskStatus(ownerId, task.id, "todo", board);
        wake(ownerId, task.assigneeAgentId ?? undefined, task.id, "Plan sent back");
      } else {
        if (note) addComment(ownerId, task.id, `Plan rejected: ${note}`, board);
        if (!["done", "cancelled"].includes(task.status))
          setTaskStatus(ownerId, task.id, "cancelled", board);
      }
      break;
    }
    case "action": {
      const task = getTask(ownerId, a.subject.taskId!);
      const verdict =
        decision === "approve" ? "Approved" : decision === "reject" ? "Denied" : "Needs changes";
      addComment(ownerId, task.id, `${verdict}: ${a.title}${note ? ` — ${note}` : ""}`, board);
      if (task.status === "blocked") setTaskStatus(ownerId, task.id, "todo", board);
      wake(ownerId, a.subject.agentId, task.id, `Request ${verdict.toLowerCase()}`);
      break;
    }
  }

  const status: ApprovalStatus =
    decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "revision_requested";
  // A sent-back request closes here; the agent's next attempt files a fresh one.
  const next: Approval = { ...a, status, decisionNote: note || null, decidedAt: now() };
  approvals.set(id, next);
  logActivity(getCompany(ownerId, a.companyId), {
    actorType: "user",
    actorId: ownerId,
    action: `approval.${next.status}`,
    entityType: "approval",
    entityId: id,
    details: { title: a.title, ...(note ? { reason: note } : {}) },
  });
  return next;
}

export function cancelApproval(ownerId: string, id: string): Approval {
  const a = getApproval(ownerId, id);
  if (a.status !== "pending") throw conflict(`This approval is already ${a.status}.`);
  const next = { ...a, status: "cancelled" as const, decidedAt: now() };
  approvals.set(id, next);
  return next;
}

// ── Council review ───────────────────────────────────────────────────────────

const REVIEW_CAP_USD = 0.05;

/**
 * Ask the council to review a pending approval. Runs in the background; the
 * approval carries the review's progress. Its cost is booked to the company.
 */
export function reviewApproval(ownerId: string, id: string): Approval {
  const a = getApproval(ownerId, id);
  if (a.status !== "pending") throw conflict("Only a pending approval can be reviewed.");
  if (!council) throw new OrgError(503, "unavailable", "The council is not available.");
  if (a.review?.status === "running") return a;
  const company = getCompany(ownerId, a.companyId);
  const headroom = companyHeadroomUsd(ownerId, a.companyId);
  if (headroom !== null && headroom <= 0)
    throw new OrgError(409, "conflict", "The company budget has no room for a council review.");

  const running: Approval = {
    ...a,
    review: {
      status: "running",
      verdict: null,
      consensus: 0,
      summary: "",
      votes: [],
      costUsd: 0,
      error: null,
      at: now(),
    },
  };
  approvals.set(id, running);

  const request: CouncilRequest = {
    proposal: {
      title: `Should the board approve this? ${a.title}`.slice(0, 480),
      description: [
        `Company: ${company.name}${company.mission ? ` — mission: ${company.mission}` : ""}`,
        `Request type: ${a.type.replace("_", " ")}`,
        a.body,
        "Vote yes to approve, no to reject. Name the main risk in your reasoning.",
      ]
        .join("\n\n")
        .slice(0, 9500),
    },
    budgetUsd: Math.min(REVIEW_CAP_USD, headroom ?? REVIEW_CAP_USD),
    councilSize: 3,
    timeoutMs: 120_000,
  };

  const settle = (review: Partial<CouncilReview>) => {
    const current = approvals.get(id);
    if (!current) return;
    approvals.set(id, { ...current, review: { ...running.review!, ...review, at: now() } });
  };

  void council(ownerId, request)
    .then((res) => {
      if (!res.ok || !res.result) {
        settle({ status: "failed", error: res.error ?? "The council did not reach a result." });
        return undefined;
      }
      const r = res.result;
      bookCompanySpend(ownerId, a.companyId, r.totalCostUsd);
      settle({
        status: "done",
        verdict:
          r.outcome === "approved" ? "approve" : r.outcome === "rejected" ? "reject" : "revise",
        consensus: r.consensus,
        summary: r.summary,
        costUsd: r.totalCostUsd,
        votes: r.votes.map((v) => ({
          member: v.model,
          vote: v.vote,
          confidence: v.confidence,
          reasoning: v.reasoning.slice(0, 1500),
        })),
      });
      logActivity(company, {
        actorType: "system",
        actorId: "council",
        action: "approval.reviewed",
        entityType: "approval",
        entityId: id,
        details: { title: a.title, reason: r.outcome },
      });
      return undefined;
    })
    .catch((err: unknown) => settle({ status: "failed", error: (err as Error).message }));

  return running;
}

// ── Council quality gate ─────────────────────────────────────────────────────

/** Ask the council whether the work is done; it passes to done or goes back to the agent. */
async function gateWithCouncil(ownerId: string, taskId: string, deliverable: string) {
  const task = getTask(ownerId, taskId);
  const company = getCompany(ownerId, task.companyId);
  const reviewer: Actor = { type: "system", id: "council" };
  const headroom = companyHeadroomUsd(ownerId, company.id);
  const res: CouncilResponse =
    headroom !== null && headroom <= 0
      ? { ok: false, error: "the company budget has no room for a review" }
      : await council!(ownerId, {
          proposal: {
            title: `Is this work done? ${task.identifier}: ${task.title}`.slice(0, 480),
            description: [
              `Company: ${company.name}${company.mission ? ` — mission: ${company.mission}` : ""}`,
              task.description ? `The task: ${task.description}` : "",
              `The deliverable:\n${deliverable || "(the agent wrote none)"}`,
              "Vote yes only if the deliverable fully does what the task asks. If not, say what is missing.",
            ]
              .filter(Boolean)
              .join("\n\n")
              .slice(0, 9500),
          },
          budgetUsd: Math.min(REVIEW_CAP_USD, headroom ?? REVIEW_CAP_USD),
          councilSize: 3,
          timeoutMs: 120_000,
        }).catch((e: unknown) => ({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }));
  // The council was paid for whatever the task did meanwhile.
  if (res.ok && res.result) bookCompanySpend(ownerId, company.id, res.result.totalCostUsd);
  if (getTask(ownerId, taskId).status !== "in_review") return;
  if (!res.ok || !res.result) {
    addComment(
      ownerId,
      taskId,
      `The council could not check this (${res.error ?? "no result"}); it waits for you.`,
      reviewer,
    );
    return;
  }
  const r = res.result;
  const consensus = `${r.votes.filter((v) => v.vote === "yes").length} of ${r.votes.length} voted yes`;
  if (r.outcome === "approved") {
    addComment(ownerId, taskId, `The council passed this (${consensus}). ${r.summary}`, reviewer);
    setTaskStatus(ownerId, taskId, "done", reviewer);
    return;
  }
  addComment(ownerId, taskId, `The council sent this back (${consensus}). ${r.summary}`, reviewer);
  setTaskStatus(ownerId, taskId, "todo", reviewer);
  wake(ownerId, task.assigneeAgentId ?? undefined, taskId, "The council sent the work back");
}

addDoneGate((run, _agent, task, deliverable) => {
  if (!council || task.workMode !== "standard") return false;
  if (!getCompany(run.ownerId, run.companyId).councilGatesDone) return false;
  // Deferred: the runtime moves the task to in_review after this returns.
  setTimeout(() => void gateWithCouncil(run.ownerId, task.id, deliverable), 0);
  return true;
});
