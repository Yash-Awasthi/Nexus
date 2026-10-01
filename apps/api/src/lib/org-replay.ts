// SPDX-License-Identifier: Apache-2.0
/**
 * Replay a run: send the exact prompt it ran on to another model and diff the
 * two answers. The call is checked against the run's budgets first and billed
 * to the same agent, goal and company; the task is never touched.
 */

import { priceKey } from "./cost-log.js";
import { callAllowance, estimateCallMicros, recordRunSpend } from "./org-budget.js";
import { parseOutcome } from "./org-protocol.js";
import { allRuns, getRun, listRuns, runAsOwner, stepsCostUsd } from "./org-runtime.js";
import {
  OrgError,
  getAgent,
  getCompany,
  invalid,
  invokability,
  listActivity,
  logActivity,
  onOrgLoad,
  registerCompanyScoped,
  updateAgent,
} from "./org-store.js";
import { getTask } from "./org-work.js";
import { PersistentStore } from "./persistent-store.js";
import type { LlmStep } from "./request-traces.js";

const MAX_TOKENS = 2048;

type Prompt = { system: string; user: string };
/** One model call on the owner's keys; it pushes its traced steps. Injected by the route module. */
export type ReplayCaller = (
  model: string,
  prompt: Prompt,
  steps: LlmStep[],
) => Promise<{ content: string; model: string }>;

let caller: ReplayCaller | null = null;
export function setReplayCaller(fn: ReplayCaller): void {
  caller = fn;
}

export interface DiffLine {
  op: " " | "-" | "+";
  line: string;
}

/** Line diff by longest common subsequence; answers are short, so O(n·m) is fine. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const lcs = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      lcs[i]![j] =
        x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push({ op: " ", line: x[i++]! });
      j++;
    } else if (j < y.length && (i === x.length || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) {
      out.push({ op: "+", line: y[j++]! });
    } else {
      out.push({ op: "-", line: x[i++]! });
    }
  }
  return out;
}

/** Each replay's cost and whether it reported the status the run did, keyed `runId:model`. */
const scores = new PersistentStore<{
  id: string;
  ownerId: string;
  companyId: string;
  agentId: string;
  model: string;
  agreed: boolean;
  costUsd: number;
}>("org_replay_scores");
registerCompanyScoped(scores);
onOrgLoad(() => scores.load());

export async function replayRun(ownerId: string, runId: string, model: string) {
  const run = getRun(ownerId, runId);
  if (!run.prompt) throw invalid("This run kept no prompt to replay.");
  if (!caller) throw invalid("Replays need the built-in model runtime.");
  if (!getCompany(ownerId, run.companyId).replaysWhilePaused) {
    const agent = getAgent(ownerId, run.agentId);
    // Only a pause stops a replay; a busy or retired agent's old run may still be compared.
    const inv = invokability(
      ownerId,
      agent.status === "paused" ? agent : { ...agent, status: "idle" },
    );
    if (!inv.ok)
      throw new OrgError(409, "paused", `${inv.reason} Replays do not run while paused.`);
  }
  const task = run.taskId ? getTask(ownerId, run.taskId) : null;
  const chars = run.prompt.system.length + run.prompt.user.length;
  const refusal = callAllowance(
    { ...run, steps: [] },
    task,
    estimateCallMicros(model, chars, MAX_TOKENS),
  );
  if (refusal) throw new OrgError(409, "budget", refusal);

  const steps: LlmStep[] = [];
  const prompt = run.prompt;
  const res = await runAsOwner(ownerId, steps, () => caller!(model, prompt, steps));
  const costUsd = stepsCostUsd(steps);
  recordRunSpend({ ...run, costUsd });
  scores.set(`${runId}:${model}`, {
    id: `${runId}:${model}`,
    ownerId,
    companyId: run.companyId,
    agentId: run.agentId,
    model,
    agreed: parseOutcome(res.content).status === (run.outcome?.status ?? null),
    costUsd,
  });
  followScorecard(ownerId, run.agentId);
  return {
    runId,
    original: { model: run.model, output: run.output },
    replay: { model: res.model, output: res.content, costUsd, steps },
    diff: lineDiff(run.output, res.content),
  };
}

const TASK_REPLAY_RUNS = 10;

export interface TaskReplayRow {
  runId: string;
  originalModel: string | null;
  originalCostUsd: number;
  originalStatus: string | null;
  replayModel: string;
  replayCostUsd: number;
  replayStatus: string | null;
  changedLines: number;
}

/**
 * Replay a task's runs, oldest first, on another model and compare what each cost and which
 * status it reported. Runs one call at a time so every call meets the budget check; the first
 * refusal ends the sweep and is reported as `stopped`.
 */
