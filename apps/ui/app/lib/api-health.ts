// SPDX-License-Identifier: Apache-2.0
/**
 * "The server is having trouble", as one app-wide fact.
 *
 * Most pages here fetch once and keep the result in local state. When that fetch fails, several of them
 * fall back to an empty list or to defaults, because a page cannot always tell "you have none" from "the
 * server did not answer" — and the person is then looking at plausible, wrong data with no hint that
 * anything went wrong. Fixing that page by page is the right long-term answer (the states test keeps
 * score), but a single honest signal costs nothing and covers every call site at once, including the ones
 * added tomorrow.
 *
 * `install-auth-fetch` reports here on a 5xx or a dead socket; the shell renders one bar. A successful
 * API response clears it, so it disappears on its own once the server recovers.
 *
 * Deliberately not a retry loop: retrying is the page's decision, and a silent retry storm on a restarting
 * server is worse than telling the person what is happening.
 */

export interface ApiTrouble {
  /** Last status seen, or 0 for a socket that never answered. */
  status: number;
  /** A message from the server when it sent one. */
  detail?: string;
  at: number;
}

let current: ApiTrouble | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Note a failed request. Called by the fetch interceptor; safe to call for any non-2xx. */
export function noteApiTrouble(status: number, detail?: string): void {
  if (status !== 0 && status < 500) return;
  // One bar per outage, not one per request in flight.
  if (current && current.status === status) {
    if (detail && detail !== current.detail) {
      current = { ...current, detail };
      emit();
    }
    return;
  }
  current = { status, ...(detail ? { detail } : {}), at: Date.now() };
  emit();
}

/** Note a response the server answered normally; clears the bar. */
export function noteApiHealthy(): void {
  if (!current) return;
  current = null;
  emit();
}

export function apiTroubleSnapshot(): ApiTrouble | null {
  return current;
}

/** For tests: forget everything without notifying. */
export function resetApiTrouble(): void {
  current = null;
}

export function subscribeApiTrouble(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The sentence the bar shows. Kept here so it is testable without rendering. */
export function apiTroubleMessage(trouble: ApiTrouble): string {
  if (trouble.status === 0) {
    return "The server could not be reached. Anything on this page that is missing is probably still there.";
  }
  const code = `HTTP ${trouble.status}`;
  if (trouble.status === 503)
    return `The server is restarting or overloaded (${code}). Reload in a moment.`;
  return `The server answered with an error (${code}). Some of what is missing on this page was never loaded.`;
}
