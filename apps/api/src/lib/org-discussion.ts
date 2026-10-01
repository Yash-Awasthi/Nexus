// SPDX-License-Identifier: Apache-2.0
/**
 * A discussion on a task between named agents. It runs on the council's
 * debate: every round each agent sees the others' latest points and answers,
 * until they all hold the same position or the round cap is hit. Each turn
 * lands in the task thread as that agent's comment, is checked against the
 * agent's budgets first, and is billed to it.
 */

import { MAX_DEBATE_ROUNDS, runCouncilDebate, type DebateMember } from "@nexus/council";
import { globalFlags } from "@nexus/feature-flags";

import { callAllowance, estimateCallMicros, recordRunSpend } from "./org-budget.js";
import { addLesson } from "./org-memory.js";
import { personaOf, runAsOwner, stepsCostUsd } from "./org-runtime.js";
import {
  OrgError,
  getAgent,
  getCompany,
  invalid,
  invokability,
  onOrgBoot,
  onOrgLoad,
  registerCompanyScoped,
  type Agent,
} from "./org-store.js";
import {
  addComment,
  createTask,
  getTask,
  listComments,
  orgEvents,
  taskContext,
} from "./org-work.js";
import { PersistentStore } from "./persistent-store.js";
import type { LlmStep } from "./request-traces.js";

const MAX_TOKENS = 700;
const SYSTEM = { type: "system", id: "discussion" } as const;

type Message = { role: "system" | "user" | "assistant"; content: string };
/** One model call for an agent on the owner's keys; it pushes its traced steps. Injected by routes. */
export type Speaker = (
  agent: Agent,
  messages: Message[],
  steps: LlmStep[],
  maxTokens: number,
  /** Why a call on this model may not happen (a budget it could cross), or null. */
  guard: (model: string) => string | null,
) => Promise<string>;

let speaker: Speaker | null = null;
export function setDiscussionSpeaker(fn: Speaker): void {
  speaker = fn;
}

/** Running discussions by task id; a row left at boot was cut off by a restart. */
const active = new PersistentStore<{ id: string; ownerId: string; companyId: string }>(
  "org_discussions",
);
registerCompanyScoped(active);
onOrgLoad(() => active.load());
onOrgBoot(() => {
  for (const d of [...active.values()]) {
    active.delete(d.id);
    try {
      addComment(d.ownerId, d.id, "Discussion interrupted by a restart.", SYSTEM);
    } catch {
      /* task deleted */
    }
  }
});

/** Decisions a discussion filed, by the filed task's id, so the thread hears how each ended. */
const filedDecisions = new PersistentStore<{
  id: string;
  ownerId: string;
  companyId: string;
  threadId: string;
}>("org_discussion_decisions");
registerCompanyScoped(filedDecisions);
onOrgLoad(() => filedDecisions.load());

orgEvents.on("task.status", (task) => {
  if (task.status !== "done" && task.status !== "cancelled") return;
  const row = filedDecisions.get(task.id);
  if (!row) return;
  filedDecisions.delete(task.id);
  const last = listComments(task.ownerId, task.id)
    .filter((c) => c.author.type === "agent")
    .at(-1);
  const said = last?.body;
  const outcome =
    task.status === "done"
      ? `${task.identifier} is done: ${task.title}.${said ? `\n\n${said.slice(0, 1_500)}` : ""}`
      : `${task.identifier} was cancelled, so "${task.title}" did not happen.`;
  try {
    // Quoted agent text is posted as that agent, so later prompts never read it as the system's.
    addComment(task.ownerId, row.threadId, outcome, said ? last.author : SYSTEM);
    // What was decided and how it ended is recalled the next time the question comes up.
    const question = getTask(task.ownerId, row.threadId);
    addLesson({
      ownerId: task.ownerId,
      companyId: task.companyId,
      agentId: task.assigneeAgentId,
      kind: "decision",
      text:
        `Decided on "${question.title}": ${task.title}. ` +
        (task.status === "done"
          ? `It was carried out.${said ? ` ${said.slice(0, 300)}` : ""}`
          : "It was dropped before it was done."),
      source: question.identifier,
    });
  } catch {
    /* the discussion's task was deleted */
  }
});

