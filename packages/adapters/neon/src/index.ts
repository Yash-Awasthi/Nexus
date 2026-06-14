// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-neon — Neon Postgres via the Neon serverless HTTP API.
 * Task types: neon.query, neon.execute
 *
 * Uses the Neon HTTP API endpoint (no pg driver needed in edge environments).
 * For full-featured pg usage, DATABASE_URL is available for direct connection.
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

export interface NeonQueryTask {
  taskType: "neon.query";
  sql: string;
  params?: unknown[];
}
export interface NeonExecuteTask {
  taskType: "neon.execute";
  sql: string;
  params?: unknown[];
}
export type NeonTask = NeonQueryTask | NeonExecuteTask;

export interface NeonQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  fields: { name: string; dataTypeID: number }[];
}
export interface NeonExecuteResult {
  rowCount: number;
  command: string;
}

async function execute(
  task: NeonTask,
  ctx: IExecutionContext,
): Promise<NeonQueryResult | NeonExecuteResult> {
  const connectionUrl = requireEnv(ctx, "DATABASE_URL");

  // Neon HTTP API: POST to the connection URL with /sql suffix
  // Format: https://<endpoint>.neon.tech/sql
  const httpUrl = connectionUrl
    .replace(/^postgres(ql)?:\/\//, "https://")
    .replace(/\/[^/]+$/, "/sql");

  ctx.logger.info(task.taskType, { sql: task.sql.slice(0, 100) });

  const response = await fetch(httpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Neon-Connection-String": connectionUrl },
    body: JSON.stringify({ query: task.sql, params: task.params ?? [] }),
  });

  if (!response.ok)
    throw new AdapterHttpError("nexus-adapter-neon", response.status, await response.text());

  const data = (await response.json()) as {
    rows?: Record<string, unknown>[];
    rowCount?: number;
    command?: string;
    fields?: { name: string; dataTypeID: number }[];
  };

  if (task.taskType === "neon.query") {
    return { rows: data.rows ?? [], rowCount: data.rowCount ?? 0, fields: data.fields ?? [] };
  }
  return { rowCount: data.rowCount ?? 0, command: data.command ?? "UNKNOWN" };
}

export const neonAdapter = defineAdapter<NeonTask, NeonQueryResult | NeonExecuteResult>({
  name: "nexus-adapter-neon",
  version: "0.1.0",
  capabilities: ["database.query", "database.execute"],
  taskTypes: ["neon.query", "neon.execute"],
  execute,
});
export default neonAdapter;
