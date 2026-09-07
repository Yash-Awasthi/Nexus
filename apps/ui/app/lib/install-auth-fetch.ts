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

export type RefreshSessionFn = () => Promise<boolean>;

/**
 * Build the patched fetch. Pure and dependency-injected so unit tests can drive
 * it with mocks (see install-auth-fetch.test.ts). `refreshSession` is invoked
 * at most once per 401; if it returns true the request is retried ONCE from the
 * caller's original init (so the freshly rotated token gets attached — retrying
 * from the failed attempt's init would ride the stale Authorization header).
 */
export function createAuthFetch(
  original: typeof fetch,
  refreshSession: RefreshSessionFn,
  tokenKey: string = TOKEN_KEY,
): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url = "";
    let sameOriginApi = false;
    let hadToken = false;
    try {
      url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;

      // Same-origin /api/* only. Resolve against location so a relative
      // "/api/..." and an absolute URL both go through one real comparison —
      // a substring check on the raw string can be tricked by an attacker
      // URL that merely contains "//host/api" somewhere (e.g. in a query param).
      const parsed = new URL(url, window.location.href);
      sameOriginApi = parsed.host === window.location.host && parsed.pathname.startsWith("/api");
      hadToken = sameOriginApi && window.localStorage.getItem(tokenKey) !== null;
    } catch {
      /* fall through to the original fetch on any error */
    }
    const isAuthEndpoint = /^\/api\/v1\/auth\//.test(url.split("?")[0] ?? "");

    const attempt = (reqInit: RequestInit | undefined, retried: boolean): Promise<Response> => {
      let finalInit = reqInit;
      try {
        if (sameOriginApi) {
          const token = window.localStorage.getItem(tokenKey);
          if (token) {
            const headers = new Headers(
              reqInit?.headers ?? (input instanceof Request ? input.headers : undefined),
            );
            if (!headers.has("Authorization")) {
              headers.set("Authorization", `Bearer ${token}`);
              finalInit = { ...reqInit, headers };
            }
          }
        }
      } catch {
        /* keep the caller's init */
      }
      return original(input as RequestInfo | URL, finalInit).then(async (res) => {
        if (!retried && res.status === 401 && sameOriginApi && hadToken && !isAuthEndpoint) {
          const refreshed = await refreshSession();
          // Retry from the CALLER's init (not finalInit): finalInit already
          // carries the stale Authorization header that just 401'd, and the
          // retry must attach the freshly rotated token.
          if (refreshed) return attempt(init, true);
        }
        return res;
      });
    };

    return attempt(init, false);
  };
}

export function installAuthFetch(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __nexusFetchPatched?: boolean };
  if (w.__nexusFetchPatched) return;
  w.__nexusFetchPatched = true;

  const original = window.fetch.bind(window);

  // One 401-retry per request: a page that mounts with a just-expired access
  // token would otherwise 401 on every initial fetch and render an empty state
  // until the next refresh tick. On 401 we exchange the refresh token once
  // (coalesced — concurrent 401s share a single rotation) and retry with the
  // fresh token. Genuinely dead sessions fall through: refreshSession returns
  // false, the 401 surfaces, and AuthContext's own retry-then-clean-logout
  // path (F9) still handles sign-out. Auth endpoints are excluded so a login
  // failure or a revoked refresh token can never recurse through this.
  //
  // The refresh callback is imported lazily so this module stays free of the
  // `~` alias at module-eval time (the unit test imports it without vite).
  window.fetch = createAuthFetch(original, () =>
    import("~/context/AuthContext").then((m) => m.refreshSession()),
  );
}