/** Why this agent may not speak now: it, a manager above it, or its company is paused. */
function silenced(ownerId: string, agent: Agent): string | null {
  const now = getAgent(ownerId, agent.id);
  // An agent busy with its own run may still take part.
  const inv = invokability(ownerId, now.status === "running" ? { ...now, status: "idle" } : now);
  return inv.ok ? null : inv.reason;
}

export interface DiscussionResult {
  rounds: number;
  agreed: boolean;
  position: string | null;
  /** The subtask the agreed decision was filed as, when that was asked for. */
  filedTaskId?: string;
}

export interface DiscussionOptions {
  rounds?: unknown;
  /** Agents answer in order within a round, each seeing the turns before it. */
  inOrder?: unknown;
  /** On agreement, the most senior agent in the discussion gets the decision as a subtask. */
  fileOutcome?: unknown;
}

/** The participant highest in the org chart; the first listed wins a tie. */
function seniorOf(ownerId: string, agents: Agent[]): Agent {
  const depth = (a: Agent) => {
    let d = 0;
    const seen = new Set<string>();
    for (let m = a.reportsTo; m && !seen.has(m); d++) {
      seen.add(m);
      try {
        m = getAgent(ownerId, m).reportsTo;
      } catch {
        break;
      }
    }
    return d;
  };
  return agents.reduce((best, a) => (depth(a) < depth(best) ? a : best));
}

/** Validate and start a discussion; it runs in the background and writes into the thread. */
export function startDiscussion(
  ownerId: string,
  taskId: string,
  agentIds: unknown,
  opts: DiscussionOptions = {},
): {
  taskId: string;
  agents: string[];
  rounds: number;
  inOrder: boolean;
  done: Promise<DiscussionResult>;
} {
  const task = getTask(ownerId, taskId);
  if (!Array.isArray(agentIds)) throw invalid("Name the agents to discuss.");
  const agents = [...new Set(agentIds.map(String))].map((id) => getAgent(ownerId, id));
  if (agents.length < 2 || agents.length > 5)
    throw invalid("A discussion needs two to five agents.");
  for (const a of agents) {
    if (a.companyId !== task.companyId) throw invalid(`${a.name} is not in this company.`);
    if (a.status === "terminated") throw invalid(`${a.name} was terminated.`);
    if (a.adapterType !== "nexus")
      throw invalid(`${a.name} runs a CLI and cannot join a discussion.`);
    const why = silenced(ownerId, a);
    if (why) throw new OrgError(409, "conflict", `${a.name} cannot take part: ${why}`);
  }
  if (!speaker) throw invalid("Discussions need the built-in model runtime.");
  if (active.has(taskId))
    throw new OrgError(409, "conflict", "A discussion is already running here.");
  const flagCap = globalFlags.getFlag("council.max_debate_rounds", MAX_DEBATE_ROUNDS);
  const cap = Math.max(
    1,
    Math.min(MAX_DEBATE_ROUNDS, flagCap, Math.round(Number(opts.rounds) || 3)),
  );
  active.set(taskId, { id: taskId, ownerId, companyId: task.companyId });
  // Nobody awaits this from a request, so a failure must end here, not as an unhandled rejection.
  const sequential = opts.inOrder === true;
  const done = discuss(ownerId, taskId, agents, cap, sequential, opts.fileOutcome === true)
    .catch((err: unknown) => {
      try {
        addComment(ownerId, taskId, `Discussion stopped: ${(err as Error).message}`, SYSTEM);
      } catch {
        /* task removed mid-discussion */
      }
      return { rounds: 0, agreed: false, position: null };
    })
    .finally(() => active.delete(taskId));
  return {
    taskId,
    agents: agents.map((a) => a.name),
    rounds: cap,
    inOrder: sequential,
    done,
  };
}

