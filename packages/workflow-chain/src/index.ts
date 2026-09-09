// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/workflow-chain — Fluent workflow chain API.
 *
 * Provides a builder-pattern API for composing multi-step workflows with
 * typed data flow between steps, suspend/resume support, branching, loops,
 * and parallel execution.  Inspired by VoltAgent's createWorkflowChain.
 *
 * Usage:
 *   const workflow = createWorkflowChain({ id: "demo", ... })
 *     .andThen({ id: "step1", execute: async ({ data }) => ... })
 *     .andWhen({ id: "branch", condition: async ({ data }) => ..., execute: ... })
 *     .andAgent({ id: "ai", agent: myAgent, task: ({ data }) => ... })
 *     .andParallel([{ id: "a", ... }, { id: "b", ... }])
 *     .andFinally({ id: "done", execute: async ({ data }) => data });
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type StepId = string;

export interface WorkflowStepState<INPUT> {
  input: INPUT;
  /** Map of stepId → step output */
  outputs: Record<string, unknown>;
  /** Current step that is executing */
  currentStep?: StepId;
  /** Steps that have been skipped */
  skipped: Set<string>;
  /** Steps that are currently suspended */
  suspended: Set<string>;
}

export interface StepContext<INPUT, DATA> {
  data: DATA;
  input: INPUT;
  state: WorkflowStepState<INPUT>;
  /** Get the output of a previous step by its id */
  getStepOutput<T = unknown>(stepId: string): T | undefined;
  /** Suspend the workflow, returning control to the caller */
  suspend(reason?: string, suspendData?: unknown): Promise<never>;
  /** Resume data if this step was previously suspended */
  resumeData?: unknown;
  /** Current retry attempt (0 = first run) */
  retryCount: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Emit a progress event */
  emit(event: WorkflowEvent): void;
}

export interface FunctionStepConfig<INPUT, DATA, OUTPUT> {
  id: StepId;
  name?: string;
  execute: (ctx: StepContext<INPUT, DATA>) => Promise<OUTPUT>;
  retries?: number;
  timeout?: number;
  /**
   * Saga compensation (Temporal parity): runs with this step's output when
   * a later step fails, in reverse completion order, so side effects can be
   * undone. Runs on failures and aborts, but not on suspension.
   */
  compensate?: (ctx: StepContext<INPUT, DATA>, output: OUTPUT) => void | Promise<void>;
}

export interface ConditionalStepConfig<INPUT, DATA, OUTPUT> {
  id: StepId;
  name?: string;
  condition: (ctx: StepContext<INPUT, DATA>) => Promise<boolean> | boolean;
  execute: (ctx: StepContext<INPUT, DATA>) => Promise<OUTPUT>;
  /** Step to execute when condition is false */
  otherwise?: (ctx: StepContext<INPUT, DATA>) => Promise<OUTPUT>;
  retries?: number;
}

export interface AgentStepConfig<INPUT, DATA> {
  id: StepId;
  name?: string;
  /** The agent to execute */
  agent: { generate(input: string): Promise<string> };
  /** Task prompt — can be a string or function returning a prompt */
  task: string | ((ctx: StepContext<INPUT, DATA>) => string);
  /** Map agent output to workflow data */
  map?: (output: string, ctx: StepContext<INPUT, DATA>) => unknown;
  retries?: number;
}

export interface LoopStepConfig<INPUT, DATA> {
  id: StepId;
  name?: string;
  /** Items to iterate over */
  items: (ctx: StepContext<INPUT, DATA>) => Promise<unknown[]> | unknown[];
  /** Execute for each item */
  execute: (ctx: StepContext<INPUT, DATA>, item: unknown, index: number) => Promise<unknown>;
  /** Max iterations safety limit */
  maxIterations?: number;
}

export interface ParallelStepConfig<INPUT, DATA> {
  id: StepId;
  name?: string;
  steps: Array<FunctionStepConfig<INPUT, DATA, unknown>>;
  /** Whether to continue if one branch fails */
  continueOnFailure?: boolean;
}

