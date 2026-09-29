// SPDX-License-Identifier: Apache-2.0
/**
 * Agent runs: the wake queue, dispatch, and what one run does.
 *
 * A wake asks an agent to do one unit of work. A second wake for an agent that
 * already has one queued or running is folded into it (`coalescedCount`), so
 * a burst of assignments costs one run, not ten. Dispatch checks the agent is
 * invokable and every registered gate (budgets) passes, checks out the agent's
 * next task, runs the adapter inside the owner's user context — so a native
 * run uses their own provider keys first and its model calls land in its trace
 * — then applies the outcome the agent reported back to the task.
 *
 * The wake-coalescing queue and orphan recovery on boot follow Paperclip's
 * heartbeat service (https://github.com/paperclipai/paperclip, MIT License,
 * Copyright (c) 2025 Paperclip AI); the adapter contract is a reduced form of
 * its ServerAdapterModule.execute.
 */

import crypto from "node:crypto";

import { costLogStore, priceOf } from "./cost-log.js";
import { createNotification } from "./notifications-store.js";
import {
  addPromptContributor,
  buildPrompt,
  downline,
  parseOutcome,
  type ParsedOutcome,
} from "./org-protocol.js";
import {
  OrgError,
  createAgent,
  getAgent,
  getCompany,
  invokability,
  listAgents,
  logActivity,
  nextSeq,
  now,
  onOrgBoot,
  onOrgLoad,
  registerCompanyScoped,
  setAgentStatus,
  type AdapterType,
  type Agent,
  type Company,
} from "./org-store.js";
import {
  addComment,
  checkoutTask,
  createTask,
  findTask,
  getTask,
  listTasks,
  nextTaskFor,
  openBlockers,
  orgEvents,
  releaseTask,
  setTaskStatus,
  updateTask,
  type Actor,
  type Task,
  type TaskStatus,
} from "./org-work.js";
import { PersistentStore } from "./persistent-store.js";
import type { LlmStep } from "./request-traces.js";

// ── Types ────────────────────────────────────────────────────────────────────

export const WAKE_SOURCES = [
  "manual",
  "timer",
  "assignment",
  "comment",
  "unblocked",
  "routine",
  "approval",
] as const;
export type WakeSource = (typeof WAKE_SOURCES)[number];

export type RunStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "skipped";

export interface RunLogLine {
  ts: string;
  stream: "system" | "stdout" | "stderr" | "agent";
  text: string;
}

export interface RunOutcome {
  status: TaskStatus | "delegated" | null;
  summary: string;
  subtasks: string[];
}

export interface Run {
  id: string;
  ownerId: string;
  companyId: string;
  agentId: string;
  taskId: string | null;
  source: WakeSource;
  reason: string;
  status: RunStatus;
  adapterType: AdapterType;
  coalescedCount: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Every model call the run made: provider, model, tokens, latency, failover errors. */
  steps: LlmStep[];
  log: RunLogLine[];
  /** The exact prompt the adapter got, kept so the run can be replayed on another model. */
  prompt?: { system: string; user: string };
  output: string;
  outcome: RunOutcome | null;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  seq: number;
}

/** What an adapter gets for one run. */
export interface AdapterContext {
  run: Run;
  agent: Agent;
  company: Company;
  task: Task | null;
  prompt: { system: string; user: string };
  signal: AbortSignal;
  log: (stream: RunLogLine["stream"], text: string) => void;
  /**
   * Ask before each model call. Returns why the call may not happen (a budget
   * it could cross), or null. Adapters that call models must respect it.
   */
  guardCall: (model: string, promptChars: number, maxTokens: number) => string | null;
}

export interface AdapterResult {
  ok: boolean;
  output: string;
  error?: string;
  timedOut?: boolean;
  /** Adapter session to resume next run. */
  sessionId?: string | null;
  /** The adapter stopped because a guard refused a call; not a failure of the agent. */
  refused?: boolean;
  /** Usage the adapter measured itself (CLI adapters); native runs use their steps. */
  usage?: { inputTokens: number; outputTokens: number; model?: string; costUsd?: number };
}

