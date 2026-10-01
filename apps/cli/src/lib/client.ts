// SPDX-License-Identifier: Apache-2.0
/**
 * Nexus API client for the CLI.
 * Reads NEXUS_API_URL and NEXUS_API_KEY from env.
 */

import chalk from "chalk";

const BASE_URL = (process.env.NEXUS_API_URL ?? "http://localhost:3000").replace(/\/$/, "");
const API_KEY = process.env.NEXUS_API_KEY ?? "";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    // Errors arrive as { error: "…" }, { message } or the gateway's { error: { message } }.
    const body = data as { error?: string | { message?: string }; message?: string };
    const msg =
      (typeof body.error === "object" ? body.error.message : body.error) ?? body.message ?? text;
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }

  return data;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", `/api/v1${path}`),
  post: <T>(path: string, body: unknown) => request<T>("POST", `/api/v1${path}`, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", `/api/v1${path}`, body),
  health: () => request<{ status: string }>("GET", "/health"),
  /** Routes outside the versioned surface, such as `/api/research`. */
  unversioned: <T>(method: string, path: string, body?: unknown) => request<T>(method, path, body),
  url: (path: string) => `${BASE_URL}${path}`,
  /** Absolute URL for a versioned path — used for SSE streaming (raw fetch). */
  sseUrl: (path: string) => `${BASE_URL}/api/v1${path}`,
  /** Auth headers to attach to a raw fetch (e.g. SSE), if a key is configured. */
  authHeaders: (): Record<string, string> =>
    API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
};

/** Report a failed command. Not `process.exit`: on Windows it crashes while a socket is closing. */
export function fail(err: unknown): void {
  console.error(chalk.red("✗"), err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
