// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-supabase — Supabase REST API (PostgREST).
 * Task types: supabase.query, supabase.insert, supabase.update, supabase.delete
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

export interface SupabaseQueryTask {
  taskType: "supabase.query";
  table: string;
  select?: string;
  filter?: Record<string, unknown>;
  limit?: number;
  order?: string;
}
export interface SupabaseInsertTask {
  taskType: "supabase.insert";
  table: string;
  rows: Record<string, unknown> | Record<string, unknown>[];
  upsert?: boolean;
}
export interface SupabaseUpdateTask {
  taskType: "supabase.update";
  table: string;
  filter: Record<string, unknown>;
  data: Record<string, unknown>;
}
export interface SupabaseDeleteTask {
  taskType: "supabase.delete";
  table: string;
  filter: Record<string, unknown>;
}
export type SupabaseTask =
  | SupabaseQueryTask
  | SupabaseInsertTask
  | SupabaseUpdateTask
  | SupabaseDeleteTask;
export interface SupabaseResult {
  rows: Record<string, unknown>[];
  count: number;
}

function buildFilterParams(filter: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    params.set(key, `eq.${String(value)}`);
  }
  return params;
}

async function execute(
  task: SupabaseTask,
  ctx: IExecutionContext,
): Promise<SupabaseResult | { ok: boolean }> {
  const supabaseUrl = requireEnv(ctx, "SUPABASE_URL");
  const anonKey = requireEnv(ctx, "SUPABASE_ANON_KEY");
  const headers: Record<string, string> = {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };

  if (task.taskType === "supabase.query") {
    ctx.logger.info("supabase.query", { table: task.table });
    const url = new URL(`${supabaseUrl}/rest/v1/${task.table}`);
    url.searchParams.set("select", task.select ?? "*");
    if (task.filter)
      for (const [k, v] of Object.entries(task.filter)) url.searchParams.set(k, `eq.${String(v)}`);
    if (task.limit) url.searchParams.set("limit", String(task.limit));
    if (task.order) url.searchParams.set("order", task.order);
    const response = await fetch(url.toString(), {
      headers: { ...headers, Prefer: "count=exact" },
    });
    if (!response.ok)
      throw new AdapterHttpError("nexus-adapter-supabase", response.status, await response.text());
    const rows = (await response.json()) as Record<string, unknown>[];
    return { rows, count: rows.length };
  }

  if (task.taskType === "supabase.insert") {
    ctx.logger.info("supabase.insert", { table: task.table, upsert: task.upsert });
    const prefer = task.upsert
      ? "resolution=merge-duplicates,return=representation"
      : "return=representation";
    const response = await fetch(`${supabaseUrl}/rest/v1/${task.table}`, {
      method: "POST",
      headers: { ...headers, Prefer: prefer },
      body: JSON.stringify(task.rows),
    });
    if (!response.ok)
      throw new AdapterHttpError("nexus-adapter-supabase", response.status, await response.text());
    const rows = (await response.json()) as Record<string, unknown>[];
    return { rows, count: rows.length };
  }

  if (task.taskType === "supabase.update") {
    ctx.logger.info("supabase.update", { table: task.table });
    const url = new URL(`${supabaseUrl}/rest/v1/${task.table}`);
    for (const [k, v] of Object.entries(task.filter)) url.searchParams.set(k, `eq.${String(v)}`);
    const response = await fetch(url.toString(), {
      method: "PATCH",
      headers,
      body: JSON.stringify(task.data),
    });
    if (!response.ok)
      throw new AdapterHttpError("nexus-adapter-supabase", response.status, await response.text());
    const rows = (await response.json()) as Record<string, unknown>[];
    return { rows, count: rows.length };
  }

  // supabase.delete
  ctx.logger.info("supabase.delete", { table: task.table });
  const url = new URL(`${supabaseUrl}/rest/v1/${task.table}`);
  buildFilterParams(task.filter).forEach((v, k) => url.searchParams.set(k, v));
  const response = await fetch(url.toString(), { method: "DELETE", headers });
  if (!response.ok)
    throw new AdapterHttpError("nexus-adapter-supabase", response.status, await response.text());
  return { ok: true };
}

export const supabaseAdapter = defineAdapter<SupabaseTask, SupabaseResult | { ok: boolean }>({
  name: "nexus-adapter-supabase",
  version: "0.1.0",
  capabilities: ["database.query", "database.execute"],
  taskTypes: ["supabase.query", "supabase.insert", "supabase.update", "supabase.delete"],
  execute,
});
export default supabaseAdapter;