export type Adapter = (ctx: AdapterContext) => Promise<AdapterResult>;

/** A gate returns why the run may not start, or null to let it through. */
type RunGate = (agent: Agent, task: Task | null) => string | null;

/** An agent asked the board to sign off before it continues. */
type ApprovalRequester = (
  run: Run,
  agent: Agent,
  task: Task,
  ask: { title: string; reason: string },
) => void;

/** Holds a task its agent called done for a review first; true means it is held in review. */
type DoneGate = (run: Run, agent: Agent, task: Task, deliverable: string) => boolean;

/** Refuses one model call mid-run, e.g. one that could cross a budget. */
type CallGuard = (
  run: Run,
  task: Task | null,
  model: string,
  promptChars: number,
  maxTokens: number,
) => string | null;

/** Hook after a run settles: spend accounting, memory, notifications. */
type RunListener = (run: Run) => void | Promise<void>;

// ── Registries ───────────────────────────────────────────────────────────────

const adapters = new Map<AdapterType, Adapter>();
const gates: RunGate[] = [];
const listeners: RunListener[] = [];
const callGuards: CallGuard[] = [];
const approvalRequesters: ApprovalRequester[] = [];
const doneGates: DoneGate[] = [];

export function registerAdapter(type: AdapterType, adapter: Adapter): void {
  adapters.set(type, adapter);
}
export function addRunGate(gate: RunGate): void {
  gates.push(gate);
}
export function onApprovalRequested(r: ApprovalRequester): void {
  approvalRequesters.push(r);
}
export function addDoneGate(g: DoneGate): void {
  doneGates.push(g);
}
export function addCallGuard(g: CallGuard): void {
  callGuards.push(g);
}
export function onRunFinished(l: RunListener): void {
  listeners.push(l);
}

/**
 * Runs execute outside any HTTP request; this puts the owner's identity and
 * provider keys around the adapter call. Injected by the route module so this
 * file stays free of the request stack.
 */
type ContextRunner = <T>(ownerId: string, steps: LlmStep[], fn: () => Promise<T>) => Promise<T>;
let withOwner: ContextRunner = (_o, _s, fn) => fn();
export function setOwnerContextRunner(runner: ContextRunner): void {
  withOwner = runner;
}
/** What traced model calls cost; a cache hit is free. */
export function stepsCostUsd(steps: LlmStep[]): number {
  return steps.reduce((sum, s) => {
    if (s.cached) return sum;
    const [pi, po] = priceOf(s.model, s.provider);
    return sum + (s.inputTokens * pi + s.outputTokens * po) / 1_000_000;
  }, 0);
}

export const runAsOwner: ContextRunner = (ownerId, steps, fn) => withOwner(ownerId, steps, fn);

// ── Storage ──────────────────────────────────────────────────────────────────

const runs = new PersistentStore<Run>("org_runs");
registerCompanyScoped(runs);
onOrgLoad(() => runs.load());
onOrgBoot(recoverOrphans);

const RUNS_KEPT_PER_COMPANY = 500;
const LOG_LINES = 400;
const TERMINAL: RunStatus[] = ["succeeded", "failed", "cancelled", "timed_out", "skipped"];

/**
 * A run that was queued or running when the process stopped cannot still be
 * alive. Mark it failed and free the task it held so the next wake can take it.
 */
function recoverOrphans(): void {
  for (const r of runs.values()) {
    if (TERMINAL.includes(r.status)) continue;
    const next: Run = {
      ...r,
      status: "failed",
      error: `${INTERRUPTED} the server stopped while this run was active.`,
      finishedAt: now(),
    };
    runs.set(r.id, next);
    if (r.taskId) {
      try {
        const t = getTask(r.ownerId, r.taskId);
        if (t.checkoutRunId === r.id) releaseTask(r.ownerId, r.taskId, r.id);
      } catch {
        /* task deleted */
      }
    }
    try {
      const a = getAgent(r.ownerId, r.agentId);
      if (a.status === "running") setAgentStatus(r.ownerId, a.id, "idle", { actorType: "system" });
    } catch {
      /* agent deleted */
    }
  }
}