export type WorkflowStepType =
  | { kind: "function"; config: FunctionStepConfig<any, any, any> }
  | { kind: "conditional"; config: ConditionalStepConfig<any, any, any> }
  | { kind: "agent"; config: AgentStepConfig<any, any> }
  | { kind: "loop"; config: LoopStepConfig<any, any> }
  | { kind: "parallel"; config: ParallelStepConfig<any, any> }
  | { kind: "finally"; config: FunctionStepConfig<any, any, any> };

// ─── Events ──────────────────────────────────────────────────────────────────

export interface WorkflowEvent {
  type:
    | "step:start"
    | "step:complete"
    | "step:error"
    | "step:skip"
    | "step:retry"
    | "step:compensate"
    | "workflow:complete"
    | "workflow:error"
    | "workflow:suspend";
  stepId?: string;
  data?: unknown;
  timestamp: string;
}

export type WorkflowEventListener = (event: WorkflowEvent) => void;

// ─── Workflow Config ─────────────────────────────────────────────────────────

export interface WorkflowConfig<INPUT, RESULT> {
  id: string;
  name?: string;
  purpose?: string;
  input?: { validate(input: unknown): INPUT };
  result?: { parse(data: unknown): RESULT };
  /** Max overall timeout in ms */
  timeout?: number;
}

export type WorkflowResult<RESULT> =
  | { status: "completed"; result: RESULT; events: WorkflowEvent[] }
  | {
      status: "suspended";
      stepId: string;
      reason?: string;
      suspendData?: unknown;
      events: WorkflowEvent[];
    }
  | { status: "error"; error: string; stepId?: string; events: WorkflowEvent[] };

// ─── Chain ───────────────────────────────────────────────────────────────────

export class WorkflowChain<INPUT, DATA = INPUT, RESULT = DATA> {
  private config: WorkflowConfig<INPUT, RESULT>;
  private steps: WorkflowStepType[] = [];
  private listeners: WorkflowEventListener[] = [];

  constructor(config: WorkflowConfig<INPUT, RESULT>) {
    this.config = config;
  }

