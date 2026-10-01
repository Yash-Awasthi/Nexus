// SPDX-License-Identifier: Apache-2.0
/**
 * Heartbeats and routines: what wakes an agent without a human pressing a button.
 *
 * - Timer: an agent with a heartbeat wakes on its cron expression or every
 *   `intervalSec`. A tick only queues a wake when the agent has something to
 *   do (an open task, or unassigned work to hand to its team), so an idle
 *   org costs nothing.
 * - Events: assigning a task or commenting on one wakes its assignee.
 * - Routines: recurring work. Each firing files a task for the routine's
 *   agent — or skips, when the previous firing's task is still open — and
 *   can also be fired by a signed webhook.
 *
 * Heartbeat policy and routine concurrency semantics follow Paperclip's
 * heartbeat and routine services — https://github.com/paperclipai/paperclip,
 * MIT License, Copyright (c) 2025 Paperclip AI.
 */

import crypto from "node:crypto";

import { isDue, minuteKey, nextCronRun, parseCron } from "@nexus/trigger-engine";

import { budgetOverview } from "./org-budget.js";
import { wakeApprovedGrants } from "./org-cli-adapters.js";
import { downline } from "./org-protocol.js";
import { enqueueWake, reapStalled } from "./org-runtime.js";
import {
  OrgError,
  allAgents,
  getAgent,
  getCompany,
  invalid,
  invokability,
  listAgents,
  logActivity,
  notFound,
  now,
  onOrgLoad,
  registerCompanyScoped,
  type Agent,
} from "./org-store.js";
import {
  createTask,
  getGoal,
  getTask,
  listTasks,
  nextTaskFor,
  orgEvents,
  PRIORITIES,
  type Actor,
  type Priority,
  type Task,
} from "./org-work.js";
import { PersistentStore } from "./persistent-store.js";
import { decryptSecret, encryptSecret, isSecretCryptoAvailable } from "./secret-crypto.js";

// ── Wake on events ───────────────────────────────────────────────────────────

function wakeFor(agentId: string | null, ownerId: string, fn: (a: Agent) => void): void {
  if (!agentId) return;
  try {
    const a = getAgent(ownerId, agentId);
    if (a.heartbeat.wakeOnAssign && invokability(ownerId, a).ok) fn(a);
  } catch {
    /* agent gone */
  }
}

orgEvents.on("task.assigned", (task, actor) => {
  // An agent handing work to itself is already mid-run; the run picks it up next.
  if (actor.type === "agent" && actor.id === task.assigneeAgentId) return;
  if (task.status !== "todo" && task.status !== "in_progress") return;
  wakeFor(task.assigneeAgentId, task.ownerId, (a) =>
    enqueueWake(task.ownerId, a.id, {
      source: "assignment",
      reason: `Assigned ${task.identifier}`,
      taskId: task.id,
    }),
  );
});

/**
 * The board naming another agent in a comment (`@Dev`) pulls that agent in: it
 * gets an answer-only subtask carrying the comment, which wakes it. Only the
 * board's comments do this, so agents cannot ping each other in a loop.
 */
orgEvents.on("comment.created", (comment, task) => {
  if (comment.author.type !== "user") return;
  const names = [...comment.body.matchAll(/@([\p{L}\p{N}_-]+)/gu)].map((m) => m[1]!.toLowerCase());
  if (names.length === 0) return;
  const agents = listAgents(task.ownerId, task.companyId).filter(
    (a) => a.status !== "terminated" && a.id !== task.assigneeAgentId,
  );
  for (const a of agents.filter((x) => names.includes(x.name.toLowerCase())).slice(0, 3)) {
    createTask(
      task.ownerId,
      task.companyId,
      {
        title: `Reply to the board on ${task.identifier}: ${task.title}`.slice(0, 300),
        description: comment.body,
        parentId: task.id,
        assigneeAgentId: a.id,
        workMode: "ask",
        priority: "high",
      },
      { type: "user", id: task.ownerId },
    );
  }
});

orgEvents.on("comment.created", (comment, task) => {
  if (comment.author.type !== "user") return;
  if (["done", "cancelled", "backlog"].includes(task.status)) return;
  wakeFor(task.assigneeAgentId, task.ownerId, (a) =>
    enqueueWake(task.ownerId, a.id, {
      source: "comment",
      reason: `New comment on ${task.identifier}`,
      taskId: task.id,
    }),
  );
});

