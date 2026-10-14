// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { AuthError } from "@nexus/auth";
import {
  assertLoginAllowed,
  loginThrottleKey,
  recordLoginFailure,
  recordLoginSuccess,
} from "../../src/lib/auth-hardening.ts";

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
