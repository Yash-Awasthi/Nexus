// SPDX-License-Identifier: Apache-2.0
/**
 * Auth hardening (§14.3) — process-wide singletons wired into the request path.
 *
 * - {@link loginThrottle} — exponential-backoff lockout on repeated failed logins,
 *   keyed by `email|ip` at the login route.
 * - {@link sessionRevocations} — per-`jti` / per-subject session revocation, checked
 *   inside @nexus/auth's `authenticate()` (via middleware/auth.ts) so a revoked
 *   token is rejected before any route runs.
 *
 * Both are intentionally in-memory (single-pod). Swap for a Redis-backed store
 * without touching callers when managed Redis is available.
 */
import { LoginThrottle, SessionRevocationRegistry, type NexusTokenPayload } from "@nexus/auth";

export const loginThrottle = new LoginThrottle();
export const sessionRevocations = new SessionRevocationRegistry();

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

/** Throw REVOKED_TOKEN if the verified payload has been revoked. */
export function assertTokenNotRevoked(
  payload: Pick<NexusTokenPayload, "sub" | "iat" | "jti">,
): void {
  sessionRevocations.assertNotRevoked(payload);
}

/** Revoke every token for `subject` issued at/before now (e.g. password change). */
export function revokeAllForSubject(subject: string): void {
  sessionRevocations.revokeAllForSubject(subject);
}

/** Revoke one token by `jti` (log out a single session). */
export function revokeJti(jti: string, expSeconds?: number): void {
  sessionRevocations.revokeJti(jti, expSeconds);
}