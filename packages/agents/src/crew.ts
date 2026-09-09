// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/agents — role-based Crew orchestration (crewAI / CAMEL parity).
 *
 * The three existing agents (Librarian / Researcher / FileExplorer) are
 * specialised *tools*; the agent-framework repos mapped to this package
 * (crewAI, CAMEL, Semantic Kernel's persona layer) are built on the opposite
 * primitive: agents defined by **role / goal / backstory**, joined into a
 * crew that executes a list of tasks through a process.
 *
 * crewAI's core model, kept behavioural and dependency-free:
 *
 *   RoleAgent   — name + role + goal + backstory (crewAI Agent). A role is the
 *                 full persona: the model is told who it is, what it is trying
 *                 to achieve, and the character notes behind it. Every run
 *                 builds the persona prompt from those fields.
 *   Task        — description + expected output + the role that should run it
 *                 (+ optional context: prior task outputs fed as material).
 *   Crew        — ordered agents + tasks + a process. `sequential` runs each
 *                 task on its assigned role in order, chaining context.
 *                 `hierarchical` adds a manager (the LLM) that delegates every
 *                 task to the best-suited role and iterates a delegate →
 *                 verify → refine loop until the output is accepted or the
 *                 iteration cap is hit (crewAI's manager + max-iterations).
 *
 * The LLM is injected (`CrewLlm`) so nothing here is provider-coupled and
 * tests use a deterministic scripted double. Unknown role names fall back to
 * the crew's first role, keeping delegation total even when a manager names a
 * role that was never configured.
 */

import { AgentError } from "./index.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface CrewLlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CrewLlm {
  /** One model turn; returns the assistant's text. */
  chat(
    messages: readonly CrewLlmMessage[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ content: string }>;
}

/** crewAI Agent — the persona fields that define a role. */
export interface RoleAgentConfig {
  /** Short identifier, e.g. "researcher". */
  name: string;
  /** The role the model plays, e.g. "Senior Research Analyst". */
  role: string;
  /** What the agent is trying to achieve on every task. */
  goal: string;
  /** Character notes / expertise behind the role (crewAI backstory). */
  backstory?: string;
}

/** crewAI Task — work assigned to a role. */
export interface TaskConfig {
  /** What must be done (the model's instruction). */
  description: string;
  /** The shape of a finished deliverable (crewAI expected_output). */
  expectedOutput?: string;
  /** Role-agent that runs this task (default: last role in the crew). */
  agent?: string;
  /** Names of prior tasks whose outputs feed this task as context. */
  context?: string[];
}

export type CrewProcess = "sequential" | "hierarchical";

export interface CrewConfig {
  roles: RoleAgentConfig[];
  tasks: TaskConfig[];
  /** How the crew executes its tasks (default: sequential). */
  process?: CrewProcess;
  llm: CrewLlm;
  /** Hierarchical only: max manager delegate→verify iterations per task. */
  maxIterations?: number;
}

export interface TaskResult {
  /** The task that was executed. */
  task: TaskConfig;
  /** Role that produced the output. */
  agent: string;
  output: string;
  /** Iterations taken (hierarchical refine loops; sequential is always 1). */
  iterations: number;
}

export interface CrewResult {
  results: TaskResult[];
  /** The final task's output — the crew's deliverable. */
  finalOutput: string;
  process: CrewProcess;
}

// ── RoleAgent ────────────────────────────────────────────────────────────────

/** One persona'd role; `run` answers a single prompt as that role. */
export class RoleAgent {
  constructor(readonly config: RoleAgentConfig) {}

  /** Assemble the system persona from role / goal / backstory. */
  systemPrompt(): string {
    const back = this.config.backstory ? `\n\n${this.config.backstory}` : "";
    return `You are ${this.config.role}. Goal: ${this.config.goal}.${back}`;
  }

  /**
   * Ask this role to do a task. `taskPrompt` carries the description, the
   * expected output shape, and any material (crew context) to work from.
   */
  async run(
    question: string,
    material: string,
    llm: CrewLlm,
    signal?: AbortSignal,
  ): Promise<string> {
    const ctx = material.trim()
      ? `Relevant context from earlier in the crew:\n---\n${material}\n---\n`
      : "";
    const res = await llm.chat(
      [
        { role: "system", content: this.systemPrompt() },
        { role: "user", content: `${ctx}${question}` },
      ],
      { signal },
    );
    return res.content.trim();
  }
}

// ── Task prompt building ─────────────────────────────────────────────────────

function taskPrompt(task: TaskConfig, crewInput: Record<string, unknown>): string {
  const input =
    Object.keys(crewInput).length > 0
      ? `Input the crew was asked to work on:\n${JSON.stringify(crewInput, null, 2)}\n`
      : "";
  const expected = task.expectedOutput ? `\n\nDeliverable shape: ${task.expectedOutput}` : "";
  return `${input}Task: ${task.description}${expected}`;
}

// ── Crew ─────────────────────────────────────────────────────────────────────

/**
 * Executes the crew: roles answer their assigned tasks through the injected
 * LLM. Sequential chains each task's context from earlier outputs;
 * hierarchical delegates through a manager and refines until accepted.
 */
export class Crew {
  private readonly roles: Map<string, RoleAgent>;
  private readonly config: CrewConfig;
  private readonly process: CrewProcess;
  private readonly maxIterations: number;

  constructor(config: CrewConfig) {
    if (config.roles.length === 0) throw new Error("crew: at least one role is required");
    if (config.tasks.length === 0) throw new Error("crew: at least one task is required");
    this.roles = new Map(config.roles.map((r) => [r.name, new RoleAgent(r)]));
    this.config = config;
    this.process = config.process ?? "sequential";
    this.maxIterations = config.maxIterations ?? 3;
  }

  /** Resolve the role for a task: explicit agent, else the last role. */
  private roleFor(task: TaskConfig): RoleAgent {
    return (
      (task.agent ? this.roles.get(task.agent) : undefined) ??
      this.roles.get([...this.roles.keys()].at(-1)!)!
    );
  }

  private outputById(results: TaskResult[], id: string): string {
    const idx = this.config.tasks.findIndex((t) => {
      const key = (t as TaskConfig & { id?: string }).id;
      return key === id;
    });
    if (idx >= 0) return results[idx]?.output ?? "";
    // Allow referencing by zero-based task position as a convenience.
    const n = Number(id);
    if (Number.isInteger(n) && n >= 0 && n < this.config.tasks.length) {
      return results[n]?.output ?? "";
    }
    return "";
  }

  private materialFor(task: TaskConfig, results: TaskResult[]): string {
    if (!task.context) return "";
    return task.context
      .map((id) => {
        const out = this.outputById(results, id);
        return out ? `[task ${id}]\n${out}` : "";
      })
      .filter((s) => s.length > 0)
      .join("\n\n");
  }

  /** Sequential: run tasks in order, each on its role, chaining context. */
  private async runSequential(
    crewInput: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<TaskResult[]> {
    const results: TaskResult[] = [];
    for (const task of this.config.tasks) {
      const role = this.roleFor(task);
      const output = await role.run(
        taskPrompt(task, crewInput),
        this.materialFor(task, results),
        this.config.llm,
        signal,
      );
      results.push({ task, agent: role.config.name, output, iterations: 1 });
    }
    return results;
  }

  /**
   * Hierarchical (crewAI manager): a manager LLM delegates each task to the
   * best-suited role, then verifies the output. On rejection it refines with
   * its feedback until the role answers DONE or maxIterations is hit.
   */
  private async runHierarchical(
    crewInput: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<TaskResult[]> {
    const results: TaskResult[] = [];
    const roster = [...this.roles.values()]
      .map((r) => `${r.config.name}: ${r.config.role}`)
      .join("\n");

    for (const task of this.config.tasks) {
      const question = taskPrompt(task, crewInput);
      let iterations = 0;
      let feedback = "";
      let lastOutput = "";
      let executor: RoleAgent = this.roleFor(task);

      while (iterations < this.maxIterations) {
        iterations += 1;
        // 1. Delegate — manager picks the executor by name.
        const pick = await this.config.llm.chat(
          [
            {
              role: "system",
              content:
                "You are the crew manager. Delegate the task to exactly one role from the roster by replying with only the role's name.",
            },
            {
              role: "user",
              content: `${roster}\n\nTask: ${question}\n${feedback ? `Previous attempt feedback: ${feedback}` : ""}`,
            },
          ],
          { signal },
        );
        const assigned = pick.content.trim().toLowerCase();
        executor = this.roles.get(assigned) ?? this.roleFor(task);

        // 2. Execute.
        lastOutput = await executor.run(
          question,
          this.materialFor(task, results),
          this.config.llm,
          signal,
        );

        // 3. Verify — manager accepts (DONE) or returns refinement feedback.
        const verdict = await this.config.llm.chat(
          [
            {
              role: "system",
              content:
                "You are the crew manager verifying a delegated task. If the deliverable is complete, reply with exactly: DONE. Otherwise reply with specific feedback on what to fix.",
            },
            {
              role: "user",
              content: `Task: ${question}\n\nDelegated to: ${executor.config.name}\n\nOutput:\n${lastOutput}`,
            },
          ],
          { signal },
        );
        const answer = verdict.content.trim();
        if (answer.toUpperCase().startsWith("DONE")) break;
        feedback = answer;
      }

      results.push({
        task,
        // Report the role that actually produced the output (delegation to an
        // unknown name falls back to the task's default role).
        agent: executor.config.name,
        output: lastOutput,
        iterations,
      });
    }
    return results;
  }

  /** Run the crew. Returns per-task results and the final deliverable. */
  async kickoff(
    crewInput: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<CrewResult> {
    if (signal?.aborted) throw new AgentError("CREW_FAILED", "crew aborted before start");
    const results =
      this.process === "hierarchical"
        ? await this.runHierarchical(crewInput, signal)
        : await this.runSequential(crewInput, signal);
    return {
      results,
      finalOutput: results.at(-1)?.output ?? "",
      process: this.process,
    };
  }
}