export function listRuns(
  ownerId: string,
  companyId: string,
  filter: { agentId?: string; taskId?: string; limit?: number } = {},
): Run[] {
  getCompany(ownerId, companyId);
  return [...runs.values()]
    .filter(
      (r) =>
        r.ownerId === ownerId &&
        r.companyId === companyId &&
        (!filter.agentId || r.agentId === filter.agentId) &&
        (!filter.taskId || r.taskId === filter.taskId),
    )
    .sort((a, b) => b.seq - a.seq)
    .slice(0, Math.min(filter.limit ?? 100, 500));
}

export function getRun(ownerId: string, id: string): Run {
  const r = runs.get(id);
  if (!r || r.ownerId !== ownerId) throw new OrgError(404, "not_found", "Run not found.");
  return r;
}

/** Every run, for rollups (spend, dashboards). */
export function allRuns(): Run[] {
  return [...runs.values()];
}

/** When each running run was last written, so its log reaches the store while it runs. */
const savedAt = new Map<string, number>();

function save(run: Run): Run {
  runs.set(run.id, run);
  if (run.status === "running") savedAt.set(run.id, Date.now());
  else savedAt.delete(run.id);
  return run;
}

function prune(companyId: string): void {
  const rows = [...runs.values()].filter((r) => r.companyId === companyId);
  if (rows.length <= RUNS_KEPT_PER_COMPANY) return;
  rows.sort((a, b) => a.seq - b.seq);
  for (const old of rows.slice(0, rows.length - RUNS_KEPT_PER_COMPANY))
    if (TERMINAL.includes(old.status)) runs.delete(old.id);
}

// ── Wake queue ───────────────────────────────────────────────────────────────

const aborters = new Map<string, AbortController>();
const MAX_PARALLEL = 3;

interface WakeRequest {
  source: WakeSource;
  reason?: string;
  taskId?: string | null;
}

/**
 * Queue a run for the agent, or fold this wake into the one already queued or
 * running. Returns the run that will carry the work.
 */
export function enqueueWake(ownerId: string, agentId: string, wake: WakeRequest): Run {
  const agent = getAgent(ownerId, agentId);
  if (agent.status === "terminated") throw new OrgError(409, "conflict", "Agent is terminated.");
  if (wake.taskId) {
    const t = getTask(ownerId, wake.taskId);
    if (t.companyId !== agent.companyId)
      throw new OrgError(400, "invalid", "Task is in another company.");
  }
  const live = [...runs.values()].find(
    (r) => r.agentId === agentId && (r.status === "queued" || r.status === "running"),
  );
  if (live) {
    // Mutate in place: a running run's executor holds this object and keeps writing its log.
    live.coalescedCount++;
    if (live.status === "queued" && !live.taskId && wake.taskId) live.taskId = wake.taskId;
    return save(live);
  }
  const run: Run = save({
    id: crypto.randomUUID(),
    ownerId,
    companyId: agent.companyId,
    agentId,
    taskId: wake.taskId ?? null,
    source: wake.source,
    reason: wake.reason ?? wake.source,
    status: "queued",
    adapterType: agent.adapterType,
    coalescedCount: 0,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    steps: [],
    log: [],
    output: "",
    outcome: null,
    error: null,
    queuedAt: now(),
    startedAt: null,
    finishedAt: null,
    seq: nextSeq(),
  });
  setImmediate(drain);
  return run;
}