// ── Routines ─────────────────────────────────────────────────────────────────

export interface RoutineFiring {
  at: string;
  source: "cron" | "webhook" | "manual";
  taskId: string | null;
  result: "filed" | "skipped_active" | "skipped_inactive";
}

export interface Routine {
  id: string;
  ownerId: string;
  companyId: string;
  title: string;
  description: string;
  assigneeAgentId: string;
  priority: Priority;
  goalId: string | null;
  /** Five-field cron in server local time; null means webhook or manual only. */
  cron: string | null;
  enabled: boolean;
  /** skip_if_active: no new task while the last one is open. always: file every time. */
  concurrency: "skip_if_active" | "always";
  /** Public id for the webhook URL; null when the webhook trigger is off. */
  webhookId: string | null;
  /** HMAC key for the webhook, encrypted at rest. Never returned by the API. */
  webhookSecretEnc: string | null;
  lastFiredAt: string | null;
  lastFiredMinute: string | null;
  lastTaskId: string | null;
  history: RoutineFiring[];
  createdAt: string;
  updatedAt: string;
}

const routines = new PersistentStore<Routine>("org_routines");
registerCompanyScoped(routines);
onOrgLoad(() => routines.load());

/** What the API shows: the secret stays server-side. */
export function publicRoutine(r: Routine) {
  const { webhookSecretEnc: _secret, ...rest } = r;
  return {
    ...rest,
    nextRunAt:
      r.enabled && r.cron ? (nextCronRun(r.cron, new Date())?.toISOString() ?? null) : null,
  };
}

