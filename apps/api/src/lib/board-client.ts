// SPDX-License-Identifier: Apache-2.0
/**
 * Client for the local Go agent board (`services/board`).
 *
 * Zero dependencies: native fetch against BOARD_URL, defaulting to the board
 * started by `pnpm board:serve`. Every call is bounded and fail-open — an
 * offline board yields `{ ok: false, error }` (or an empty task list) instead
 * of throwing into a request handler.
 */

const DEFAULT_BOARD_URL = "http://127.0.0.1:4100";
const DEFAULT_BOARD_CHANNEL = "nexus";
const REQUEST_TIMEOUT_MS = 4_000;

/** A task as the board returns it. Extra fields are ignored. */
export interface BoardTask {
  id: string;
  channel?: string;
  thread: string;
  title: string;
  state: string;
  contract_interface?: string;
  required_caps?: string;
  depends_on?: string;
  owner?: string;
  lease_until?: string;
  created_at?: string;
  updated_at?: string;
}

export interface BoardHealth {
  ok: boolean;
  version?: string;
  error?: string;
}

function boardUrl(): string {
  return (process.env.BOARD_URL || DEFAULT_BOARD_URL).replace(/\/+$/, "");
}

function boardChannel(): string {
  return process.env.BOARD_CHANNEL || DEFAULT_BOARD_CHANNEL;
}

/** The URL and channel every call uses, for status reporting. */
export function boardConfig(): { url: string; channel: string } {
  return { url: boardUrl(), channel: boardChannel() };
}

interface HttpResult {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function errorText(body: unknown): string | undefined {
  const error = asRecord(body)?.["error"];
  return typeof error === "string" ? error : undefined;
}

function taskFrom(body: unknown): BoardTask | undefined {
  const task = asRecord(body)?.["task"];
  return asRecord(task) as BoardTask | undefined;
}

async function call(path: string, init: RequestInit = {}): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${boardUrl()}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        body,
        error: errorText(body) ?? `board responded ${response.status}`,
      };
    }
    return { ok: true, status: response.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** GET /api/health */
export async function checkHealth(): Promise<BoardHealth> {
  const result = await call("/api/health");
  if (!result.ok) return { ok: false, error: result.error };
  const body = asRecord(result.body);
  const version = body?.["version"];
  if (body?.["status"] !== "ok") {
    return { ok: false, error: "board health check did not report ok" };
  }
  return { ok: true, ...(typeof version === "string" ? { version } : {}) };
}

/** POST /api/tasks — create a task and return its generated id. */
export async function createTask(params: {
  thread: string;
  title: string;
  contract?: string;
  caps?: string;
  id?: string;
  depends?: string;
}): Promise<{ ok: boolean; id?: string; task?: BoardTask; error?: string }> {
  const result = await call("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      channel: boardChannel(),
      thread: params.thread,
      title: params.title,
      contract: params.contract,
      caps: params.caps,
      id: params.id,
      depends_on: params.depends,
    }),
  });
  if (!result.ok) return { ok: false, error: result.error };
  const task = taskFrom(result.body);
  if (!task?.id) return { ok: false, error: "board returned no task" };
  return { ok: true, id: task.id, task };
}

/** GET /api/tasks — list tasks, optionally filtered. Offline yields an empty list. */
export async function listTasks(thread?: string, state?: string): Promise<BoardTask[]> {
  const query = new URLSearchParams({ channel: boardChannel() });
  if (thread) query.set("thread", thread);
  if (state) query.set("state", state);
  const result = await call(`/api/tasks?${query.toString()}`);
  if (!result.ok) return [];
  const tasks = asRecord(result.body)?.["tasks"];
  return Array.isArray(tasks) ? (tasks as BoardTask[]) : [];
}