export function cancelRun(ownerId: string, id: string): Run {
  const r = getRun(ownerId, id);
  if (TERMINAL.includes(r.status)) return r;
  if (r.status === "queued") {
    return save({
      ...r,
      status: "cancelled",
      finishedAt: now(),
      error: "Cancelled before it started.",
    });
  }
  aborters.get(id)?.abort(new Error("cancelled"));
  return r;
}

/** Start queued runs, oldest first, up to the parallel cap. */
function drain(): void {
  const queued = [...runs.values()]
    .filter((r) => r.status === "queued")
    .sort((a, b) => a.seq - b.seq);
  for (const r of queued) {
    // Slots are counted from run state, so a run the watchdog closed frees its slot
    // even if its adapter never returns.
    const running = [...runs.values()].filter((o) => o.status === "running");
    if (running.length >= MAX_PARALLEL) return;
    if (running.some((o) => o.agentId === r.agentId)) continue;
    void execute(r).finally(() => setImmediate(drain));
  }
}

/** How long past its own timeout a run may stay "running" before the watchdog closes it. */
const STALL_GRACE_MS = 120_000;

/**
 * Close runs whose adapter outlived its deadline without settling — a child
 * that ignored its kill, a socket that never answered. The task is freed and
 * the agent returned to idle so the next wake can pick the work up.
 */
export function reapStalled(at = Date.now()): string[] {
  const reaped: string[] = [];
  for (const r of runs.values()) {
    if (r.status !== "running" || !r.startedAt) continue;
    let timeoutSec = 300;
    try {
      timeoutSec = Number(getAgent(r.ownerId, r.agentId).adapterConfig.timeoutSec ?? 300) || 300;
    } catch {
      /* agent gone: default deadline */
    }
    if (at - Date.parse(r.startedAt) < timeoutSec * 1000 + STALL_GRACE_MS) continue;
    aborters.get(r.id)?.abort(new Error("timeout"));
    r.status = "failed";
    r.error = `${STALLED} the run outlived its deadline and was closed by the watchdog.`;
    r.finishedAt = new Date(at).toISOString();
    push(r, "system", r.error);
    save(r);
    if (r.taskId) {
      try {
        if (getTask(r.ownerId, r.taskId).checkoutRunId === r.id)
          releaseTask(r.ownerId, r.taskId, r.id);
      } catch {
        /* task gone */
      }
    }
    try {
      if (getAgent(r.ownerId, r.agentId).status === "running")
        setAgentStatus(r.ownerId, r.agentId, "idle", { actorType: "system", actorId: "watchdog" });
    } catch {
      /* agent gone */
    }
    reaped.push(r.id);
  }
  return reaped;
}

/** Resolves once no run is queued or running; rejects after `timeoutMs`. */
export async function idle(timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (![...runs.values()].some((r) => r.status === "queued" || r.status === "running")) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("runs still active");
}

