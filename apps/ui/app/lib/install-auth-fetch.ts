// SPDX-License-Identifier: Apache-2.0
/**
 * Global fetch interceptor — attaches the stored JWT (`nexus_token`) as an
 * `Authorization: Bearer` header to same-origin `/api/*` requests.
 *
 * Why: the API mounts every `/api/*` (bridge) route behind `requireAuth`, but
 * the UI historically calls those endpoints with raw `fetch("/api/...")` and no
 * token (178+ call sites across route modules). Without this, every such call
 * 401s and pages render empty — the "demo looks stubbed / logged-in but broken"
 * symptom. Patching fetch once here fixes all call sites without touching them.
 *
 * Safe by construction:
 *  - browser-only (guarded by `typeof window`), install-once (idempotent).
 *  - only touches same-origin `/api/*` URLs; never cross-origin.
 *  - never overrides an Authorization header a caller already set (authFetch).
 *  - swallows its own errors and always falls back to the original fetch.
 */

const TOKEN_KEY = "nexus_token";

export function installAuthFetch(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __nexusFetchPatched?: boolean };
  if (w.__nexusFetchPatched) return;
  w.__nexusFetchPatched = true;

  const original = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;

      // Same-origin /api/* only (relative "/api..." or absolute to this host).
      const sameHost = url.includes(`//${window.location.host}/api`);
      const relative = url.startsWith("/api");
      if (relative || sameHost) {
        const token = window.localStorage.getItem(TOKEN_KEY);
        if (token) {
          const headers = new Headers(
            init?.headers ?? (input instanceof Request ? input.headers : undefined),
          );
          if (!headers.has("Authorization")) {
            headers.set("Authorization", `Bearer ${token}`);
            init = { ...init, headers };
          }
        }
      }
    } catch {
      /* fall through to the original fetch on any error */
    }
    return original(input as RequestInfo | URL, init);
  };
}
