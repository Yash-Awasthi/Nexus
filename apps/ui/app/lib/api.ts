// SPDX-License-Identifier: Apache-2.0
/**
 * Authenticated fetch helper.
 *
 * Attaches the logged-in user's access token as an `Authorization: Bearer`
 * header. Use this for any call to an auth-gated endpoint (e.g.
 * /api/user/provider-keys, /api/chat/stream, /api/v1/council/*).
 */

import { getSessionToken } from "./session-token";

/** fetch() with the bearer token attached when present. */
export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const token = getSessionToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

/** A failed API call: the server's message, its HTTP status and its error code. */
class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** A JSON call on authFetch. `json` becomes the body; a non-2xx reply throws an ApiError. */
export async function apiFetch<T>(
  url: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  const body = json !== undefined ? JSON.stringify(json) : rest.body;
  if (typeof body === "string" && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const res = await authFetch(url, { ...rest, headers, ...(body !== undefined ? { body } : {}) });
  const out = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!res.ok)
    throw new ApiError(
      out.message ?? out.error ?? `Request failed (${res.status})`,
      res.status,
      out.error,
    );
  return out as T;
}