/** Apply the parsed outcome to the task: comment, subtasks, status, release. */
function applyOutcome(
  run: Run,
  agent: Agent,
  task: Task | null,
  parsed: ParsedOutcome,
): RunOutcome {
  const actor: Actor = { type: "agent", id: agent.id };
  const team = downline(run.ownerId, agent);
  const byName = (name: string) => {
    const n = name.trim().toLowerCase();
    if (!n || n === "yourself" || n === "me" || n === agent.name.toLowerCase()) return agent.id;
    return team.find((a) => a.name.toLowerCase() === n)?.id ?? null;
  };
  const created: string[] = [];
  for (const s of parsed.subtasks) {
    const sub = createTask(
      run.ownerId,
      run.companyId,
      {
        title: s.title,
        description: s.description,
        priority: ["critical", "high", "medium", "low"].includes(s.priority)
          ? s.priority
          : "medium",
        parentId: task?.id ?? null,
        assigneeAgentId: byName(s.assignee),
      },
      actor,
    );
    created.push(sub.id);
  }

  for (const a of parsed.assignments) {
    const target = findTask(run.ownerId, run.companyId, a.task);
    const who = byName(a.assignee);
    if (!target || target.assigneeAgentId || !who) continue;
    updateTask(run.ownerId, target.id, { assigneeAgentId: who }, actor);
    created.push(target.id);
  }

  for (const h of parsed.hires) {
    createAgent(
      run.ownerId,
      run.companyId,
      { ...h, reportsTo: agent.id, model: agent.model },
      actor,
    );
  }

  let status: RunOutcome["status"] = parsed.status;
  if (task) {
    if (parsed.deliverable)
      addComment(run.ownerId, task.id, parsed.deliverable.slice(0, 20_000), actor);
    let target: TaskStatus | null =
      status === "delegated" ? (created.length ? "blocked" : "in_review") : (status ?? "in_review");
    if (task.workMode === "planning" && target === "done") target = "in_review";
    if (parsed.approval && approvalRequesters.length) {
      target = "blocked";
      for (const r of approvalRequesters) r(run, agent, task, parsed.approval);
    }
    if (task.workMode === "ask" && target !== "blocked") target = "done";
    if (target === "done" && doneGates.some((g) => g(run, agent, task, parsed.deliverable)))
      target = "in_review";
    if (created.length && status === "delegated") {
      const current = getTask(run.ownerId, task.id);
      updateTask(run.ownerId, task.id, { blockedBy: [...current.blockedBy, ...created] }, actor);
    }
    const current = getTask(run.ownerId, task.id);
    if (current.checkoutRunId === run.id) releaseTask(run.ownerId, task.id, run.id);
    // Handed to someone else mid-run: the deliverable stays as a comment, the task is theirs now.
    if (current.assigneeAgentId !== agent.id) target = null;
    if (target && target !== current.status) {
      try {
        setTaskStatus(run.ownerId, task.id, target, actor);
      } catch {
        /* an illegal move leaves the task where it is, for the board to decide */
      }
    }
    status = target;
  }
  return { status, summary: parsed.summary, subtasks: created };
}

// ── Execute ──────────────────────────────────────────────────────────────────

// ponytail: a crash loses at most the last second of a run's log; write per line if that matters.
function push(run: Run, stream: RunLogLine["stream"], text: string): void {
  run.log.push({ ts: now(), stream, text: text.slice(0, 4000) });
  if (run.log.length > LOG_LINES) run.log.splice(0, run.log.length - LOG_LINES);
  if (run.status === "running" && Date.now() - (savedAt.get(run.id) ?? 0) >= 1000) save(run);
}

const INTERRUPTED = "Interrupted:";
const STALLED = "Stalled:";

// A cut-off run may have acted already (files written, messages sent), so the
// next run on the task sees what it logged instead of starting blind.
addPromptContributor(async ({ task, run }) => {
  if (!task) return null;
  const last = [...runs.values()]
    .filter(
      (r) =>
        r.taskId === task.id &&
        r.id !== run.id &&
        TERMINAL.includes(r.status) &&
        r.status !== "skipped",
    )
    .sort((a, b) => a.seq - b.seq)
    .pop();
  if (!last?.error?.startsWith(INTERRUPTED) && !last?.error?.startsWith(STALLED)) return null;
  const trail = last.log
    .filter((l) => l.stream !== "system")
    .slice(-20)
    .map((l) => `- ${l.text.slice(0, 300)}`);
  return [
    `An earlier attempt at this task was cut off (${last.error})`,
    trail.length ? "What it logged before stopping:" : "It logged nothing.",
    ...trail,
    "Its actions may already have taken effect; check before repeating any of them.",
  ].join("\n");
});

/** Persona text: the archetype's prompt when the agent has one. Injected by routes. */
let personaFor: (ownerId: string, agent: Agent) => string = () => "";
export function setPersonaResolver(fn: (ownerId: string, agent: Agent) => string): void {
  personaFor = fn;
}
export const personaOf = (ownerId: string, agent: Agent) => personaFor(ownerId, agent);

