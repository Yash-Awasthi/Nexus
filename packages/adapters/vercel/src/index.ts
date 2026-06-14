// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-vercel — Vercel REST API.
 * Task types: vercel.deploy, vercel.list-deployments, vercel.alias
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

const VERCEL_BASE = "https://api.vercel.com";

export interface VercelDeployTask {
  taskType: "vercel.deploy";
  projectId: string;
  gitSource?: { ref: string; repoId?: string; type?: "github" | "gitlab" | "bitbucket" };
  env?: Record<string, string>;
}
export interface VercelListDeploymentsTask {
  taskType: "vercel.list-deployments";
  projectId?: string;
  limit?: number;
  state?: "BUILDING" | "ERROR" | "INITIALIZING" | "QUEUED" | "READY" | "CANCELED";
}
export interface VercelAliasTask {
  taskType: "vercel.alias";
  deploymentId: string;
  alias: string;
}
export type VercelTask = VercelDeployTask | VercelListDeploymentsTask | VercelAliasTask;
export interface VercelDeploymentResult {
  id: string;
  url: string;
  state: string;
  createdAt: number;
}
export interface VercelListResult {
  deployments: VercelDeploymentResult[];
}

async function execute(
  task: VercelTask,
  ctx: IExecutionContext,
): Promise<VercelDeploymentResult | VercelListResult | { ok: boolean; alias: string }> {
  const token = requireEnv(ctx, "VERCEL_API_TOKEN");
  const teamId = ctx.environment["VERCEL_TEAM_ID"];
  const teamParam = teamId ? `?teamId=${teamId}` : "";

  if (task.taskType === "vercel.deploy") {
    ctx.logger.info("vercel.deploy", { projectId: task.projectId });
    const response = await fetch(`${VERCEL_BASE}/v13/deployments${teamParam}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: task.projectId,
        gitSource: task.gitSource,
        env: Object.entries(task.env ?? {}).map(([key, value]) => ({ key, value, type: "plain" })),
      }),
    });
    if (!response.ok)
      throw new AdapterHttpError("nexus-adapter-vercel", response.status, await response.text());
    const data = (await response.json()) as VercelDeploymentResult;
    return data;
  }

  if (task.taskType === "vercel.list-deployments") {
    ctx.logger.info("vercel.list-deployments", { projectId: task.projectId });
    const url = new URL(`${VERCEL_BASE}/v6/deployments`);
    if (teamId) url.searchParams.set("teamId", teamId);
    if (task.projectId) url.searchParams.set("projectId", task.projectId);
    if (task.state) url.searchParams.set("state", task.state);
    url.searchParams.set("limit", String(task.limit ?? 20));
    const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok)
      throw new AdapterHttpError("nexus-adapter-vercel", response.status, await response.text());
    const data = (await response.json()) as { deployments: VercelDeploymentResult[] };
    return { deployments: data.deployments };
  }

  // vercel.alias
  ctx.logger.info("vercel.alias", { deploymentId: task.deploymentId, alias: task.alias });
  const response = await fetch(
    `${VERCEL_BASE}/v2/deployments/${task.deploymentId}/aliases${teamParam}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ alias: task.alias }),
    },
  );
  if (!response.ok)
    throw new AdapterHttpError("nexus-adapter-vercel", response.status, await response.text());
  return { ok: true, alias: task.alias };
}

export const vercelAdapter = defineAdapter<
  VercelTask,
  VercelDeploymentResult | VercelListResult | { ok: boolean; alias: string }
>({
  name: "nexus-adapter-vercel",
  version: "0.1.0",
  capabilities: ["deploy.trigger"],
  taskTypes: ["vercel.deploy", "vercel.list-deployments", "vercel.alias"],
  execute,
});
export default vercelAdapter;
