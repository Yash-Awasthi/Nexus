// SPDX-License-Identifier: Apache-2.0
/**
 * Work inside a company: the goal tree, tasks and their comments.
 *
 * Every task can answer "why am I doing this": its parent tasks lead to a goal,
 * the goal's parents lead to the company mission, and `taskContext` renders
 * that chain for the agent that works the task.
 *
 * Checkout is atomic because the check and the write happen in one synchronous
 * step against the in-memory map — no await sits between them — so two runs in
 * this process cannot both win. The task status machine, single-assignee rule
 * and checkout contract follow Paperclip's V1 spec —
 * https://github.com/paperclipai/paperclip, MIT License,
 * Copyright (c) 2025 Paperclip AI.
 */

import crypto from "node:crypto";
import { EventEmitter } from "node:events";

import {
  OrgError,
  getAgent,
  getCompany,
  invalid,
  listAgents,
  logActivity,
  nextSeq,
  nextTaskIdentifier,
  notFound,
  now,
  onOrgLoad,
  registerCompanyScoped,
  type ActorType,
} from "./org-store.js";
import { PersistentStore } from "./persistent-store.js";

const conflict = (message: string) => new OrgError(409, "conflict", message);

// ── Types ────────────────────────────────────────────────────────────────────

export const GOAL_LEVELS = ["company", "team", "agent", "task"] as const;
export type GoalLevel = (typeof GOAL_LEVELS)[number];
export const GOAL_STATUSES = ["planned", "active", "achieved", "cancelled"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

interface Goal {
  id: string;
  ownerId: string;
  companyId: string;
  title: string;
  description: string;
  level: GoalLevel;
  parentId: string | null;
  ownerAgentId: string | null;
  status: GoalStatus;
  /** The Nexus project this goal carries out, when a project was handed to the company. */
  projectId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
const WORK_MODES = ["standard", "planning", "ask"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export interface Actor {
  type: ActorType;
  id: string;
}

export interface Task {
  id: string;
  ownerId: string;
  companyId: string;
  /** Human-readable handle, e.g. ACME-12. */
  identifier: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  goalId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  /** Tasks that must be done before this one can be checked out. */
  blockedBy: string[];
  /** standard: do the work; planning: produce a plan only; ask: answer only. */
  workMode: WorkMode;
  /** The run holding this task, if any. */
  checkoutRunId: string | null;
  createdBy: Actor;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

interface Comment {
  id: string;
  ownerId: string;
  companyId: string;
  taskId: string;
  author: Actor;
  body: string;
  createdAt: string;
  seq: number;
}

// ── Storage + events ─────────────────────────────────────────────────────────

const goals = new PersistentStore<Goal>("org_goals");
const tasks = new PersistentStore<Task>("org_tasks");
const comments = new PersistentStore<Comment>("org_comments");
registerCompanyScoped(goals);
registerCompanyScoped(tasks);
registerCompanyScoped(comments);
onOrgLoad(() => Promise.all([goals.load(), tasks.load(), comments.load()]).then(() => undefined));

interface OrgEvents {
  "task.assigned": [task: Task, actor: Actor];
  "task.status": [task: Task, from: TaskStatus, actor: Actor];
  "comment.created": [comment: Comment, task: Task];
}

/** Other org modules (scheduler, memory) react to work changes through this. */
export const orgEvents = new EventEmitter<OrgEvents>();

function text(v: unknown, max: number, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw invalid(`${what} must be text.`);
  return v.trim().slice(0, max);
}

function oneOf<T extends string>(v: unknown, list: readonly T[], what: string): T | undefined {
  if (v === undefined) return undefined;
  if (!list.includes(v as T)) throw invalid(`${what} must be one of ${list.join(", ")}.`);
  return v as T;
}

// ── Goals ────────────────────────────────────────────────────────────────────

export function listGoals(ownerId: string, companyId: string): Goal[] {
  getCompany(ownerId, companyId);
  return [...goals.values()]
    .filter((g) => g.ownerId === ownerId && g.companyId === companyId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getGoal(ownerId: string, id: string): Goal {
  const g = goals.get(id);
  if (!g || g.ownerId !== ownerId) throw notFound("Goal");
  return g;
}

export interface GoalInput {
  title?: unknown;
  description?: unknown;
  level?: unknown;
  parentId?: unknown;
  ownerAgentId?: unknown;
  status?: unknown;
  projectId?: unknown;
}

function applyGoal(ownerId: string, g: Goal, input: GoalInput): Goal {
  const next = { ...g };
  const title = text(input.title, 200, "title");
  if (title !== undefined) {
    if (!title) throw invalid("A goal needs a title.");
    next.title = title;
  }
  const description = text(input.description, 4000, "description");
  if (description !== undefined) next.description = description;
  next.level = oneOf(input.level, GOAL_LEVELS, "level") ?? next.level;
  next.status = oneOf(input.status, GOAL_STATUSES, "status") ?? next.status;
  if (input.projectId !== undefined)
    next.projectId = text(input.projectId, 100, "projectId") || null;
  if (input.parentId !== undefined) {
    if (!input.parentId) next.parentId = null;
    else {
      const parent = goals.get(String(input.parentId));
      if (!parent || parent.ownerId !== ownerId || parent.companyId !== g.companyId)
        throw invalid("parentId must be a goal in the same company.");
      for (let cur: Goal | undefined = parent, n = 0; cur && n < 100; n++) {
        if (cur.id === g.id) throw invalid("That parent would form a cycle.");
        cur = cur.parentId ? goals.get(cur.parentId) : undefined;
      }
      next.parentId = parent.id;
    }
  }
  if (input.ownerAgentId !== undefined) {
    if (!input.ownerAgentId) next.ownerAgentId = null;
    else {
      const agent = getAgent(ownerId, String(input.ownerAgentId));
      if (agent.companyId !== g.companyId) throw invalid("ownerAgentId must be in this company.");
      next.ownerAgentId = agent.id;
    }
  }
  return next;
}

export function createGoal(ownerId: string, companyId: string, input: GoalInput): Goal {
  const company = getCompany(ownerId, companyId);
  const blank: Goal = {
    id: crypto.randomUUID(),
    ownerId,
    companyId,
    title: "",
    description: "",
    level: input.parentId ? "team" : "company",
    parentId: null,
    ownerAgentId: null,
    status: "active",
    createdAt: now(),
    updatedAt: now(),
  };
  const goal = applyGoal(ownerId, blank, input);
  if (!goal.title) throw invalid("A goal needs a title.");
  goals.set(goal.id, goal);
  logActivity(company, {
    actorType: "user",
    actorId: ownerId,
    action: "goal.created",
    entityType: "goal",
    entityId: goal.id,
    details: { title: goal.title },
  });
  return goal;
}

export function updateGoal(ownerId: string, id: string, input: GoalInput): Goal {
  const next = { ...applyGoal(ownerId, getGoal(ownerId, id), input), updatedAt: now() };
  goals.set(id, next);
  return next;
}

/** Children move up to the deleted goal's parent; tasks lose the link. */
export function deleteGoal(ownerId: string, id: string): void {
  const g = getGoal(ownerId, id);
  for (const child of goals.values())
    if (child.parentId === id) goals.set(child.id, { ...child, parentId: g.parentId });
  for (const t of tasks.values())
    if (t.goalId === id) tasks.set(t.id, { ...t, goalId: g.parentId, updatedAt: now() });
  goals.delete(id);
}

// ── Tasks ────────────────────────────────────────────────────────────────────

/** Paperclip's issue transitions. `done` and `cancelled` are terminal for agents. */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["todo", "cancelled"],
  todo: ["in_progress", "blocked", "cancelled", "backlog"],
  in_progress: ["in_review", "blocked", "done", "cancelled", "todo"],
  in_review: ["in_progress", "todo", "done", "cancelled"],
  blocked: ["todo", "in_progress", "cancelled"],
  done: [],
  cancelled: [],
};

export function allowedTransitions(from: TaskStatus, actor: Actor): TaskStatus[] {
  // The board may reopen finished work; an agent may not.
  if ((from === "done" || from === "cancelled") && actor.type === "user") return ["todo"];
  return TRANSITIONS[from];
}

interface TaskFilter {
  status?: string;
  assigneeAgentId?: string;
  goalId?: string;
  parentId?: string;
}

export function listTasks(ownerId: string, companyId: string, filter: TaskFilter = {}): Task[] {
  getCompany(ownerId, companyId);
  const statuses = filter.status ? new Set(filter.status.split(",")) : null;
  return [...tasks.values()]
    .filter(
      (t) =>
        t.ownerId === ownerId &&
        t.companyId === companyId &&
        (!statuses || statuses.has(t.status)) &&
        (!filter.assigneeAgentId || t.assigneeAgentId === filter.assigneeAgentId) &&
        (!filter.goalId || t.goalId === filter.goalId) &&
        (!filter.parentId || t.parentId === filter.parentId),
    )
    .sort((a, b) => b.seq - a.seq);
}

export function getTask(ownerId: string, id: string): Task {
  const t = tasks.get(id);
  if (!t || t.ownerId !== ownerId) throw notFound("Task");
  return t;
}

/** A task by id or by its identifier (ACME-12), within one company. */
export function findTask(ownerId: string, companyId: string, ref: string): Task | undefined {
  const byId = tasks.get(ref);
  if (byId && byId.ownerId === ownerId && byId.companyId === companyId) return byId;
  const upper = ref.toUpperCase();
  return [...tasks.values()].find(
    (t) => t.ownerId === ownerId && t.companyId === companyId && t.identifier === upper,
  );
}

export interface TaskInput {
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  status?: unknown;
  goalId?: unknown;
  parentId?: unknown;
  assigneeAgentId?: unknown;
  blockedBy?: unknown;
  workMode?: unknown;
}

function assertSameCompanyTask(ownerId: string, companyId: string, id: string, what: string): Task {
  const t = tasks.get(id);
  if (!t || t.ownerId !== ownerId || t.companyId !== companyId)
    throw invalid(`${what} must be a task in the same company.`);
  return t;
}

function applyTask(ownerId: string, t: Task, input: TaskInput): Task {
  const next = { ...t };
  const title = text(input.title, 300, "title");
  if (title !== undefined) {
    if (!title) throw invalid("A task needs a title.");
    next.title = title;
  }
  const description = text(input.description, 20_000, "description");
  if (description !== undefined) next.description = description;
  next.priority = oneOf(input.priority, PRIORITIES, "priority") ?? next.priority;
  next.workMode = oneOf(input.workMode, WORK_MODES, "workMode") ?? next.workMode;
  if (input.goalId !== undefined) {
    if (!input.goalId) next.goalId = null;
    else {
      const g = goals.get(String(input.goalId));
      if (!g || g.ownerId !== ownerId || g.companyId !== t.companyId)
        throw invalid("goalId must be a goal in the same company.");
      next.goalId = g.id;
    }
  }
  if (input.parentId !== undefined) {
    if (!input.parentId) next.parentId = null;
    else {
      const parent = assertSameCompanyTask(
        ownerId,
        t.companyId,
        String(input.parentId),
        "parentId",
      );
      for (let cur: Task | undefined = parent, n = 0; cur && n < 100; n++) {
        if (cur.id === t.id) throw invalid("That parent would form a cycle.");
        cur = cur.parentId ? tasks.get(cur.parentId) : undefined;
      }
      next.parentId = parent.id;
    }
  }
  if (input.assigneeAgentId !== undefined) {
    if (!input.assigneeAgentId) next.assigneeAgentId = null;
    else {
      const a = getAgent(ownerId, String(input.assigneeAgentId));
      if (a.companyId !== t.companyId) throw invalid("The assignee must work at this company.");
      if (a.status === "terminated") throw invalid("A terminated agent cannot take work.");
      next.assigneeAgentId = a.id;
    }
  }
  if (input.blockedBy !== undefined) {
    if (!Array.isArray(input.blockedBy)) throw invalid("blockedBy must be a list of task ids.");
    const ids = [...new Set(input.blockedBy.map(String))];
    for (const id of ids) {
      if (id === t.id) throw invalid("A task cannot block itself.");
      assertSameCompanyTask(ownerId, t.companyId, id, "blockedBy");
    }
    next.blockedBy = ids;
  }
  return next;
}

export function createTask(
  ownerId: string,
  companyId: string,
  input: TaskInput,
  actor: Actor = { type: "user", id: ownerId },
): Task {
  const company = getCompany(ownerId, companyId);
  const blank: Task = {
    id: crypto.randomUUID(),
    ownerId,
    companyId,
    identifier: "",
    title: "",
    description: "",
    status: "todo",
    priority: "medium",
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    blockedBy: [],
    workMode: "standard",
    checkoutRunId: null,
    createdBy: actor,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: now(),
    updatedAt: now(),
    seq: nextSeq(),
  };
  const task = applyTask(ownerId, blank, input);
  if (!task.title) throw invalid("A task needs a title.");
  const initial = oneOf(input.status, ["backlog", "todo"] as const, "initial status");
  if (initial) task.status = initial;
  // A subtask with no goal of its own serves its parent's goal.
  if (!task.goalId && task.parentId) task.goalId = tasks.get(task.parentId)?.goalId ?? null;
  task.identifier = nextTaskIdentifier(ownerId, companyId);
  tasks.set(task.id, task);
  logActivity(company, {
    actorType: actor.type,
    actorId: actor.id,
    action: "task.created",
    entityType: "task",
    entityId: task.id,
    details: { title: task.title, identifier: task.identifier },
  });
  if (task.assigneeAgentId) orgEvents.emit("task.assigned", task, actor);
  return task;
}

export function updateTask(
  ownerId: string,
  id: string,
  input: TaskInput,
  actor: Actor = { type: "user", id: ownerId },
): Task {
  const existing = getTask(ownerId, id);
  const next = { ...applyTask(ownerId, existing, input), updatedAt: now() };
  if (next.status === "in_progress" && !next.assigneeAgentId)
    throw invalid("A task in progress needs an assignee.");
  const reassigned = next.assigneeAgentId !== existing.assigneeAgentId;
  if (reassigned) next.checkoutRunId = null;
  tasks.set(id, next);
  if (reassigned) {
    logActivity(getCompany(ownerId, existing.companyId), {
      actorType: actor.type,
      actorId: actor.id,
      action: next.assigneeAgentId ? "task.assigned" : "task.unassigned",
      entityType: "task",
      entityId: id,
      details: { title: next.title, identifier: next.identifier, agentId: next.assigneeAgentId },
    });
    if (next.assigneeAgentId) orgEvents.emit("task.assigned", next, actor);
  }
  return next;
}

export function setTaskStatus(
  ownerId: string,
  id: string,
  to: TaskStatus,
  actor: Actor = { type: "user", id: ownerId },
): Task {
  const existing = getTask(ownerId, id);
  if (!TASK_STATUSES.includes(to)) throw invalid(`Unknown status ${to}.`);
  if (existing.status === to) return existing;
  if (!allowedTransitions(existing.status, actor).includes(to))
    throw conflict(`A task cannot go from ${existing.status} to ${to}.`);
  if (to === "in_progress" && !existing.assigneeAgentId)
    throw invalid("Assign the task before starting it.");
  const t = now();
  const next: Task = {
    ...existing,
    status: to,
    updatedAt: t,
    startedAt: to === "in_progress" ? (existing.startedAt ?? t) : existing.startedAt,
    completedAt: to === "done" ? t : to === "todo" ? null : existing.completedAt,
    cancelledAt: to === "cancelled" ? t : to === "todo" ? null : existing.cancelledAt,
    checkoutRunId: to === "done" || to === "cancelled" ? null : existing.checkoutRunId,
  };
  tasks.set(id, next);
  logActivity(getCompany(ownerId, existing.companyId), {
    actorType: actor.type,
    actorId: actor.id,
    action: `task.${to}`,
    entityType: "task",
    entityId: id,
    details: { title: next.title, identifier: next.identifier, from: existing.status },
  });
  orgEvents.emit("task.status", next, existing.status, actor);
  return next;
}

export function deleteTask(ownerId: string, id: string): void {
  const t = getTask(ownerId, id);
  if (t.checkoutRunId) throw conflict("A run is working on this task; cancel it first.");
  for (const other of tasks.values()) {
    if (other.parentId === id) tasks.set(other.id, { ...other, parentId: t.parentId });
    if (other.blockedBy.includes(id))
      tasks.set(other.id, { ...other, blockedBy: other.blockedBy.filter((b) => b !== id) });
  }
  for (const c of [...comments.values()]) if (c.taskId === id) comments.delete(c.id);
  tasks.delete(id);
}

/** Blockers of `task` that are not finished yet. */
export function openBlockers(task: Task): Task[] {
  return task.blockedBy
    .map((id) => tasks.get(id))
    .filter((b): b is Task => !!b && b.status !== "done" && b.status !== "cancelled");
}

const CHECKOUT_FROM: TaskStatus[] = ["todo", "backlog", "blocked", "in_review", "in_progress"];

/**
 * Claim a task for one run of one agent. The whole check-and-set is synchronous
 * so it cannot interleave with another checkout. Returns 409 with the current
 * holder when someone else has it.
 */
export function checkoutTask(ownerId: string, id: string, agentId: string, runId: string): Task {
  const t = getTask(ownerId, id);
  if (!CHECKOUT_FROM.includes(t.status)) throw conflict(`Task is ${t.status}.`);
  if (t.assigneeAgentId && t.assigneeAgentId !== agentId)
    throw conflict("Task is assigned to another agent.");
  if (t.checkoutRunId && t.checkoutRunId !== runId)
    throw conflict(`Task is checked out by run ${t.checkoutRunId}.`);
  if (openBlockers(t).length > 0) throw conflict("Task is waiting on its blockers.");
  const stamp = now();
  const next: Task = {
    ...t,
    assigneeAgentId: agentId,
    status: "in_progress",
    checkoutRunId: runId,
    startedAt: t.startedAt ?? stamp,
    updatedAt: stamp,
  };
  tasks.set(id, next);
  if (t.status !== "in_progress")
    orgEvents.emit("task.status", next, t.status, { type: "agent", id: agentId });
  return next;
}

/** Drop a run's hold. Only the holding run (or the board) may release. */
export function releaseTask(ownerId: string, id: string, runId: string | null): Task {
  const t = getTask(ownerId, id);
  if (runId && t.checkoutRunId && t.checkoutRunId !== runId)
    throw conflict("Another run holds this task.");
  const next = { ...t, checkoutRunId: null, updatedAt: now() };
  tasks.set(id, next);
  return next;
}

/** Highest-priority, oldest task the agent can pick up right now. */
export function nextTaskFor(ownerId: string, agentId: string): Task | undefined {
  const rank: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return [...tasks.values()]
    .filter(
      (t) =>
        t.ownerId === ownerId &&
        t.assigneeAgentId === agentId &&
        (t.status === "todo" || t.status === "in_progress") &&
        !t.checkoutRunId &&
        openBlockers(t).length === 0,
    )
    .sort((a, b) => rank[a.priority] - rank[b.priority] || a.seq - b.seq)[0];
}

// ── Comments ─────────────────────────────────────────────────────────────────

export function listComments(ownerId: string, taskId: string): Comment[] {
  getTask(ownerId, taskId);
  return [...comments.values()]
    .filter((c) => c.ownerId === ownerId && c.taskId === taskId)
    .sort((a, b) => a.seq - b.seq);
}

export function addComment(ownerId: string, taskId: string, body: unknown, author: Actor): Comment {
  const task = getTask(ownerId, taskId);
  const text_ = text(body, 20_000, "body");
  if (!text_) throw invalid("A comment needs a body.");
  const c: Comment = {
    id: crypto.randomUUID(),
    ownerId,
    companyId: task.companyId,
    taskId,
    author,
    body: text_,
    createdAt: now(),
    seq: nextSeq(),
  };
  comments.set(c.id, c);
  orgEvents.emit("comment.created", c, task);
  return c;
}

// ── Context ──────────────────────────────────────────────────────────────────

/** Ancestors of a task (nearest first), then its goal chain up to the company goal. */
export function whyChain(ownerId: string, task: Task): { tasks: Task[]; goals: Goal[] } {
  const parents: Task[] = [];
  let goalId = task.goalId;
  for (let p = task.parentId ? tasks.get(task.parentId) : undefined, n = 0; p && n < 50; n++) {
    if (p.ownerId !== ownerId) break;
    parents.push(p);
    goalId ??= p.goalId;
    p = p.parentId ? tasks.get(p.parentId) : undefined;
  }
  const chain: Goal[] = [];
  for (let g = goalId ? goals.get(goalId) : undefined, n = 0; g && n < 50; n++) {
    if (g.ownerId !== ownerId) break;
    chain.push(g);
    g = g.parentId ? goals.get(g.parentId) : undefined;
  }
  return { tasks: parents, goals: chain };
}

/** The "why" block every run prompt starts from. */
export function taskContext(ownerId: string, task: Task): string {
  const company = getCompany(ownerId, task.companyId);
  const { tasks: parents, goals: chain } = whyChain(ownerId, task);
  const lines = [`Current task ${task.identifier}: ${task.title}`];
  for (const p of parents) lines.push(`  because of ${p.identifier}: ${p.title}`);
  for (const g of chain) lines.push(`  serving the ${g.level} goal: ${g.title}`);
  if (company.mission) lines.push(`  and the company mission: ${company.mission}`);
  return lines.join("\n");
}

interface HandedTask {
  identifier: string;
  taskId: string;
  status: TaskStatus;
  /** The assignee's last comment once it settles, which is where a run writes its deliverable. */
  deliverable: string | null;
}

const SETTLED: TaskStatus[] = ["done", "in_review", "blocked", "cancelled"];

/**
 * File a task from elsewhere in Nexus (a workflow step, a deliberation) and,
 * with `wait`, resolve once the work settles or the signal aborts.
 */
export async function handOff(
  ownerId: string,
  companyId: string,
  input: TaskInput,
  opts: { wait?: boolean; signal?: AbortSignal; pollMs?: number } = {},
): Promise<HandedTask> {
  let task = createTask(ownerId, companyId, input);
  while (opts.wait && !SETTLED.includes(task.status) && !opts.signal?.aborted) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1000));
    task = getTask(ownerId, task.id);
  }
  const last = SETTLED.includes(task.status)
    ? listComments(ownerId, task.id)
        .filter((c) => c.author.type === "agent" && c.author.id === task.assigneeAgentId)
        .at(-1)
    : undefined;
  return {
    identifier: task.identifier,
    taskId: task.id,
    status: task.status,
    deliverable: last?.body ?? null,
  };
}

/**
 * A council verdict becomes one task for the company's top agent, who splits
 * it into work for the team the way any delegated task is split.
 */
export async function fileVerdict(
  ownerId: string,
  companyId: string,
  input: { question?: unknown; verdict?: unknown },
): Promise<HandedTask> {
  const verdict = typeof input.verdict === "string" ? input.verdict.trim() : "";
  if (!verdict) throw invalid("A verdict is required.");
  const question =
    typeof input.question === "string" && input.question.trim()
      ? input.question.trim().slice(0, 500)
      : "the council's question";
  const lead = listAgents(ownerId, companyId).find(
    (a) => !a.reportsTo && a.status !== "terminated",
  );
  return handOff(ownerId, companyId, {
    title: `Act on the council verdict: ${question}`.slice(0, 300),
    description: `The council deliberated on "${question}" and concluded:\n\n${verdict.slice(0, 12_000)}\n\nTurn this into concrete work for the team.`,
    assigneeAgentId: lead?.id ?? null,
    priority: "high",
  });
}

/** Every goal, across the owner's companies, that carries out this project, with its tasks. */
export function projectGoals(ownerId: string, projectId: string) {
  return [...goals.values()]
    .filter((g) => g.ownerId === ownerId && g.projectId === projectId)
    .map((goal) => ({
      goal,
      company: { id: goal.companyId, name: getCompany(ownerId, goal.companyId).name },
      tasks: [...tasks.values()]
        .filter((t) => t.ownerId === ownerId && t.goalId === goal.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((t) => ({ id: t.id, identifier: t.identifier, title: t.title, status: t.status })),
    }));
}