export function listRoutines(ownerId: string, companyId: string): Routine[] {
  getCompany(ownerId, companyId);
  return [...routines.values()]
    .filter((r) => r.ownerId === ownerId && r.companyId === companyId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getRoutine(ownerId: string, id: string): Routine {
  const r = routines.get(id);
  if (!r || r.ownerId !== ownerId) throw notFound("Routine");
  return r;
}

export interface RoutineInput {
  title?: unknown;
  description?: unknown;
  assigneeAgentId?: unknown;
  priority?: unknown;
  goalId?: unknown;
  cron?: unknown;
  enabled?: unknown;
  concurrency?: unknown;
}

function applyRoutine(ownerId: string, r: Routine, input: RoutineInput): Routine {
  const next = { ...r };
  if (input.title !== undefined) {
    const t = String(input.title).trim().slice(0, 200);
    if (!t) throw invalid("A routine needs a title.");
    next.title = t;
  }
  if (input.description !== undefined) next.description = String(input.description).slice(0, 8000);
  if (input.assigneeAgentId !== undefined) {
    const a = getAgent(ownerId, String(input.assigneeAgentId));
    if (a.companyId !== r.companyId)
      throw invalid("The routine's agent must work at this company.");
    next.assigneeAgentId = a.id;
  }
  if (input.priority !== undefined) {
    if (!PRIORITIES.includes(input.priority as Priority)) throw invalid("Unknown priority.");
    next.priority = input.priority as Priority;
  }
  if (input.goalId !== undefined) {
    if (!input.goalId) next.goalId = null;
    else {
      const g = getGoal(ownerId, String(input.goalId));
      if (g.companyId !== r.companyId) throw invalid("That goal is not in this company.");
      next.goalId = g.id;
    }
  }
  if (input.cron !== undefined) {
    if (!input.cron) next.cron = null;
    else {
      const expr = String(input.cron).trim();
      if (!parseCron(expr))
        throw invalid("cron must be a five-field expression, e.g. 0 9 * * 1-5.");
      next.cron = expr;
    }
  }
  if (input.enabled !== undefined) next.enabled = input.enabled === true;
  if (input.concurrency !== undefined) {
    if (input.concurrency !== "skip_if_active" && input.concurrency !== "always")
      throw invalid("concurrency must be skip_if_active or always.");
    next.concurrency = input.concurrency;
  }
  return next;
}

export function createRoutine(ownerId: string, companyId: string, input: RoutineInput): Routine {
  const company = getCompany(ownerId, companyId);
  if (!input.assigneeAgentId) throw invalid("A routine needs an agent to do the work.");
  const blank: Routine = {
    id: crypto.randomUUID(),
    ownerId,
    companyId,
    title: "",
    description: "",
    assigneeAgentId: "",
    priority: "medium",
    goalId: null,
    cron: null,
    enabled: true,
    concurrency: "skip_if_active",
    webhookId: null,
    webhookSecretEnc: null,
    lastFiredAt: null,
    lastFiredMinute: null,
    lastTaskId: null,
    history: [],
    createdAt: now(),
    updatedAt: now(),
  };
  const r = applyRoutine(ownerId, blank, input);
  if (!r.title) throw invalid("A routine needs a title.");
  routines.set(r.id, r);
  logActivity(company, {
    actorType: "user",
    actorId: ownerId,
    action: "routine.created",
    entityType: "routine",
    entityId: r.id,
    details: { title: r.title },
  });
  return r;
}

export function updateRoutine(ownerId: string, id: string, input: RoutineInput): Routine {
  const next = { ...applyRoutine(ownerId, getRoutine(ownerId, id), input), updatedAt: now() };
  routines.set(id, next);
  return next;
}

export function deleteRoutine(ownerId: string, id: string): void {
  getRoutine(ownerId, id);
  routines.delete(id);
}

/**
 * Turn the webhook trigger on (minting a fresh secret, returned once) or off.
 * Refuses when there is no key to encrypt the secret with.
 */
export function setRoutineWebhook(
  ownerId: string,
  id: string,
  enabled: boolean,
): { routine: Routine; secret: string | null } {
  const r = getRoutine(ownerId, id);
  if (!enabled) {
    const next = { ...r, webhookId: null, webhookSecretEnc: null, updatedAt: now() };
    routines.set(id, next);
    return { routine: next, secret: null };
  }
  if (!isSecretCryptoAvailable())
    throw new OrgError(
      503,
      "secrets_unavailable",
      "Set NEXUS_SECRETS_KEY so the webhook secret can be stored encrypted.",
    );
  const secret = crypto.randomBytes(32).toString("base64url");
  const next = {
    ...r,
    webhookId: crypto.randomBytes(16).toString("base64url"),
    webhookSecretEnc: encryptSecret(secret),
    updatedAt: now(),
  };
  routines.set(id, next);
  return { routine: next, secret };
}

function record(r: Routine, firing: RoutineFiring): Routine {
  const next: Routine = {
    ...r,
    lastFiredAt: firing.at,
    lastTaskId: firing.taskId ?? r.lastTaskId,
    history: [firing, ...r.history].slice(0, 50),
    updatedAt: now(),
  };
  routines.set(r.id, next);
  return next;
}

/** Fire once: file a task for the routine's agent, unless the last one is still open. */
export function fireRoutine(
  ownerId: string,
  id: string,
  source: RoutineFiring["source"],
  payload?: unknown,
): RoutineFiring {
  const r = getRoutine(ownerId, id);
  const at = now();
  const company = getCompany(ownerId, r.companyId);
  if (company.status !== "active" || !r.enabled) {
    const firing: RoutineFiring = { at, source, taskId: null, result: "skipped_inactive" };
    record(r, firing);
    return firing;
  }
  if (r.concurrency === "skip_if_active" && r.lastTaskId) {
    try {
      const last = getTask(ownerId, r.lastTaskId);
      if (last.status !== "done" && last.status !== "cancelled") {
        const firing: RoutineFiring = { at, source, taskId: null, result: "skipped_active" };
        record(r, firing);
        return firing;
      }
    } catch {
      /* last task deleted: file a new one */
    }
  }
  const stamp = at.slice(0, 16).replace("T", " ");
  const extra =
    payload !== undefined && payload !== null && Object.keys(payload as object).length > 0
      ? `\n\nTrigger payload:\n\`\`\`json\n${JSON.stringify(payload, null, 2).slice(0, 4000)}\n\`\`\``
      : "";
  const task = createTask(
    ownerId,
    r.companyId,
    {
      title: `${r.title} (${stamp})`,
      description: `${r.description}${extra}`.trim(),
      priority: r.priority,
      goalId: r.goalId,
      assigneeAgentId: r.assigneeAgentId,
    },
    { type: "system", id: `routine:${r.id}` },
  );
  const firing: RoutineFiring = { at, source, taskId: task.id, result: "filed" };
  record(r, firing);
  logActivity(company, {
    actorType: "system",
    actorId: `routine:${r.id}`,
    action: "routine.fired",
    entityType: "routine",
    entityId: r.id,
    details: { title: r.title, identifier: task.identifier, reason: source },
  });
  // Routine work always wakes its agent, whatever its wake-on-assign setting.
  try {
    if (invokability(ownerId, getAgent(ownerId, r.assigneeAgentId)).ok)
      enqueueWake(ownerId, r.assigneeAgentId, {
        source: "routine",
        reason: r.title,
        taskId: task.id,
      });
  } catch {
    /* agent gone */
  }
  return firing;
}

/** The maximum age of a signed webhook call; older ones are refused as replays. */
const WEBHOOK_WINDOW_MS = 5 * 60_000;
const seenSignatures = new PersistentStore<{ id: string; at: number }>("org_webhook_seen");
onOrgLoad(() => seenSignatures.load());
let lastSweep = 0;

/**
 * Verify and fire a routine's webhook. The signature is
 * `sha256=HMAC(secret, "<timestamp>.<raw body>")` with the timestamp in
 * milliseconds, sent in `x-nexus-timestamp`.
 */
export function fireRoutineWebhook(
  webhookId: string,
  rawBody: string,
  timestamp: string | undefined,
  signature: string | undefined,
): RoutineFiring {
  const r = [...routines.values()].find((x) => x.webhookId && x.webhookId === webhookId);
  // Every failure answers the same way so the endpoint does not confirm which ids exist.
  const refuse = () => new OrgError(401, "bad_signature", "Signature missing, stale or wrong.");
  if (!r?.webhookSecretEnc || !timestamp || !signature) throw refuse();
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > WEBHOOK_WINDOW_MS) throw refuse();
  let secret: string;
  try {
    secret = decryptSecret(r.webhookSecretEnc);
  } catch {
    throw refuse();
  }
  const want = `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const a = Buffer.from(want);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw refuse();
  // A signature is good for one delivery; remember it until it would be stale anyway.
  const at = Date.now();
  // Each delete rewrites the store, so stale signatures are swept at most once a window.
  if (at - lastSweep > WEBHOOK_WINDOW_MS) {
    lastSweep = at;
    for (const seen of [...seenSignatures.values()])
      if (at - seen.at > 2 * WEBHOOK_WINDOW_MS) seenSignatures.delete(seen.id);
  }
  if (seenSignatures.has(signature)) throw refuse();
  seenSignatures.set(signature, { id: signature, at });
  let payload: unknown = undefined;
  try {
    payload = rawBody ? JSON.parse(rawBody) : undefined;
  } catch {
    payload = { raw: rawBody.slice(0, 2000) };
  }
  return fireRoutine(r.ownerId, r.id, "webhook", payload);
}

// ── The tick ─────────────────────────────────────────────────────────────────

/** Whether a timer wake would find anything for this agent to do. */
function hasWork(agent: Agent): boolean {
  if (nextTaskFor(agent.ownerId, agent.id)) return true;
  if (downline(agent.ownerId, agent).length === 0) return false;
  return listTasks(agent.ownerId, agent.companyId, { status: "todo,backlog" }).some(
    (t) => !t.assigneeAgentId,
  );
}

const STALE_REVIEW_MS = 3600_000;
const REVIEWER: Actor = { type: "system", id: "review" };
/** The findings each manager was last given a review for, keyed by agent id. */
const lastReview = new PersistentStore<{ id: string; companyId: string; signature: string }>(
  "org_last_review",
);
registerCompanyScoped(lastReview);
onOrgLoad(() => lastReview.load());

/** What a manager's team has waiting on it: stale reviews, blocked work, budgets past their warning share. */
export function reviewFindings(agent: Agent, at = Date.now()): string[] {
  const team = new Set(downline(agent.ownerId, agent).map((a) => a.id));
  if (team.size === 0) return [];
  const theirs = listTasks(agent.ownerId, agent.companyId, { status: "in_review,blocked" }).filter(
    (t) => t.assigneeAgentId && team.has(t.assigneeAgentId),
  );
  const findings = theirs.flatMap((t) =>
    t.status === "blocked"
      ? [`${t.identifier} is blocked: ${t.title}`]
      : at - Date.parse(t.updatedAt) > STALE_REVIEW_MS
        ? [`${t.identifier} has waited for review since ${t.updatedAt}: ${t.title}`]
        : [],
  );
  for (const p of budgetOverview(agent.ownerId, agent.companyId).policies)
    if (p.state !== "ok")
      findings.push(
        `The ${p.windowKind} budget for ${p.scopeName} is at ${(p.observedMicros / 1e6).toFixed(2)} of ${(p.amountMicros / 1e6).toFixed(2)} USD`,
      );
  return findings.sort();
}

/**
 * File a review task for a manager when its team has something new waiting,
 * so a quiet org still costs nothing. Returns the task, or null when there is nothing to file.
 */
function fileReview(agent: Agent, at: number): Task | null {
  const findings = reviewFindings(agent, at);
  const signature = findings.join("\n");
  if (findings.length === 0 || lastReview.get(agent.id)?.signature === signature) return null;
  const open = listTasks(agent.ownerId, agent.companyId, {
    assigneeAgentId: agent.id,
    status: "backlog,todo,in_progress,in_review,blocked",
  }).some((t) => t.createdBy.id === REVIEWER.id);
  if (open) return null;
  lastReview.set(agent.id, { id: agent.id, companyId: agent.companyId, signature });
  return createTask(
    agent.ownerId,
    agent.companyId,
    {
      title: `Review: ${findings.length} item${findings.length === 1 ? "" : "s"} waiting on your team`,
      description: `Look at each, then act: review the work, unblock or reassign it, or ask the board.\n\n${findings.map((f) => `- ${f}`).join("\n")}`,
      assigneeAgentId: agent.id,
      priority: "high",
    },
    REVIEWER,
  );
}

const lastTimerMinute = new Map<string, string>();

/** One scheduler pass. Exported so tests drive time explicitly. */
export function tick(at = new Date()): { woken: string[]; fired: string[] } {
  const woken: string[] = [];
  const fired: string[] = [];
  const minute = minuteKey(at);

  for (const agent of allAgents()) {
    const hb = agent.heartbeat;
    if (!hb.enabled || !invokability(agent.ownerId, agent).ok) continue;
    const due = isDue(
      {
        cron: hb.cron,
        intervalSec: hb.intervalSec,
        since: new Date(agent.lastHeartbeatAt ?? agent.createdAt),
        lastFiredMinute: lastTimerMinute.get(agent.id) ?? null,
      },
      at,
    );
    if (!due) continue;
    lastTimerMinute.set(agent.id, minute);
    const review = hasWork(agent) ? null : fileReview(agent, at.getTime());
    if (!review && !hasWork(agent)) continue;
    try {
      enqueueWake(agent.ownerId, agent.id, {
        source: "timer",
        reason: review ? review.title : "Heartbeat",
        ...(review ? { taskId: review.id } : {}),
      });
      woken.push(agent.id);
    } catch {
      /* terminated between checks */
    }
  }

  for (const r of [...routines.values()]) {
    if (!r.enabled || !isDue({ cron: r.cron, lastFiredMinute: r.lastFiredMinute }, at)) continue;
    routines.set(r.id, { ...r, lastFiredMinute: minute });
    try {
      if (fireRoutine(r.ownerId, r.id, "cron").result === "filed") fired.push(r.id);
    } catch {
      /* routine's company removed mid-tick */
    }
  }
  woken.push(...wakeApprovedGrants());
  reapStalled(at.getTime());
  for (const hook of tickHooks) hook(at);
  return { woken, fired };
}

const tickHooks: ((at: Date) => void)[] = [];
/** Run on every scheduler pass, for jobs that keep their own cadence. */
export function onTick(hook: (at: Date) => void): void {
  tickHooks.push(hook);
}

let timer: NodeJS.Timeout | null = null;

/** Start ticking every 30 s. Idempotent; the timer never holds the process open. */
export function startScheduler(): void {
  if (timer || process.env.NEXUS_ORG_SCHEDULER === "off") return;
  timer = setInterval(() => {
    try {
      tick();
    } catch {
      /* one bad row never stops the clock */
    }
  }, 30_000);
  timer.unref();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
