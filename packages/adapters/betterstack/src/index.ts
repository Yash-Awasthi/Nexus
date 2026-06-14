// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-betterstack — BetterStack Logs + Uptime API.
 * Task types: betterstack.log, betterstack.create-alert, betterstack.check-uptime
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

const LOGS_URL = "https://in.logs.betterstack.com";
const UPTIME_BASE = "https://uptime.betterstack.com/api/v2";

export interface BetterstackLogTask {
  taskType: "betterstack.log";
  level?: "debug" | "info" | "warn" | "error" | "fatal";
  message: string;
  fields?: Record<string, unknown>;
}
export interface BetterstackCreateAlertTask {
  taskType: "betterstack.create-alert";
  monitorId: string;
  summary: string;
}
export interface BetterstackCheckUptimeTask {
  taskType: "betterstack.check-uptime";
  monitorId: string;
}
export type BetterstackTask =
  | BetterstackLogTask
  | BetterstackCreateAlertTask
  | BetterstackCheckUptimeTask;
export interface BetterstackLogResult {
  ok: boolean;
}
export interface BetterstackUptimeResult {
  id: string;
  url: string;
  status: "up" | "down" | "paused" | "pending";
  availability: number;
}

async function execute(
  task: BetterstackTask,
  ctx: IExecutionContext,
): Promise<BetterstackLogResult | BetterstackUptimeResult> {
  if (task.taskType === "betterstack.log") {
    const token = requireEnv(ctx, "BETTERSTACK_SOURCE_TOKEN");
    const payload = {
      dt: new Date().toISOString(),
      level: task.level ?? "info",
      message: task.message,
      ...task.fields,
    };
    const response = await fetch(LOGS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok)
      throw new AdapterHttpError(
        "nexus-adapter-betterstack",
        response.status,
        await response.text(),
      );
    return { ok: true };
  }

  const token = requireEnv(ctx, "BETTERSTACK_UPTIME_API_TOKEN");

  if (task.taskType === "betterstack.check-uptime") {
    ctx.logger.info("betterstack.check-uptime", { monitorId: task.monitorId });
    const response = await fetch(`${UPTIME_BASE}/monitors/${task.monitorId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok)
      throw new AdapterHttpError(
        "nexus-adapter-betterstack",
        response.status,
        await response.text(),
      );
    const data = (await response.json()) as {
      data: { id: string; attributes: { url: string; status: string; availability: number } };
    };
    return {
      id: data.data.id,
      url: data.data.attributes.url,
      status: data.data.attributes.status as BetterstackUptimeResult["status"],
      availability: data.data.attributes.availability,
    };
  }

  ctx.logger.info("betterstack.create-alert", { monitorId: task.monitorId });
  const response = await fetch(`${UPTIME_BASE}/monitors/${task.monitorId}/incidents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: { attributes: { summary: task.summary } } }),
  });
  if (!response.ok)
    throw new AdapterHttpError("nexus-adapter-betterstack", response.status, await response.text());
  return { ok: true };
}

export const betterstackAdapter = defineAdapter<
  BetterstackTask,
  BetterstackLogResult | BetterstackUptimeResult
>({
  name: "nexus-adapter-betterstack",
  version: "0.1.0",
  capabilities: ["monitoring.log", "monitoring.alert"],
  taskTypes: ["betterstack.log", "betterstack.create-alert", "betterstack.check-uptime"],
  execute,
});
export default betterstackAdapter;
