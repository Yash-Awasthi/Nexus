// SPDX-License-Identifier: Apache-2.0
/**
 * Crew planner — decompose a goal into an executable task plan.
 *
 * @nexus/agents Crew executes pre-authored tasks (crew.ts). This module adds
 * the layer the role-based frameworks name as their planner: semantic-kernel's
 * planner picks an ordered set of calls for an ask, and CAMEL's task-inception
 * protocol breaks a high-level instruction into subtasks. Here the "functions"
 * are the crew's own roles: the planner receives the goal plus each role's
 * role/goal description and produces an ordered list of TaskConfigs, each
 * assigned to the role best suited to execute it.
 *
 * The model is asked for one strict, parseable format — numbered lines with an
 * optional `[role-name]` marker:
 *
 *   1. locate and summarise the incident report [researcher]
 *   2. draft the fix [engineer]
 *
 * Parsing is tolerant: unmarked steps default to the first role, and a reply
 * with no parseable numbered lines degrades to a single task carrying the
 * whole goal (an LLM that ignores the format still produces an executable
 * plan). The output feeds straight back into {@link Crew} as its `tasks`.
 */

import type { CrewLlm, RoleAgentConfig, TaskConfig } from "./crew.js";

export interface PlanOptions {
  /** What the crew should achieve. */
  goal: string;
  /** The roles the planner may assign steps to. */
  roles: readonly RoleAgentConfig[];
  /** Optional background material the planner should see. */
  context?: string;
  /** Cap on parsed steps. Default 10. */
  maxSteps?: number;
  llm: CrewLlm;
}

export interface PlanResult {
  /** Ordered executable tasks (feed into a Crew as `tasks`). */
  tasks: TaskConfig[];
  /** The raw planner reply, preserved for inspectability. */
  raw: string;
}

/** Role catalogue line the planner uses to choose assignees. */
function roleLine(role: RoleAgentConfig): string {
  const persona = role.backstory ? ` — ${role.backstory.split(".")[0]}` : "";
  return `- ${role.name}: ${role.role}${persona}`;
}

/**
 * Ask the planner LLM to decompose the goal. Deterministic to test: the whole
 * LLM interaction is a single `chat` call with the prompt below.
 */
export async function planTasks(opts: PlanOptions): Promise<PlanResult> {
  const { goal, roles, context, maxSteps = 10, llm } = opts;
  if (roles.length === 0) throw new Error("planner: at least one role is required");

  const contextBlock = context ? `\nContext:\n${context}\n` : "";
  const catalogue = roles.map(roleLine).join("\n");
  const prompt = [
    "You are a crew planner. Decompose the goal below into the smallest set of concrete, ordered, executable steps.",
    "",
    `Goal: ${goal}`,
    contextBlock,
    "Available roles:",
    catalogue,
    "",
    "Rules:",
    "- Each step must be executable by exactly one of the listed roles.",
    "- Steps must be ordered so earlier outputs feed later steps.",
    `- Reply with ONLY numbered lines, one step per line (max ${maxSteps}):`,
    "1. description of the step [role-name]",
    "2. description of the step [role-name]",
    "No preamble, no code fences, nothing else.",
  ].join("\n");

  const res = await llm.chat([{ role: "user", content: prompt }]);
  return { tasks: parsePlan(res.content, roles, maxSteps, goal), raw: res.content };
}

/**
 * Parse a planner reply into TaskConfigs. Tolerant: strip markdown fences,
 * accept `N. desc` or `N) desc`, an optional trailing `[role]` assigns the
 * step (unknown names fall back to the first role), and a reply with no
 * numbered lines becomes one task carrying the whole goal.
 */
export function parsePlan(
  raw: string,
  roles: readonly RoleAgentConfig[],
  maxSteps = 10,
  fallbackGoal = "",
): TaskConfig[] {
  const byName = new Map(roles.map((r) => [r.name.toLowerCase(), r.name]));
  const clean = raw.replace(/```[a-z]*\n?/gi, "").trim();
  const tasks: TaskConfig[] = [];

  for (const line of clean.split("\n")) {
    const match = /^\s*\d+\s*[.)-]\s*(?:[-*]\s+)?(.+)$/.exec(line.trim());
    if (!match) continue;
    let description = match[1]!.trim();
    let agent = roles[0]!.name; // unmarked steps default to the first role
    const marker = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(description);
    if (marker) {
      description = marker[1]!.trim();
      const wanted = marker[2]!.trim();
      agent = byName.get(wanted.toLowerCase()) ?? roles[0]!.name;
    }
    if (description.length === 0) continue;
    tasks.push({ description, agent });
    if (tasks.length >= maxSteps) break;
  }

  if (tasks.length === 0 && fallbackGoal.trim().length > 0) {
    tasks.push({ description: fallbackGoal, agent: roles[0]!.name });
  }
  return tasks;
}