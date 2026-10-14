// SPDX-License-Identifier: Apache-2.0
/**
 * Login throttle (§14.3): exponential-backoff lockout keyed by `email|ip`, in process
 * memory. Access-token revocation lives in lib/session-revocation.ts.
 */
import { LoginThrottle } from "@nexus/auth";

import { getSharedKV } from "./shared-kv.ts";

const loginThrottle = new LoginThrottle();

/** Composite throttle key for one login attempt (normalized email + client ip). */
export function loginThrottleKey(email: string, ip: string): string {
  return `${email.trim().toLowerCase()}|${ip}`;
}

/** Throw RATE_LIMITED while `key` is locked out (call before verifying credentials). */
export function assertLoginAllowed(key: string): void {
  loginThrottle.assertNotLocked(key);
}

/** Record a failed login; returns the resulting lockout ms (0 if none yet). */
export function recordLoginFailure(key: string): number {
  return loginThrottle.recordFailure(key);
}

/** Clear the failure counter after a successful login. */
export function recordLoginSuccess(key: string): void {
  loginThrottle.recordSuccess(key);
}

// Second line behind the per-address throttle: rotating addresses must not multiply guesses.
// ponytail: fixed window, so an attacker can keep the owner out for at most 5 minutes at a time
const ACCOUNT_FAILURES = 30;
const ACCOUNT_WINDOW_MS = 5 * 60_000;
const accountKey = (email: string) => `auth:login-fail:${email.trim().toLowerCase()}`;

/** Whether `email` has used up its failed sign-ins for the current window (fails open). */
export async function accountLocked(email: string): Promise<boolean> {
  const n = await getSharedKV()
    .get<number>(accountKey(email))
    .catch(() => 0);
  return (n ?? 0) >= ACCOUNT_FAILURES;
}

/** Count one failed sign-in against `email` across every address. */
export async function recordAccountFailure(email: string): Promise<void> {
  await getSharedKV()
    .incr(accountKey(email), ACCOUNT_WINDOW_MS)
    .catch(() => undefined);
}
