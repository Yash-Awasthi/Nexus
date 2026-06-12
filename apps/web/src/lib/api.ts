// SPDX-License-Identifier: Apache-2.0
const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
const KEY = (import.meta.env.VITE_API_KEY as string | undefined) ?? "";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (KEY) headers.Authorization = `Bearer ${KEY}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", `/api/v1${path}`),
  post: <T>(path: string, b: unknown) => request<T>("POST", `/api/v1${path}`, b),
  patch: <T>(path: string, b: unknown) => request<T>("PATCH", `/api/v1${path}`, b),
  health: () => request<{ status: string; timestamp: string }>("GET", "/health"),
};