/** Never lets a bug in one run wedge the queue: the run fails and its task is freed. */
async function execute(queued: Run): Promise<void> {
  try {
    await executeRun(queued);
  } catch (err) {
    const r = runs.get(queued.id);
    if (!r || TERMINAL.includes(r.status)) return;
    r.status = "failed";
    r.error = `Internal error: ${(err as Error).message}`;
    r.finishedAt = now();
    save(r);
    if (r.taskId) {
      try {
        releaseTask(r.ownerId, r.taskId, r.id);
      } catch {
        /* task gone */
      }
    }
    try {
      if (getAgent(r.ownerId, r.agentId).status === "running")
        setAgentStatus(r.ownerId, r.agentId, "error", { actorType: "system" });
    } catch {
      /* agent gone */
    }
  }
}

async function executeRun(queued: Run): Promise<void> {
  const run: Run = { ...queued, status: "running", startedAt: now() };
  const finish = async (status: RunStatus, error: string | null = null) => {
    // The watchdog may already have closed a run whose adapter never returned.
    if (run.finishedAt) return;
    run.status = status;
    run.error = error;
    run.finishedAt = now();
    save(run);
    prune(run.companyId);
    for (const l of listeners) {
      try {
        await l(run);
      } catch {
        /* listeners are best-effort */
      }
    }
  };

  let agent: Agent;
  let company: Company;
  try {
    agent = getAgent(run.ownerId, run.agentId);
    company = getCompany(run.ownerId, run.companyId);
  } catch {
    return finish("skipped", "Agent or company no longer exists.");
  }
  const can = invokability(run.ownerId, agent);
  if (!can.ok) {
    push(run, "system", `Not started: ${can.reason}`);
    return finish("skipped", can.reason);
  }

  // Pick the work: the task the wake named, else the agent's next task.
  let task: Task | null = null;
  if (run.taskId) {
    try {
      const t = getTask(run.ownerId, run.taskId);
      if (t.status !== "done" && t.status !== "cancelled") task = t;
    } catch {
      /* deleted since the wake */
    }
  }
  task ??= nextTaskFor(run.ownerId, agent.id) ?? null;
  const hasTeam = downline(run.ownerId, agent).length > 0;
  const unassigned = listTasks(run.ownerId, agent.companyId, { status: "todo,backlog" }).some(
    (t) => !t.assigneeAgentId,
  );
  if (!task && !(hasTeam && unassigned)) {
    push(run, "system", "No work: nothing assigned and nothing to delegate.");
    return finish("skipped", null);
  }

  for (const gate of gates) {
    const why = gate(agent, task);
    if (why) {
      push(run, "system", `Not started: ${why}`);
      return finish("skipped", why);
    }
  }

  if (task) {
    if (task.assigneeAgentId !== agent.id && task.assigneeAgentId) {
      push(run, "system", `Task ${task.identifier} is assigned to someone else.`);
      return finish("skipped", "Task reassigned.");
    }
    if (openBlockers(task).length) {
      push(run, "system", `Task ${task.identifier} is waiting on its blockers.`);
      return finish("skipped", "Task is blocked.");
    }
    try {
      task = checkoutTask(run.ownerId, task.id, agent.id, run.id);
    } catch (err) {
      push(run, "system", `Checkout failed: ${(err as Error).message}`);
      return finish("skipped", (err as Error).message);
    }
    run.taskId = task.id;
  }

  const adapter = adapters.get(agent.adapterType);
  if (!adapter) {
    if (task) releaseTask(run.ownerId, task.id, run.id);
    return finish("failed", `No adapter registered for ${agent.adapterType}.`);
  }

  setAgentStatus(run.ownerId, agent.id, "running", { actorType: "system" });
  save(run);
  push(
    run,
    "system",
    task ? `Working on ${task.identifier}: ${task.title}` : "Triage: delegating unassigned work.",
  );

  const controller = new AbortController();
  aborters.set(run.id, controller);
  const timeoutSec = Number(agent.adapterConfig.timeoutSec ?? 300) || 300;
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutSec * 1000);

  let result: AdapterResult;
  try {
    const prompt = await buildPrompt(
      run.ownerId,
      agent,
      company,
      task,
      personaFor(run.ownerId, agent),
      run,
      (stream, text) => push(run, stream, text),
    );
    if (!prompt.refuse) run.prompt = { system: prompt.system, user: prompt.user };
    result = prompt.refuse
      ? { ok: false, refused: true, output: "", error: prompt.refuse }
      : await withOwner(run.ownerId, run.steps, () =>
          adapter({
            run,
            agent,
            company,
            task,
            prompt,
            signal: controller.signal,
            log: (stream, text) => push(run, stream, text),
            guardCall: (model, promptChars, maxTokens) => {
              for (const g of callGuards) {
                const why = g(run, task, model, promptChars, maxTokens);
                if (why) return why;
              }
              return null;
            },
          }),
        );
  } catch (err) {
    const reason = controller.signal.aborted ? String(controller.signal.reason?.message ?? "") : "";
    result = {
      ok: false,
      output: "",
      error: (err as Error).message,
      timedOut: reason === "timeout",
    };
    if (reason === "cancelled") result.error = "Cancelled.";
    if (reason === "timeout") result.error = `Timed out after ${timeoutSec}s.`;
  } finally {
    clearTimeout(timer);
    aborters.delete(run.id);
  }

  // Tokens and cost: the adapter's own numbers when it measured them, else the traced steps.
  if (result.usage) {
    run.inputTokens = result.usage.inputTokens;
    run.outputTokens = result.usage.outputTokens;
    run.model = result.usage.model ?? run.model;
    const [pi, po] = priceOf(run.model ?? "");
    run.costUsd =
      result.usage.costUsd ?? (run.inputTokens * pi + run.outputTokens * po) / 1_000_000;
  } else {
    run.inputTokens = run.steps.reduce((n, s) => n + s.inputTokens, 0);
    run.outputTokens = run.steps.reduce((n, s) => n + s.outputTokens, 0);
    run.model = run.steps.filter((s) => !s.error).at(-1)?.model ?? run.model;
    run.costUsd = stepsCostUsd(run.steps);
  }
  if (run.inputTokens + run.outputTokens > 0) {
    costLogStore.record({
      ts: now(),
      model: run.model ?? "unknown",
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      costUsd: run.costUsd,
      userId: run.ownerId,
    });
  }
  run.output = result.output.slice(0, 50_000);

  const cancelled = controller.signal.aborted && result.error === "Cancelled.";
  let status: RunStatus = result.refused
    ? "skipped"
    : result.ok
      ? "succeeded"
      : result.timedOut
        ? "timed_out"
        : cancelled
          ? "cancelled"
          : "failed";

  if (result.ok) {
    try {
      run.outcome = applyOutcome(run, agent, task, parseOutcome(result.output));
      push(
        run,
        "system",
        `Outcome: ${run.outcome.status ?? "no status"}${run.outcome.summary ? ` — ${run.outcome.summary}` : ""}`,
      );
    } catch (err) {
      status = "failed";
      result.error = `Could not apply the outcome: ${(err as Error).message}`;
    }
  }
  if (result.refused) {
    push(run, "system", `Stopped before a model call: ${result.error ?? ""}`);
    if (task) {
      const t = getTask(run.ownerId, task.id);
      if (t.checkoutRunId === run.id) releaseTask(run.ownerId, task.id, run.id);
    }
  } else if (!result.ok || status === "failed") {
    push(run, "stderr", result.error ?? "failed");
    if (task) {
      const t = getTask(run.ownerId, task.id);
      if (t.checkoutRunId === run.id) releaseTask(run.ownerId, task.id, run.id);
      if (!cancelled)
        addComment(run.ownerId, task.id, `Run failed: ${result.error ?? "unknown error"}`, {
          type: "system",
          id: "runtime",
        });
    }
  }

  const fresh = getAgent(run.ownerId, agent.id);
  if (fresh.status === "running") {
    setAgentStatus(
      run.ownerId,
      agent.id,
      status === "failed" || status === "timed_out" ? "error" : "idle",
      {
        actorType: "system",
        patch: {
          lastHeartbeatAt: now(),
          ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
        },
      },
    );
  }
  logActivity(company, {
    actorType: "agent",
    actorId: agent.id,
    action: `run.${status}`,
    entityType: "run",
    entityId: run.id,
    details: {
      name: agent.name,
      ...(task ? { title: `${task.identifier} ${task.title}` } : {}),
      costUsd: Number(run.costUsd.toFixed(6)),
      ...(result.error ? { reason: result.error.slice(0, 300) } : {}),
    },
  });
  if (status === "failed" || status === "timed_out") {
    void createNotification(run.ownerId, {
      type: "org",
      title: `${agent.name}'s run ${status === "timed_out" ? "timed out" : "failed"}`,
      message: (result.error ?? "").slice(0, 300),
      link: `/org?c=${company.id}&tab=runs`,
    });
  } else if (run.outcome?.status === "in_review" && task) {
    void createNotification(run.ownerId, {
      type: "org",
      title: `${task.identifier} is ready for review`,
      message: run.outcome.summary || task.title,
      link: `/org?c=${company.id}&tab=tasks`,
    });
  }
  await finish(status, result.ok && status !== "failed" ? null : (result.error ?? null));
}

