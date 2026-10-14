// SPDX-License-Identifier: Apache-2.0
/**
 * Login throttle (§14.3): exponential-backoff lockout keyed by `email|ip`, in process
 * memory. Access-token revocation lives in lib/session-revocation.ts.
 */
import { LoginThrottle } from "@nexus/auth";

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
