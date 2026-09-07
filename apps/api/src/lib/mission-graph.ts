// SPDX-License-Identifier: Apache-2.0
/**
 * Mission execution recorder — zero-write-cost spider-graph memory for agent
 * runs (mission pillar 3: "store the agent's useful execution state as
 * structured memory/graphs — captured automatically from the runtime").
 *
 * Every phase transition and every tool call of a mission is appended to the
 * per-user session graph via appendGraphEvent — the SAME fire-and-forget KV
 * write the research/threads pipelines use. No LLM call, no summarization,
 * no model cooperation: the pipeline's execution IS the memory.
 *
 * The tool wrapper is the interesting piece: the acting agent's toolset is
 * wrapped once at mission start, so each tool invocation (name, args summary,
 * outcome) becomes a graph node linked to the previous node — a literal
 * trace of the agent's thinking pipeline.
 */

import type { RuntimeTool } from "@nexus/agent-runtime";

import {
  appendGraphEvent,
  type ExecutionStatus,
  type GraphEvent,
  type GraphNode,
} from "./session-graph.js";

/** Injection seam for tests; defaults to the real KV-backed appender. */
export type GraphSink = (event: GraphEvent) => void | Promise<void>;

const MAX_DETAIL_CHARS = 300;

/** Compact one-line summary of tool args (bounded, JSON, no stack traces). */
export function summarizeArgs(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args);
    return s.length > MAX_DETAIL_CHARS ? `${s.slice(0, MAX_DETAIL_CHARS)}…` : s;
  } catch {
    return "[unserializable args]";
  }
}

/** Compact one-line summary of a tool result (bounded). */
export function summarizeResult(output: unknown): string {
  if (output === undefined || output === null) return String(output);
  try {
    const s = typeof output === "string" ? output : JSON.stringify(output);
    return s.length > MAX_DETAIL_CHARS ? `${s.slice(0, MAX_DETAIL_CHARS)}…` : s;
  } catch {
    return "[unserializable result]";
  }
}

export class MissionGraphRecorder {
  private readonly uid: string | undefined;
  private readonly missionId: string;
  private readonly sink: GraphSink;
  private toolCalls = 0;
  private skillExecutions = 0;

  constructor(
    uid: string | undefined,
    missionId: string,
    sink: GraphSink = (e) => appendGraphEvent(uid, missionId, "mission", e),
  ) {
    this.uid = uid;
    this.missionId = missionId;
    this.sink = sink;
  }

  /** Fire-and-forget (never throws to the mission loop). */
  private record(event: GraphEvent): void {
    try {
      void this.sink(event);
    } catch {
      /* capture is best-effort by design */
    }
  }

  /** Record one mission phase transition (wired to MissionRunner onProgress). */
  recordPhase(phase: string, iteration: number, note?: string): void {
    const nodeId = `${this.missionId}:phase:${iteration}:${phase}`;
    this.record({
      title: this.missionId,
      node: {
        id: nodeId,
        kind: "phase",
        label: phase,
        detail: note ? note.slice(0, MAX_DETAIL_CHARS) : undefined,
      },
      edge: { from: "last", to: nodeId, kind: "phase" },
    });
  }

  /**
   * One structured execution event for a skill code run — emitted BY THE
   * RUNTIME (harness pre-execution or the run_skill_code tool), never by the
   * model. Skill id + name land on the node, `status` carries the lifecycle
   * (started → completed | failed), and `detail` is a short outcome. Callers
   * chain the terminal event to its started node via `from`; returns the node
   * id that was recorded so the caller can link the next event deterministically.
   */
  recordSkillExecution(opts: {
    skillId: string;
    skillName: string;
    status: ExecutionStatus;
    detail?: string;
    /** Link a terminal event to its started node (defaults to the newest node). */
    from?: string;
  }): string {
    const n = ++this.skillExecutions;
    const attempt = `${this.missionId}:skill:${n}`;
    const started = opts.status === "started";
    const id = started ? `${attempt}:start` : attempt;
    const detail = [`[${opts.skillId}]`, opts.detail].filter(Boolean).join(" ");
    this.record({
      title: this.missionId,
      node: {
        id,
        kind: "skill",
        label: started ? opts.skillName : `${opts.skillName} result`,
        detail: detail ? detail.slice(0, MAX_DETAIL_CHARS) : undefined,
        status: opts.status,
      },
      edge: { from: opts.from ?? "last", to: id, kind: started ? "skill" : "skill_result" },
    });
    return id;
  }

  /**
   * Wrap a runtime tool so every invocation becomes a graph node:
   *   tool name + args → (edge from previous node) → outcome summary.
   * The wrapped handler behaves identically; capture is purely additive.
   */
  wrapTool(tool: RuntimeTool): RuntimeTool {
    const recorder = this;
    const handler = tool.handler;
    return {
      ...tool,
      handler: async (args, ctx) => {
        recorder.toolCalls += 1;
        const callNode = `${recorder.missionId}:tool:${recorder.toolCalls}`;
        recorder.record({
          node: {
            id: callNode,
            kind: "tool",
            label: tool.name,
            detail: summarizeArgs(args),
          },
          edge: { from: "last", to: callNode, kind: "tool_call" },
        });
        const started = Date.now();
        let outcome: unknown;
        let error: string | undefined;
        try {
          outcome = await handler(args, ctx);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          throw err; // the harness loop still sees the failure
        } finally {
          const detail =
            error !== undefined
              ? `error: ${error.slice(0, MAX_DETAIL_CHARS)}`
              : `ok (${Date.now() - started}ms): ${summarizeResult(outcome)}`;
          recorder.record({
            node: {
              id: `${callNode}:out`,
              kind: error !== undefined ? "error" : "report",
              label: `${tool.name} result`,
              detail: detail.slice(0, MAX_DETAIL_CHARS),
            },
            edge: {
              from: callNode,
              to: `${callNode}:out`,
              kind: "tool_result",
            },
          });
        }
        return outcome;
      },
    };
  }
}