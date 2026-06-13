// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-council — Council deliberation + multi-agent code loop.
 *
 * Task types
 * ----------
 *   council.deliberate   Delegates to @nexus/council REST endpoint
 *   council.evaluate     Alias for deliberate (strict evaluation framing)
 *   council.code_loop    Multi-agent code generation loop (model-per-role)
 *
 * The code loop runs five specialist LLM agents against the Groq API in a
 * plan → implement → review → (debug → review)* → synthesize pipeline.
 * Each role is configurable independently — swap models, prompts, temperature.
 */

import type { CouncilRequest, CouncilResponse } from "@nexus/contracts";
import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  NexusAdapterError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

import { runCodeLoop } from "./code-loop.js";
import type { CodeLoopTask, CodeLoopResult } from "./code-loop.js";

export type { CodeLoopTask, CodeLoopResult };
export { DEFAULT_ROLES } from "./code-loop.js";
export type { CodeLoopRole, CodeLoopIteration } from "./code-loop.js";

// ── council.deliberate / council.evaluate ──────────────────────────────────────

export interface CouncilDeliberateTask {
  taskType: "council.deliberate" | "council.evaluate";
  proposal: CouncilRequest["proposal"];
  budgetUsd?: number;
  timeoutMs?: number;
}

// ── Union task type ────────────────────────────────────────────────────────────

type AnyCouncilTask = CouncilDeliberateTask | CodeLoopTask;

// ── Execute ────────────────────────────────────────────────────────────────────

async function execute(
  task: AnyCouncilTask,
  ctx: IExecutionContext,
): Promise<CouncilResponse | CodeLoopResult> {
  // ── council.code_loop ───────────────────────────────────────────────────────

  if (task.taskType === "council.code_loop") {
    const apiKey = ctx.environment["GROQ_API_KEY"] ?? process.env.GROQ_API_KEY ?? "";
    if (!apiKey) {
      throw new NexusAdapterError(
        "council.code_loop requires GROQ_API_KEY",
        "ADAPTER_CONFIG_ERROR",
        { adapterName: "nexus-adapter-council" },
      );
    }
    ctx.logger.info("council.code_loop starting", {
      specLength: task.spec.length,
      maxIterations: task.maxIterations ?? 3,
    });

    const result = await runCodeLoop(task, apiKey);

    ctx.logger.info("council.code_loop complete", {
      accepted: result.accepted,
      totalIterations: result.totalIterations,
      totalLatencyMs: result.totalLatencyMs,
      tokens: result.tokenUsage,
    });

    return result;
  }

  // ── council.deliberate / council.evaluate ───────────────────────────────────

  const councilUrl = requireEnv(ctx, "NEXUS_COUNCIL_URL");
  ctx.logger.info("council.deliberate", { title: task.proposal.title });

  const body: CouncilRequest = {
    proposal: task.proposal,
    budgetUsd: task.budgetUsd,
    timeoutMs: task.timeoutMs ?? 60_000,
  };

  const response = await fetch(`${councilUrl}/deliberate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new AdapterHttpError("nexus-adapter-council", response.status, text);
  }

  return response.json() as Promise<CouncilResponse>;
}

// ── Adapter export ─────────────────────────────────────────────────────────────

export const councilAdapter = defineAdapter<AnyCouncilTask, CouncilResponse | CodeLoopResult>({
  name: "nexus-adapter-council",
  version: "0.2.0",
  capabilities: ["deliberation.council"],
  taskTypes: ["council.deliberate", "council.evaluate", "council.code_loop"],
  execute,
});
export default councilAdapter;