export async function replayTask(ownerId: string, taskId: string, model: string) {
  const task = getTask(ownerId, taskId);
  const runs = listRuns(ownerId, task.companyId, { taskId, limit: 200 })
    .filter((r) => r.prompt)
    .slice(0, TASK_REPLAY_RUNS)
    .reverse();
  if (runs.length === 0) throw invalid("No run of this task kept a prompt to replay.");
  const rows: TaskReplayRow[] = [];
  let stopped: string | null = null;
  for (const run of runs) {
    try {
      const r = await replayRun(ownerId, run.id, model);
      rows.push({
        runId: run.id,
        originalModel: run.model,
        originalCostUsd: run.costUsd,
        originalStatus: run.outcome?.status ?? null,
        replayModel: r.replay.model,
        replayCostUsd: r.replay.costUsd,
        replayStatus: parseOutcome(r.replay.output).status,
        changedLines: r.diff.filter((d) => d.op !== " ").length,
      });
    } catch (err) {
      // A refusal or a provider failure ends the sweep; the rows so far still stand.
      if (!(err instanceof OrgError)) throw err;
      stopped = err.message;
      break;
    }
  }
  const sum = (k: "originalCostUsd" | "replayCostUsd") => rows.reduce((n, r) => n + r[k], 0);
  return {
    taskId,
    model,
    rows,
    stopped,
    totals: { originalCostUsd: sum("originalCostUsd"), replayCostUsd: sum("replayCostUsd") },
  };
}

/** Replays needed, and the share of them that must agree, before a cheaper model is suggested. */
const MIN_REPLAYS = 3;
const MIN_AGREEMENT = 0.8;

/**
 * Per model, what an agent's own runs and its replays show: runs and how many ended done,
 * replays and how often they reported the run's status, and the mean cost of a call either way.
 * Suggests the cheapest model that agreed often enough and costs less than the current one.
 */
export function modelScorecard(ownerId: string, agentId: string) {
  const agent = getAgent(ownerId, agentId);
  const rows = new Map<
    string,
    { runs: number; done: number; replayed: number; agreed: number; cost: number }
  >();
  const row = (model: string) => {
    let r = rows.get(model);
    if (!r) rows.set(model, (r = { runs: 0, done: 0, replayed: 0, agreed: 0, cost: 0 }));
    return r;
  };
  for (const run of allRuns()) {
    if (run.ownerId !== ownerId || run.agentId !== agentId) continue;
    if (run.status !== "succeeded" && run.status !== "failed" && run.status !== "timed_out")
      continue;
    const step = run.steps.filter((x) => !x.error).at(-1);
    const model = step ? priceKey(step.model, step.provider) : run.model;
    if (!model) continue;
    const r = row(model);
    r.runs++;
    if (run.outcome?.status === "done") r.done++;
    r.cost += run.costUsd;
  }
  for (const s of scores.values()) {
    if (s.ownerId !== ownerId || s.agentId !== agentId) continue;
    const r = row(s.model);
    r.replayed++;
    if (s.agreed) r.agreed++;
    r.cost += s.costUsd;
  }
  const models = [...rows].map(([model, r]) => ({
    model,
    runs: r.runs,
    doneRate: r.runs ? r.done / r.runs : null,
    replayed: r.replayed,
    agreement: r.replayed ? r.agreed / r.replayed : null,
    avgCostUsd: r.runs + r.replayed ? r.cost / (r.runs + r.replayed) : null,
  }));
  const current = agent.model ?? [...models].sort((a, b) => b.runs - a.runs)[0]?.model ?? null;
  const baseline = models.find((m) => m.model === current)?.avgCostUsd ?? null;
  const pick = models
    .filter(
      (m) =>
        m.model !== current &&
        m.replayed >= MIN_REPLAYS &&
        (m.agreement ?? 0) >= MIN_AGREEMENT &&
        baseline !== null &&
        (m.avgCostUsd ?? Infinity) < baseline,
    )
    .sort((a, b) => a.avgCostUsd! - b.avgCostUsd!)[0];
  const recommendation =
    pick && baseline
      ? {
          model: pick.model,
          reason: `Reported the same status as ${current} on ${Math.round(pick.agreement! * pick.replayed)} of ${pick.replayed} replayed runs, at ${Math.round((1 - pick.avgCostUsd! / baseline) * 100)}% less per call.`,
        }
      : null;
  const autoSwitch = modelSwitches(ownerId, agent.companyId, agentId).find((s) => s.to === current);
  return { agentId, current, models, recommendation, autoSwitch: autoSwitch ?? null };
}

/** The scorecard's own model moves for an agent, newest first. */
function modelSwitches(ownerId: string, companyId: string, agentId: string) {
  return listActivity(ownerId, companyId, 500)
    .filter((a) => a.action === "agent.model_switched" && a.entityId === agentId)
    .map((a) => ({
      from: String(a.details.from ?? ""),
      to: String(a.details.to),
      at: a.createdAt,
    }));
}

/**
 * In a company that opted in, move the agent to its recommended model. Each move is made once,
 * so an owner who switches back keeps their choice.
 */
function followScorecard(ownerId: string, agentId: string): void {
  const agent = getAgent(ownerId, agentId);
  const company = getCompany(ownerId, agent.companyId);
  if (!company.autoModel) return;
  const rec = modelScorecard(ownerId, agentId).recommendation;
  if (!rec || rec.model === agent.model) return;
  if (modelSwitches(ownerId, company.id, agentId).some((s) => s.to === rec.model)) return;
  updateAgent(ownerId, agentId, { model: rec.model });
  logActivity(company, {
    actorType: "system",
    actorId: "scorecard",
    action: "agent.model_switched",
    entityType: "agent",
    entityId: agentId,
    details: { from: agent.model, to: rec.model, reason: rec.reason },
  });
}
