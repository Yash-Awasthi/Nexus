// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the auth-fetch interceptor's 401 → refresh → retry-once
 * behaviour (install-auth-fetch.ts / createAuthFetch).
 *
 * Regression coverage for the retry bug: the first implementation retried from
 * the FAILED attempt's init, which already carried the stale Authorization
 * header, so the freshly rotated token never got attached and the retry 401'd
 * again. Retries must rebuild from the caller's ORIGINAL init.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { createAuthFetch } from "./install-auth-fetch";

const TOKEN_KEY = "nexus_token";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function authOf(init?: RequestInit): string | null {
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  return headers.get("Authorization");
}

describe("createAuthFetch", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("retries ONCE from the caller's original init with the freshly rotated token", async () => {
    localStorage.setItem(TOKEN_KEY, "old-token");
    const inits: RequestInit[] = [];
    const original = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init ?? {});
      return inits.length === 1 ? jsonResponse(401, {}) : jsonResponse(200, { ok: true });
    });
    const refresh = vi.fn(async () => {
      localStorage.setItem(TOKEN_KEY, "new-token");
      return true;
    });

    const fetchPatched = createAuthFetch(original as typeof fetch, refresh);
    const res = await fetchPatched("/api/settings/council");

    expect(res.status).toBe(200);
    expect(original).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    // First attempt rode the stored (stale) token…
    expect(authOf(inits[0])).toBe("Bearer old-token");
    // …the retry must attach the rotated token, not the stale one.
    expect(authOf(inits[1])).toBe("Bearer new-token");
    // The stale header must not appear anywhere in the retried request.
    expect(JSON.stringify(inits[1])).not.toContain("old-token");
  });

  it("never retries auth endpoints (no recursion through /auth/refresh)", async () => {
    localStorage.setItem(TOKEN_KEY, "expired-token");
    const original = vi.fn(async () => jsonResponse(401, { error: "invalid_refresh_token" }));
    const refresh = vi.fn(async () => true);

    const fetchPatched = createAuthFetch(original as typeof fetch, refresh);
    const res = await fetchPatched("/api/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: "rt" }),
    });

    expect(res.status).toBe(401);
    expect(original).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("returns the 401 untouched when refresh is unrecoverable (no infinite loop)", async () => {
    localStorage.setItem(TOKEN_KEY, "expired-token");
    const original = vi.fn(async () => jsonResponse(401, { message: "JWT expired" }));
    const refresh = vi.fn(async () => false);

    const fetchPatched = createAuthFetch(original as typeof fetch, refresh);
    const res = await fetchPatched("/api/memory/entries");

    expect(res.status).toBe(401);
    expect(original).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on non-401 responses", async () => {
    localStorage.setItem(TOKEN_KEY, "valid-token");
    const original = vi.fn(async () => jsonResponse(200, { ok: true }));
    const refresh = vi.fn(async () => true);

    const fetchPatched = createAuthFetch(original as typeof fetch, refresh);
    const res = await fetchPatched("/api/health");

    expect(res.status).toBe(200);
    expect(original).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("retries at most once even when the retried request 401s again", async () => {
    localStorage.setItem(TOKEN_KEY, "old-token");
    const original = vi.fn(async () => jsonResponse(401, { message: "still 401" }));
    const refresh = vi.fn(async () => {
      localStorage.setItem(TOKEN_KEY, "new-token");
      return true;
    });

    const fetchPatched = createAuthFetch(original as typeof fetch, refresh);
    const res = await fetchPatched("/api/settings/council");

    expect(res.status).toBe(401);
    expect(original).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("leaves cross-origin requests untouched", async () => {
    localStorage.setItem(TOKEN_KEY, "token");
    const original = vi.fn(async () => jsonResponse(401, {}));
    const refresh = vi.fn(async () => true);

    const fetchPatched = createAuthFetch(original as typeof fetch, refresh);
    const res = await fetchPatched("https://example.com/api/other");

    expect(res.status).toBe(401);
    expect(original).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});