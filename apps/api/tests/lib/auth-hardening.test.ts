// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { AuthError } from "@nexus/auth";
import {
  assertLoginAllowed,
  assertTokenNotRevoked,
  loginThrottleKey,
  recordLoginFailure,
  recordLoginSuccess,
  revokeAllForSubject,
  revokeJti,
} from "../../src/lib/auth-hardening.js";

describe("loginThrottleKey", () => {
  it("normalizes email case and whitespace, keeps the ip", () => {
    expect(loginThrottleKey("  Alice@Example.COM ", "10.0.0.7")).toBe("alice@example.com|10.0.0.7");
  });
});

describe("login throttle wrappers", () => {
  it("assertLoginAllowed passes before any failures", () => {
    expect(() => assertLoginAllowed("fresh@x.io|1.1.1.1")).not.toThrow();
  });

  it("locks the key after the threshold of failures", () => {
    const key = "lockout@x.io|2.2.2.2";
    for (let i = 0; i < 5; i++) recordLoginFailure(key);
    try {
      assertLoginAllowed(key);
      expect.unreachable("should have thrown RATE_LIMITED");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe("RATE_LIMITED");
      expect((err as AuthError).httpStatus).toBe(429);
    }
  });

  it("recordLoginSuccess clears the lockout", () => {
    const key = "recover@x.io|3.3.3.3";
    for (let i = 0; i < 5; i++) recordLoginFailure(key);
    recordLoginSuccess(key);
    expect(() => assertLoginAllowed(key)).not.toThrow();
  });
});

describe("session revocation wrappers", () => {
  it("revokeJti rejects only the revoked jti", () => {
    const payload = { sub: "u-1", iat: 1_700_000_000, jti: "tok-abc" };
    revokeJti("tok-abc", 1_800_000_000);
    expect(() => assertTokenNotRevoked(payload)).toThrow(AuthError);
    expect(() =>
      assertTokenNotRevoked({ sub: "u-1", iat: 1_700_000_000, jti: "tok-other" }),
    ).not.toThrow();
  });

  it("revokeAllForSubject rejects tokens issued at/before the cutoff", () => {
    const sub = "sub-42";
    revokeAllForSubject(sub);
    expect(() => assertTokenNotRevoked({ sub, iat: 1_600_000_000, jti: "old" })).toThrow(AuthError);
    // Tokens issued after the cutoff stay valid — and other subjects are untouched.
    const futureIat = Math.floor(Date.now() / 1000) + 3600;
    expect(() => assertTokenNotRevoked({ sub, iat: futureIat, jti: "new" })).not.toThrow();
    expect(() =>
      assertTokenNotRevoked({ sub: "someone-else", iat: 1_600_000_000, jti: "x" }),
    ).not.toThrow();
  });

  it("REVOKED_TOKEN maps to 401", () => {
    revokeJti("tok-401");
    try {
      assertTokenNotRevoked({ sub: "u", iat: 1_700_000_000, jti: "tok-401" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as AuthError).code).toBe("REVOKED_TOKEN");
      expect((err as AuthError).httpStatus).toBe(401);
    }
  });
});