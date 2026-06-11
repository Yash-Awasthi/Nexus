// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-council — Delegates to @nexus/council deliberation service.
 * Task types: council.deliberate, council.evaluate
 *
 * This adapter acts as the execution bridge between the task queue and the
 * @nexus/council package (M5). It calls the council REST endpoint exposed by
 * apps/api or calls the council package directly when co-located.
 */

import { defineAdapter, requireEnv, AdapterHttpError, type IExecutionContext } from "@nexus/plugin-sdk";
import type { CouncilRequest, CouncilResponse } from "@nexus/contracts";

export interface CouncilDeliberateTask {
  taskType: "council.deliberate" | "council.evaluate";
  proposal: CouncilRequest["proposal"];
  budgetUsd?: number;
  timeoutMs?: number;
}

async function execute(task: CouncilDeliberateTask, ctx: IExecutionContext): Promise<CouncilResponse> {
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

export const councilAdapter = defineAdapter<CouncilDeliberateTask, CouncilResponse>({
  name: "nexus-adapter-council", version: "0.1.0", capabilities: ["deliberation.council"],
  taskTypes: ["council.deliberate", "council.evaluate"],
  execute,
});
export default councilAdapter;