async function discuss(
  ownerId: string,
  taskId: string,
  agents: Agent[],
  rounds: number,
  sequential: boolean,
  fileOutcome: boolean,
): Promise<DiscussionResult> {
  const task = getTask(ownerId, taskId);
  const company = getCompany(ownerId, task.companyId);
  const byLabel = new Map(agents.map((a) => [a.name, a]));
  const recent = listComments(ownerId, taskId)
    .slice(-6)
    .map((c) => `[${c.author.type}] ${c.body.slice(0, 800)}`);
  const message = [
    taskContext(ownerId, task),
    task.description ? `Details: ${task.description}` : "",
    recent.length ? `Thread so far:\n${recent.join("\n")}` : "",
    `You are discussing this task with ${agents.map((a) => `${a.name} (${a.role})`).join(", ")}.`,
    "Say what should be done and why, answer the others' points, and change your mind when they are right. Under 150 words.",
    // Agreement is scored on the FINAL lines, so they must name the decision, not argue it.
    "Your FINAL line names the decision alone in five words or fewer, e.g. `FINAL: use SQLite`.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const members: DebateMember[] = agents.map((a) => ({
    label: a.name,
    provider: "org",
    model: a.model ?? "default",
    systemPrompt: [
      personaOf(ownerId, a),
      `You are ${a.name}, ${a.role} at ${company.name}. ${a.capabilities}`.trim(),
    ]
      .filter(Boolean)
      .join("\n\n"),
  }));

  const outcome = await runCouncilDebate(
    {
      streamMember: async (member, messages) => {
        const agent = byLabel.get(member.label)!;
        const why = silenced(ownerId, agent);
        if (why) throw new Error(why);
        const chars = messages.reduce((n, m) => n + m.content.length, 0);
        const guard = (model: string) =>
          callAllowance(
            { ownerId, companyId: task.companyId, agentId: agent.id, steps: [] },
            task,
            estimateCallMicros(model, chars, MAX_TOKENS),
          );
        const steps: LlmStep[] = [];
        const text = await runAsOwner(ownerId, steps, () =>
          speaker!(agent, messages as Message[], steps, MAX_TOKENS, guard),
        );
        recordRunSpend({
          ownerId,
          companyId: task.companyId,
          agentId: agent.id,
          taskId,
          costUsd: stepsCostUsd(steps),
        });
        if (!text.trim()) throw new Error("the model returned an empty answer");
        addComment(ownerId, taskId, text, { type: "agent", id: agent.id });
        return { text };
      },
    },
    { message, members, rounds, untilAgreed: true, sequential },
    {
      onDelta: () => undefined,
      onMemberError: (member, err) =>
        addComment(
          ownerId,
          taskId,
          `${member.label} could not answer: ${(err as Error).message}`,
          SYSTEM,
        ),
    },
  );

  const agreed = outcome.agreement?.agreement === 1;
  const position = outcome.agreement?.representative ?? null;
  addComment(
    ownerId,
    taskId,
    agreed
      ? `Discussion settled after ${outcome.rounds} round${outcome.rounds === 1 ? "" : "s"}: ${position}`
      : `Discussion ended after ${outcome.rounds} round${outcome.rounds === 1 ? "" : "s"} without agreement.`,
    SYSTEM,
  );
  if (!agreed || !position || !fileOutcome) return { rounds: outcome.rounds, agreed, position };
  const lead = seniorOf(ownerId, agents);
  const filed = createTask(
    ownerId,
    task.companyId,
    {
      title: `Carry out: ${position}`.slice(0, 200),
      description: `Agreed in the discussion on ${task.identifier} (${task.title}). Make it happen, or report back if it no longer holds.`,
      parentId: taskId,
      assigneeAgentId: lead.id,
    },
    SYSTEM,
  );
  filedDecisions.set(filed.id, {
    id: filed.id,
    ownerId,
    companyId: task.companyId,
    threadId: taskId,
  });
  addComment(ownerId, taskId, `Filed ${filed.identifier} for ${lead.name}.`, SYSTEM);
  return { rounds: outcome.rounds, agreed, position, filedTaskId: filed.id };
}
