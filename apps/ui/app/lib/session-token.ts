// SPDX-License-Identifier: Apache-2.0
/**
 * Where the access token lives for the current run: in memory only, so no page
 * script can read it back from browser storage. A reload gets a fresh one from
 * the refresh cookie, or from the host that owns the session (the desktop app
 * keeps it in the OS keychain).
 *
 * Everything that needs a token reads it here.
 */

const LEGACY_TOKEN_KEY = "nexus_token";

let inMemoryToken: string | null = null;
let ready: Promise<void> = Promise.resolve();

/** Hold the token for this run. `null` clears it. */
export function setSessionToken(token: string | null): void {
  inMemoryToken = token;
}

export function getSessionToken(): string | null {
  return inMemoryToken;
}

/** Hold API calls until `pending` settles: after a reload there is no token until the cookie is exchanged. */
export function holdSessionUntil(pending: Promise<unknown>): void {
  ready = pending.then(
    () => undefined,
    () => undefined,
  );
}

export function sessionReady(): Promise<void> {
  return ready;
}

/** Move a token an earlier version left in browser storage into memory, and delete it there. */
export function adoptStoredToken(): void {
  try {
    const stored = window.localStorage.getItem(LEGACY_TOKEN_KEY);
    if (stored === null) return;
    window.localStorage.removeItem(LEGACY_TOKEN_KEY);
    inMemoryToken ??= stored;
  } catch {
    /* storage unavailable: nothing to adopt */
  }
}