  /** Subscribe to workflow events. */
  onEvent(fn: WorkflowEventListener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(event: WorkflowEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  /**
   * Add a function step.
   * The step receives the current data and returns transformed data.
   */
  andThen<OUTPUT>(
    config: FunctionStepConfig<INPUT, DATA, OUTPUT>,
  ): WorkflowChain<INPUT, OUTPUT, RESULT> {
    this.steps.push({ kind: "function", config });
    return this as unknown as WorkflowChain<INPUT, OUTPUT, RESULT>;
  }

  /**
   * Add a conditional step.
   * Executes different code paths based on a condition.
   */
  andWhen<OUTPUT>(
    config: ConditionalStepConfig<INPUT, DATA, OUTPUT>,
  ): WorkflowChain<INPUT, OUTPUT, RESULT> {
    this.steps.push({ kind: "conditional", config });
    return this as unknown as WorkflowChain<INPUT, OUTPUT, RESULT>;
  }

  /**
   * Add an agent step.
   * Delegates to an AI agent for text generation.
   */
  andAgent<OUTPUT = string>(
    config: AgentStepConfig<INPUT, DATA> & {
      map?: (output: string, ctx: StepContext<INPUT, DATA>) => OUTPUT;
    },
  ): WorkflowChain<INPUT, OUTPUT, RESULT> {
    this.steps.push({ kind: "agent", config });
    return this as unknown as WorkflowChain<INPUT, OUTPUT, RESULT>;
  }

  /**
   * Add a loop step.
   * Iterates over items and executes a function for each.
   */
  andLoop<OUTPUT>(
    config: LoopStepConfig<INPUT, DATA> & {
      reduce?: (results: unknown[], item: unknown) => OUTPUT;
    },
  ): WorkflowChain<INPUT, OUTPUT, RESULT> {
    this.steps.push({ kind: "loop", config });
    return this as unknown as WorkflowChain<INPUT, OUTPUT, RESULT>;
  }

  /**
   * Add parallel steps.
   * Executes multiple steps concurrently.
   */
  andParallel(config: ParallelStepConfig<INPUT, DATA>): WorkflowChain<INPUT, DATA, RESULT> {
    this.steps.push({ kind: "parallel", config });
    return this as unknown as WorkflowChain<INPUT, DATA, RESULT>;
  }

  /**
   * Add a finally step (always executes, even on error).
   */
  andFinally<OUTPUT>(
    config: FunctionStepConfig<INPUT, DATA, OUTPUT>,
  ): WorkflowChain<INPUT, OUTPUT, RESULT> {
    this.steps.push({ kind: "finally", config });
    return this as unknown as WorkflowChain<INPUT, OUTPUT, RESULT>;
  }

  /**
   * Run the workflow with the given input.
   */
  async run(
    input: INPUT,
    options?: {
      signal?: AbortSignal;
      resumeStepId?: string;
      resumeData?: unknown;
    },
  ): Promise<WorkflowResult<RESULT>> {
    const state: WorkflowStepState<INPUT> = {
      input,
      outputs: {},
      skipped: new Set(),
      suspended: new Set(),
    };

    const events: WorkflowEvent[] = [];
    const emit = (event: WorkflowEvent) => {
      events.push(event);
      this.emit(event);
    };

    // Completed steps with a compensate action; run in reverse on failure.
    const saga: Array<{ stepId: string; run: () => Promise<void> }> = [];
    const registerCompensation = (
      step: WorkflowStepType,
      ctx: StepContext<INPUT, unknown>,
      output: unknown,
    ) => {
      const cfg = step.config as {
        compensate?: (c: StepContext<INPUT, unknown>, o: unknown) => void | Promise<void>;
      };
      if (typeof cfg.compensate === "function") {
        saga.push({ stepId: step.config.id, run: async () => cfg.compensate!(ctx, output) });
      }
    };

    try {
      let data: unknown = input;

      for (const step of this.steps) {
        if (options?.signal?.aborted) {
          throw new Error("Workflow aborted");
        }

        const stepId = step.config.id;
        state.currentStep = stepId;

        // If resuming, skip steps until we hit the resume target
        if (options?.resumeStepId && stepId !== options.resumeStepId) {
          if (state.outputs[stepId] !== undefined) {
            data = state.outputs[stepId];
            continue;
          }
          // Skip this step
          state.skipped.add(stepId);
          emit({
            type: "step:skip",
            stepId,
            timestamp: new Date().toISOString(),
          });
          continue;
        }

        const ctx: StepContext<INPUT, unknown> = {
          data,
          input,
          state,
          getStepOutput: <T = unknown>(id: string) => state.outputs[id] as T,
          suspend: async (reason, suspendData) => {
            state.suspended.add(stepId);
            emit({
              type: "workflow:suspend",
              stepId,
              data: { reason, suspendData },
              timestamp: new Date().toISOString(),
            });
            throw new SuspendError(stepId, reason, suspendData);
          },
          resumeData: stepId === options?.resumeStepId ? options?.resumeData : undefined,
          retryCount: 0,
          signal: options?.signal,
          emit,
        };

        emit({
          type: "step:start",
          stepId,
          timestamp: new Date().toISOString(),
        });

        try {
          const result = await executeStep(step, ctx, data);
          data = result;
          state.outputs[stepId] = result;
          registerCompensation(step, ctx, result);

          emit({
            type: "step:complete",
            stepId,
            data: result,
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          if (err instanceof SuspendError) {
            return {
              status: "suspended",
              stepId: err.stepId,
              reason: err.reason,
              suspendData: err.suspendData,
              events,
            };
          }

          // Retry logic
          const maxRetries = getRetries(step);
          if (maxRetries > 0) {
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
              emit({
                type: "step:retry",
                stepId,
                data: { attempt, maxRetries },
                timestamp: new Date().toISOString(),
              });

              try {
                ctx.retryCount = attempt;
                const retryResult = await executeStep(step, ctx, data);
                data = retryResult;
                state.outputs[stepId] = retryResult;
                registerCompensation(step, ctx, retryResult);

                emit({
                  type: "step:complete",
                  stepId,
                  data: retryResult,
                  timestamp: new Date().toISOString(),
                });
                break;
              } catch {
                if (attempt === maxRetries) {
                  throw err;
                }
              }
            }
          } else {
            emit({
              type: "step:error",
              stepId,
              data: { error: err instanceof Error ? err.message : String(err) },
              timestamp: new Date().toISOString(),
            });
            throw err;
          }
        }
      }

      const result = data as RESULT;
      emit({
        type: "workflow:complete",
        data: result,
        timestamp: new Date().toISOString(),
      });

      return { status: "completed", result, events };
    } catch (err) {
      if (err instanceof SuspendError) {
        // Already handled above
        throw err;
      }

      // Saga compensation: undo completed steps in reverse order. A failing
      // compensation is recorded as an event but never masks the original error.
      for (const c of [...saga].reverse()) {
        try {
          await c.run();
          emit({
            type: "step:compensate",
            stepId: c.stepId,
            timestamp: new Date().toISOString(),
          });
        } catch (cerr) {
          emit({
            type: "step:compensate",
            stepId: c.stepId,
            data: { error: cerr instanceof Error ? cerr.message : String(cerr) },
            timestamp: new Date().toISOString(),
          });
        }
      }

      const error = err instanceof Error ? err.message : String(err);
      emit({
        type: "workflow:error",
        data: { error },
        timestamp: new Date().toISOString(),
      });

      return {
        status: "error",
        error,
        stepId: state.currentStep,
        events,
      };
    }
  }
}

// ─── Step Executor ───────────────────────────────────────────────────────────

async function executeStep<INPUT>(
  step: WorkflowStepType,
  ctx: StepContext<INPUT, unknown>,
  data: unknown,
): Promise<unknown> {
  switch (step.kind) {
    case "function":
      return step.config.execute(ctx);

    case "conditional": {
      const cond = await step.config.condition(ctx);
      if (cond) {
        return step.config.execute(ctx);
      } else if (step.config.otherwise) {
        return step.config.otherwise(ctx);
      }
      return data;
    }

    case "agent": {
      const prompt =
        typeof step.config.task === "function" ? step.config.task(ctx) : step.config.task;
      const output = await step.config.agent.generate(prompt);
      if (step.config.map) {
        return step.config.map(output, ctx);
      }
      return output;
    }

    case "loop": {
      const items =
        typeof step.config.items === "function" ? await step.config.items(ctx) : step.config.items;
      const maxIter = step.config.maxIterations ?? 1000;
      const results: unknown[] = [];

      for (let i = 0; i < Math.min(items.length, maxIter); i++) {
        const result = await step.config.execute(ctx, items[i], i);
        results.push(result);
      }

      return results;
    }

    case "parallel": {
      const promises = step.config.steps.map((s) => {
        const subCtx = { ...ctx };
        return executeStep({ kind: "function", config: s }, subCtx, data).catch((err) => {
          if (step.config.continueOnFailure) return null;
          throw err;
        });
      });
      return Promise.all(promises);
    }

    case "finally":
      return step.config.execute(ctx);

    default:
      return data;
  }
}

function getRetries(step: WorkflowStepType): number {
  return (step.config as any).retries ?? 0;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class SuspendError extends Error {
  constructor(
    public readonly stepId: string,
    public readonly reason?: string,
    public readonly suspendData?: unknown,
  ) {
    super(`Workflow suspended at step "${stepId}": ${reason ?? "no reason"}`);
    this.name = "SuspendError";
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createWorkflowChain<INPUT, RESULT = INPUT>(
  config: WorkflowConfig<INPUT, RESULT>,
): WorkflowChain<INPUT, INPUT, RESULT> {
  return new WorkflowChain(config);
}

// Types are already exported inline above.

export { ActivityNotFoundError, DurableRuntime } from "./durable.js";
export type { ActivityDefinition, ActivityRetryPolicy, WorkflowContext } from "./durable.js";
