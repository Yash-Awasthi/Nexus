// SPDX-License-Identifier: Apache-2.0
/**
 * AgentRuntimeAdapter — runs the native tool-calling ToolAgentRuntime
 * (@nexus/agent-runtime) behind the IExecutionAdapter seam, so the orchestrator /
 * task-executor can dispatch agentic coding tasks to a real multi-step loop
 * instead of the single-shot CodeAgentPool.
 *
 * The LLM is injected as an LlmToolFn — bridge a @nexus/llm-drivers driver with
 * `llmDriverToToolFn` at the app/worker layer (where BYOK keys live) — so this
 * package stays driver-agnostic and needs no llm-drivers dependency.
 */
import {
  ToolAgentRuntime,
  RuntimeToolSet,
  type LlmToolFn,
  type ToolStepRecord,
} from "@nexus/agent-runtime";

import type { IExecutionAdapter, IExecutionContext } from "./interfaces/execution.interface.js";

/** Task payload shape this adapter understands (narrowed from `unknown`). */
export interface AgentRuntimeTask {
  type?: string;
  /** The instruction / objective for the agent (first non-empty wins). */
  instruction?: string;
  prompt?: string;
  goal?: string;
  /** Per-task system-prompt override. */
  systemPrompt?: string;
  /** Per-task step-budget override. */
  maxSteps?: number;
}

export interface AgentRuntimeAdapterOptions {
  /** Tool-aware LLM — bridge an llm-drivers driver via `llmDriverToToolFn`. */
  llm: LlmToolFn;
  /** Tools available to the agent loop. */
  toolSet?: RuntimeToolSet;
  /** Default system prompt. */
  systemPrompt?: string;
  /** Default step budget (overridable per task). */
  maxSteps?: number;
  /** Task types this adapter claims (default: agent, code_agent, agent_run). */
  taskTypes?: string[];
  /** Per-step callback — e.g. forward progress to an SSE/event bus. */
  onStep?: (taskId: string, step: ToolStepRecord) => void;
}

const DEFAULT_TASK_TYPES = ["agent", "code_agent", "agent_run"];

function extractInstruction(task: unknown): string {
  const t = (task ?? {}) as AgentRuntimeTask;
  return (t.instruction ?? t.prompt ?? t.goal ?? "").trim();
}

export class AgentRuntimeAdapter implements IExecutionAdapter {
  private readonly llm: LlmToolFn;
  private readonly toolSet: RuntimeToolSet;
  private readonly systemPrompt?: string;
  private readonly maxSteps?: number;
  private readonly taskTypes: string[];
  private readonly onStep?: (taskId: string, step: ToolStepRecord) => void;

  constructor(opts: AgentRuntimeAdapterOptions) {
    this.llm = opts.llm;
    this.toolSet = opts.toolSet ?? new RuntimeToolSet();
    this.systemPrompt = opts.systemPrompt;
    this.maxSteps = opts.maxSteps;
    this.taskTypes = opts.taskTypes ?? DEFAULT_TASK_TYPES;
    this.onStep = opts.onStep;
  }

  canExecute(taskType: string): boolean {
    return this.taskTypes.includes(taskType);
  }

  async execute(task: unknown, context: IExecutionContext): Promise<Record<string, unknown>> {
    const t = (task ?? {}) as AgentRuntimeTask;
    const instruction = extractInstruction(task);
    if (!instruction) return { ok: false, error: "no_instruction" };

    const runtime = new ToolAgentRuntime({
      llm: this.llm,
      toolSet: this.toolSet,
      systemPrompt: t.systemPrompt ?? this.systemPrompt,
      maxSteps: t.maxSteps ?? this.maxSteps,
      onStep: this.onStep ? (step): void => this.onStep!(context.taskId, step) : undefined,
    });

    // NOTE: IExecutionContext carries no AbortSignal, so mid-run cancellation is
    // not available through this seam yet (the loop itself supports it).
    const result = await runtime.run(instruction);
    return {
      ok: !result.aborted,
      finalContent: result.finalContent,
      steps: result.steps.length,
      aborted: result.aborted,
      usage: result.totalUsage,
      durationMs: result.totalDurationMs,
    };
  }
}
