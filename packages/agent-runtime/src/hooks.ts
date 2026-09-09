// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/agent-runtime — lifecycle hooks.
 *
 * The hook system (PreToolUse / PostToolUse / SubagentStop / Stop)
 * is the seam that turns a coding agent from a fixed loop into an operator-
 * controllable one: deterministic guards, redaction, audit logging, and
 * verdict overrides — all without touching the model or the tools.
 *
 * Events, in firing order during a ToolAgentRuntime.run():
 *
 *   preToolUse   before each tool executes. `continue: false` blocks the call;
 *                the model sees the decision's `feedback` as the tool error.
 *   postToolUse  after each tool result. `feedback` replaces the text that
 *                enters the history (redaction / annotation), not the result
 *                object itself.
 *   subagentStop when a spawn_agents child finishes; `continue: false`
 *                overrides the child's verdict with `feedback` in `error`.
 *   stop         once at the end of a run (not fired on abort);
 *                `feedback` replaces the returned `finalContent`.
 *
 * Decisions merge fail-closed: the first `continue: false` wins, feedback is
 * joined, and `suppressOutput` ORs — one guarding handler can never be
 * un-blocked by a later one. Unknown hook keys throw at construction, so
 * misspelled events fail loudly instead of silently never firing.
 */

import type { RuntimeUsage, ToolResult, ToolStepRecord, SpawnAgentResult } from "./index.js";

// ── Events & decisions ───────────────────────────────────────────────────────

export type AgentHookEvent = "preToolUse" | "postToolUse" | "subagentStop" | "stop";

export interface PreToolUseInput {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

export interface PostToolUseInput {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  result: ToolResult;
}

export interface SubagentStopInput {
  /** Child's index in the original tasks array. */
  taskIndex: number;
  instruction: string;
  finalContent: string;
  steps: number;
  /** Child-level error (child already failed on its own). */
  error?: string;
}

export interface StopInput {
  finalContent: string;
  totalUsage: RuntimeUsage;
  steps: ToolStepRecord[];
}

/** What a hook handler may decide. Everything is optional. */
export interface HookDecision {
  /** `false` blocks (preToolUse: the call; subagentStop: the verdict). */
  continue?: boolean;
  /** Machine-readable stop cause accompanying `continue: false`. */
  stopReason?: string;
  /** Human/model text — blocks carry it as the error, transforms replace content. */
  feedback?: string;
  /** Suppress this tool result's content in the history (postToolUse). */
  suppressOutput?: boolean;
}

export type AgentHookHandler<E extends AgentHookEvent> = (
  input: E extends "preToolUse"
    ? PreToolUseInput
    : E extends "postToolUse"
      ? PostToolUseInput
      : E extends "subagentStop"
        ? SubagentStopInput
        : StopInput,
) => HookDecision | void | Promise<HookDecision | void>;

/** Hook handlers per event, run in registration order per event. */
export interface AgentHooks {
  preToolUse?: AgentHookHandler<"preToolUse"> | AgentHookHandler<"preToolUse">[];
  postToolUse?: AgentHookHandler<"postToolUse"> | AgentHookHandler<"postToolUse">[];
  subagentStop?: AgentHookHandler<"subagentStop"> | AgentHookHandler<"subagentStop">[];
  stop?: AgentHookHandler<"stop"> | AgentHookHandler<"stop">[];
}

const AGENT_HOOK_EVENTS: readonly AgentHookEvent[] = [
  "preToolUse",
  "postToolUse",
  "subagentStop",
  "stop",
];

/** Hook decision for an event, or undefined when no handler decided. */
export type DispatchedHook = Promise<HookDecision | undefined>;

// ── Merging ──────────────────────────────────────────────────────────────────

/**
 * Merge two hook decisions, fail-closed: `continue: false` sticks, feedback
 * joins with a newline, `suppressOutput` ORs, stopReason keeps the blocker's.
 */
export function mergeHookDecisions(
  a: HookDecision | undefined,
  b: HookDecision | undefined,
): HookDecision | undefined {
  if (!a) return b;
  if (!b) return a;
  const merged: HookDecision = {};
  if (a.continue === false || b.continue === false) merged.continue = false;
  if (a.stopReason !== undefined || b.stopReason !== undefined) {
    merged.stopReason = a.continue === false ? a.stopReason : b.stopReason;
  }
  const feedback = [a.feedback, b.feedback].filter((f) => f !== undefined).join("\n");
  if (feedback) merged.feedback = feedback;
  if (a.suppressOutput || b.suppressOutput) merged.suppressOutput = true;
  return merged;
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

/** Normalise the handler field (single handler or array) to an array. */
function handlersFor(hooks: AgentHooks, event: AgentHookEvent): AgentHookHandler<AgentHookEvent>[] {
  const h = hooks[event];
  if (!h) return [];
  return (Array.isArray(h) ? h : [h]) as AgentHookHandler<AgentHookEvent>[];
}

/**
 * Runs an AgentHooks bundle. Construct once per runtime; `dispatch` resolves
 * each event's handlers in order and merges their decisions fail-closed.
 */
export class HookDispatcher {
  private readonly hooks: AgentHooks;

  constructor(hooks: AgentHooks) {
    // Misspelled event keys must fail loudly, not silently never fire.
    const unknown = Object.keys(hooks).filter(
      (k) => !AGENT_HOOK_EVENTS.includes(k as AgentHookEvent),
    );
    if (unknown.length > 0) {
      throw new Error(
        `hooks: unknown hook event(s) ${unknown.join(", ")} — expected one of ${AGENT_HOOK_EVENTS.join(", ")}`,
      );
    }
    this.hooks = hooks;
  }

  has(event: AgentHookEvent): boolean {
    return handlersFor(this.hooks, event).length > 0;
  }

  dispatch(event: AgentHookEvent, input: unknown): DispatchedHook {
    const handlers = handlersFor(this.hooks, event);
    if (handlers.length === 0) return Promise.resolve(undefined);
    let acc: Promise<HookDecision | undefined> = Promise.resolve(undefined);
    for (const h of handlers) {
      acc = acc.then(async (merged) => {
        // Await even void returns so handler exceptions surface as rejections
        // and the async boundary is uniform across handler shapes.
        const decision = (await h(input as never)) as HookDecision | void;
        return mergeHookDecisions(merged, decision ?? undefined);
      });
    }
    return acc as DispatchedHook;
  }
}
