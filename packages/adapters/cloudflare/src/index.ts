// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-cloudflare — Cloudflare API (Pages, R2, cache purge).
 * Task types: cloudflare.deploy-pages, cloudflare.r2-put, cloudflare.r2-get, cloudflare.purge-cache
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

const CF_BASE = "https://api.cloudflare.com/client/v4";

export interface CloudflareDeployPagesTask {
  taskType: "cloudflare.deploy-pages";
  projectName: string;
  branch?: string;
}
export interface CloudflareR2PutTask {
  taskType: "cloudflare.r2-put";
  bucketName: string;
  key: string;
  body: string;
  contentType?: string;
}
export interface CloudflareR2GetTask {
  taskType: "cloudflare.r2-get";
  bucketName: string;
  key: string;
}
export interface CloudflarePurgeCacheTask {
  taskType: "cloudflare.purge-cache";
  zoneId: string;
  urls?: string[];
  purgeEverything?: boolean;
}
export type CloudflareTask =
  | CloudflareDeployPagesTask
  | CloudflareR2PutTask
  | CloudflareR2GetTask
  | CloudflarePurgeCacheTask;
export interface CloudflareResult {
  ok: boolean;
  result?: unknown;
}

async function cfFetch(url: string, token: string, options: RequestInit = {}): Promise<Response> {
  const extra = options.headers as Record<string, string> | undefined;
  const merged = Object.assign(
    { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    extra,
  );
  return fetch(url, { ...options, headers: merged });
}

async function execute(task: CloudflareTask, ctx: IExecutionContext): Promise<CloudflareResult> {
  const token = requireEnv(ctx, "CLOUDFLARE_API_TOKEN");
  const accountId = ctx.environment["CLOUDFLARE_ACCOUNT_ID"] ?? "";

  if (task.taskType === "cloudflare.deploy-pages") {
    ctx.logger.info("cloudflare.deploy-pages", { project: task.projectName });
    const response = await cfFetch(
      `${CF_BASE}/accounts/${accountId}/pages/projects/${task.projectName}/deployments`,
      token,
      {
        method: "POST",
        body: JSON.stringify({ branch: task.branch ?? "main" }),
      },
    );
    if (!response.ok)
      throw new AdapterHttpError(
        "nexus-adapter-cloudflare",
        response.status,
        await response.text(),
      );
    return { ok: true, result: await response.json() };
  }

  if (task.taskType === "cloudflare.r2-put") {
    ctx.logger.info("cloudflare.r2-put", { bucket: task.bucketName, key: task.key });
    const response = await cfFetch(
      `${CF_BASE}/accounts/${accountId}/r2/buckets/${task.bucketName}/objects/${encodeURIComponent(task.key)}`,
      token,
      {
        method: "PUT",
        headers: { "Content-Type": task.contentType ?? "application/octet-stream" },
        body: task.body,
      },
    );
    if (!response.ok)
      throw new AdapterHttpError(
        "nexus-adapter-cloudflare",
        response.status,
        await response.text(),
      );
    return { ok: true };
  }

  if (task.taskType === "cloudflare.r2-get") {
    ctx.logger.info("cloudflare.r2-get", { bucket: task.bucketName, key: task.key });
    const response = await cfFetch(
      `${CF_BASE}/accounts/${accountId}/r2/buckets/${task.bucketName}/objects/${encodeURIComponent(task.key)}`,
      token,
    );
    if (!response.ok)
      throw new AdapterHttpError(
        "nexus-adapter-cloudflare",
        response.status,
        await response.text(),
      );
    return { ok: true, result: await response.text() };
  }

  // cloudflare.purge-cache
  ctx.logger.info("cloudflare.purge-cache", { zoneId: task.zoneId });
  const body = task.purgeEverything ? { purge_everything: true } : { files: task.urls ?? [] };
  const response = await cfFetch(`${CF_BASE}/zones/${task.zoneId}/purge_cache`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new AdapterHttpError("nexus-adapter-cloudflare", response.status, await response.text());
  return { ok: true };
}

export const cloudflareAdapter = defineAdapter<CloudflareTask, CloudflareResult>({
  name: "nexus-adapter-cloudflare",
  version: "0.1.0",
  capabilities: ["deploy.trigger", "storage.read", "storage.write"],
  taskTypes: [
    "cloudflare.deploy-pages",
    "cloudflare.r2-put",
    "cloudflare.r2-get",
    "cloudflare.purge-cache",
  ],
  execute,
});
export default cloudflareAdapter;
