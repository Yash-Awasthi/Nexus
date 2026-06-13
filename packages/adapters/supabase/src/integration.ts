// SPDX-License-Identifier: Apache-2.0

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!_client) {
    const url = process.env["SUPABASE_URL"];
    const key = process.env["SUPABASE_SECRET_KEY"];
    if (!url || !key) throw new Error("SUPABASE_URL or SUPABASE_SECRET_KEY not set");
    _client = createClient(url, key);
  }
  return _client;
}

export async function select<T = Record<string, unknown>>(
  table: string,
  query: { filter?: Record<string, unknown>; limit?: number; columns?: string } = {},
): Promise<T[]> {
  let req = supabase()
    .from(table)
    .select(query.columns ?? "*");
  if (query.filter) {
    for (const [k, v] of Object.entries(query.filter)) {
      req = req.eq(k, v);
    }
  }
  if (query.limit) req = req.limit(query.limit);
  const { data, error } = await req;
  if (error) throw new Error(`Supabase select error: ${error.message}`);
  return (data ?? []) as T[];
}

export async function insert<T = Record<string, unknown>>(
  table: string,
  row: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase().from(table).insert(row).select().single();
  if (error) throw new Error(`Supabase insert error: ${error.message}`);
  return data as T;
}

export async function upsert<T = Record<string, unknown>>(
  table: string,
  row: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase().from(table).upsert(row).select().single();
  if (error) throw new Error(`Supabase upsert error: ${error.message}`);
  return data as T;
}

export async function update(
  table: string,
  filter: Record<string, unknown>,
  updates: Record<string, unknown>,
): Promise<number> {
  let req = supabase().from(table).update(updates);
  for (const [k, v] of Object.entries(filter)) req = req.eq(k, v);
  const { count, error } = await req;
  if (error) throw new Error(`Supabase update error: ${error.message}`);
  return count ?? 0;
}

export async function remove(table: string, filter: Record<string, unknown>): Promise<void> {
  let req = supabase().from(table).delete();
  for (const [k, v] of Object.entries(filter)) req = req.eq(k, v);
  const { error } = await req;
  if (error) throw new Error(`Supabase delete error: ${error.message}`);
}
