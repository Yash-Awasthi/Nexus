// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitBreakerAdapterWrapper,
  type CircuitBreakerConfig,
} from "../src/circuit-breaker.js";

function makeConfig(overrides: Partial<CircuitBreakerConfig> = {}): CircuitBreakerConfig {
  return {
    name: "test-breaker",
    failureThreshold: 3,
    failureWindowMs: 60_000,
    recoveryTimeoutMs: 100,
    halfOpenMaxRequests: 2,
    halfOpenSuccessRate: 0.5,
    ...overrides,
  };
}

const succeed = () => Promise.resolve("ok");
const fail = () => Promise.reject(new Error("service error"));

describe("CircuitBreaker — closed state", () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker(makeConfig());
  });

  it("starts in closed state", () => {
    expect(cb.getState()).toBe("closed");
  });

  it("passes through successful operations", async () => {
    const result = await cb.execute(succeed);
    expect(result).toBe("ok");
  });

  it("propagates errors without opening until threshold", async () => {
    await expect(cb.execute(fail)).rejects.toThrow("service error");
    await expect(cb.execute(fail)).rejects.toThrow("service error");
    expect(cb.getState()).toBe("closed");
  });

  it("opens after hitting failure threshold", async () => {
    for (let i = 0; i < 3; i++) {
      await cb.execute(fail).catch(() => {});
    }
    expect(cb.getState()).toBe("open");
  });

  it("tracks totalRequests correctly", async () => {
    await cb.execute(succeed);
    await cb.execute(fail).catch(() => {});
    expect(cb.getMetrics().totalRequests).toBe(2);
  });

  it("records lastSuccessTime after success", async () => {
    await cb.execute(succeed);
    expect(cb.getMetrics().lastSuccessTime).not.toBeNull();
  });

  it("records lastFailureTime after failure", async () => {
    await cb.execute(fail).catch(() => {});
    expect(cb.getMetrics().lastFailureTime).not.toBeNull();
  });
});

describe("CircuitBreaker — open state", () => {
  let cb: CircuitBreaker;

  beforeEach(async () => {
    cb = new CircuitBreaker(makeConfig({ failureThreshold: 2 }));
    await cb.execute(fail).catch(() => {});
    await cb.execute(fail).catch(() => {});
  });

  it("is now open", () => {
    expect(cb.getState()).toBe("open");
  });

  it("throws CircuitBreakerOpenError without calling operation", async () => {
    const op = vi.fn().mockResolvedValue("should not run");
    await expect(cb.execute(op)).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    expect(op).not.toHaveBeenCalled();
  });

  it("CircuitBreakerOpenError has correct breakerName", async () => {
    try {
      await cb.execute(succeed);
    } catch (e) {
      expect(e).toBeInstanceOf(CircuitBreakerOpenError);
      expect((e as CircuitBreakerOpenError).breakerName).toBe("test-breaker");
    }
  });

  it("transitions to half-open after recoveryTimeoutMs", async () => {
    await new Promise((r) => setTimeout(r, 150));
    // Next execute should transition to half-open then succeed
    const result = await cb.execute(succeed);
    expect(result).toBe("ok");
    // After one success in half-open (halfOpenMaxRequests=2, halfOpenSuccessRate=0.5 → need 1 success)
    expect(cb.getState()).toBe("closed");
  });
});

describe("CircuitBreaker — half-open state", () => {
  let cb: CircuitBreaker;

  beforeEach(async () => {
    cb = new CircuitBreaker(
      makeConfig({
        failureThreshold: 1,
        recoveryTimeoutMs: 50,
        halfOpenMaxRequests: 3,
        halfOpenSuccessRate: 0.5,
      }),
    );
    await cb.execute(fail).catch(() => {});
    // Wait for recovery
    await new Promise((r) => setTimeout(r, 60));
    // Trigger half-open transition
    await cb.execute(succeed);
  });

  it("re-opens on failure in half-open", async () => {
    // We are now in half-open or closed depending on success rate
    // Reset to known half-open state
    const cb2 = new CircuitBreaker(
      makeConfig({
        failureThreshold: 1,
        recoveryTimeoutMs: 50,
        halfOpenMaxRequests: 3,
        halfOpenSuccessRate: 1.0,
      }),
    );
    await cb2.execute(fail).catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    // Trigger half-open
    await cb2.execute(fail).catch(() => {});
    expect(cb2.getState()).toBe("open");
  });
});

describe("CircuitBreaker — reset()", () => {
  it("reset returns to closed state", async () => {
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 1 }));
    await cb.execute(fail).catch(() => {});
    expect(cb.getState()).toBe("open");
    cb.reset();
    expect(cb.getState()).toBe("closed");
  });

  it("after reset, metrics are cleared", async () => {
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 2 }));
    await cb.execute(succeed);
    await cb.execute(fail).catch(() => {});
    cb.reset();
    const m = cb.getMetrics();
    expect(m.totalRequests).toBe(0);
    expect(m.successCount).toBe(0);
    expect(m.failureCount).toBe(0);
    expect(m.openedAt).toBeNull();
  });
});

describe("CircuitBreaker — sliding window", () => {
  it("failures outside the window do not count toward threshold", async () => {
    // Very short window — failures expire quickly
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 2, failureWindowMs: 50 }));
    await cb.execute(fail).catch(() => {});
    await cb.execute(fail).catch(() => {});
    // The circuit should have opened (2 failures in window)
    expect(cb.getState()).toBe("open");
    cb.reset();

    // Now inject one failure and wait for window to expire, then another failure
    const cb2 = new CircuitBreaker(makeConfig({ failureThreshold: 2, failureWindowMs: 50 }));
    await cb2.execute(fail).catch(() => {});
    await new Promise((r) => setTimeout(r, 60)); // window expires
    await cb2.execute(fail).catch(() => {}); // this is the only recent failure
    // Only 1 failure in window — still closed
    expect(cb2.getState()).toBe("closed");
  });
});

describe("CircuitBreakerAdapterWrapper", () => {
  it("wrap() passes through successful calls", async () => {
    const cb = new CircuitBreaker(makeConfig());
    const wrapper = new CircuitBreakerAdapterWrapper(cb);
    const fn = vi.fn().mockResolvedValue(42);
    const wrapped = wrapper.wrap(fn);
    const result = await wrapped("arg1", "arg2");
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledWith("arg1", "arg2");
  });

  it("wrap() propagates circuit open error", async () => {
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 1 }));
    const wrapper = new CircuitBreakerAdapterWrapper(cb);
    const failFn = () => Promise.reject(new Error("fail"));
    const wrapped = wrapper.wrap(failFn);
    await wrapped().catch(() => {});
    // Circuit now open
    await expect(wrapped()).rejects.toBeInstanceOf(CircuitBreakerOpenError);
  });

  it("getBreaker() returns the underlying CircuitBreaker", () => {
    const cb = new CircuitBreaker(makeConfig());
    const wrapper = new CircuitBreakerAdapterWrapper(cb);
    expect(wrapper.getBreaker()).toBe(cb);
  });
});