// ── Unblocking ───────────────────────────────────────────────────────────────

/**
 * When a task finishes, any blocked task that was only waiting on it returns
 * to the queue — and its assignee is woken, so delegated work flows back up.
 */
orgEvents.on("task.status", (task, _from) => {
  if (task.status !== "done" && task.status !== "cancelled") return;
  for (const dep of listTasks(task.ownerId, task.companyId, { status: "blocked" })) {
    if (!dep.blockedBy.includes(task.id) || openBlockers(dep).length > 0) continue;
    try {
      const back = setTaskStatus(dep.ownerId, dep.id, "todo", { type: "system", id: "runtime" });
      if (back.assigneeAgentId)
        enqueueWake(dep.ownerId, back.assigneeAgentId, {
          source: "unblocked",
          reason: `${task.identifier} finished`,
          taskId: dep.id,
        });
    } catch {
      /* the board moved it; leave it */
    }
  }
});

// ── Asking the org ───────────────────────────────────────────────────────────

/**
 * A question for the org becomes an answer-only task for the named agent (the
 * top of the org by default), woken at once. The answer lands in the task's
 * thread; a question too big for one agent is delegated like any task.
 */
export function askOrg(ownerId: string, companyId: string, question: string, agentId?: string) {
  const q = question.trim().slice(0, 20_000);
  if (!q) throw new OrgError(400, "invalid", "Ask a question.");
  const live = listAgents(ownerId, companyId).filter(
    (a) => a.status !== "terminated" && a.status !== "pending_approval",
  );
  const agent = agentId
    ? live.find((a) => a.id === agentId)
    : (live.find((a) => !a.reportsTo) ?? live[0]);
  if (!agent) throw new OrgError(409, "conflict", "Hire an agent first.");
  const firstLine = q.split(/\r?\n/)[0]!;
  const task = createTask(ownerId, companyId, {
    title: firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine,
    description: q,
    assigneeAgentId: agent.id,
    workMode: "ask",
    priority: "high",
  });
  // With wake-on-assign the assignment event already queued a run; this folds into it.
  const run = enqueueWake(ownerId, agent.id, {
    source: "manual",
    reason: "Question from you",
    taskId: task.id,
  });
  return { task, agent: { id: agent.id, name: agent.name }, runId: run.id };
}
