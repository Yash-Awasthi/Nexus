// SPDX-License-Identifier: Apache-2.0
/**
 * Nexus API client for the CLI.
 * Reads NEXUS_API_URL and NEXUS_API_KEY from env.
 */

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
    const msg = (data as { error?: string }).error ?? text;
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }

  return data;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", `/api/v1${path}`),
  post: <T>(path: string, body: unknown) => request<T>("POST", `/api/v1${path}`, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", `/api/v1${path}`, body),
  health: () => request<{ status: string }>("GET", "/health"),
  /** Absolute URL for a versioned path — used for SSE streaming (raw fetch). */
  sseUrl: (path: string) => `${BASE_URL}/api/v1${path}`,
  /** Auth headers to attach to a raw fetch (e.g. SSE), if a key is configured. */
  authHeaders: (): Record<string, string> => (API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
};
