// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import {
  ConfidenceCircuitBreaker,
  SlidingWindowCircuitBreaker,
  CircuitOpenError,
  ErrorRateStrategy,
} from "./index";

describe("ConfidenceCircuitBreaker.execute (opossum-style fallback)", () => {
  it("runs the function while closed and records success", async () => {
    const breaker = new ConfidenceCircuitBreaker("test");
    const fn = vi.fn(async () => 42);
    expect(await breaker.execute(fn)).toBe(42);
    expect(breaker.getStats().successCount).toBe(1);
  });

  it("fails fast with fallback once the circuit opens", async () => {
    // ErrorRateStrategy requires >=5 samples; 5 straight failures trip it.
    const breaker = new ConfidenceCircuitBreaker("test", [new ErrorRateStrategy(0.1)]);
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    const fallback = vi.fn(async () => "fallback-value");

    for (let i = 0; i < 5; i++) {
      await breaker.execute(fn).catch(() => {});
    }
    expect(breaker.getStats().state).toBe("open");

    // Circuit is open — next call must fail fast and hit the fallback.
    expect(await breaker.execute(fn, fallback)).toBe("fallback-value");
    expect(fallback).toHaveBeenCalledTimes(1);
    // fn is never called again while open.
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("throws CircuitOpenError when open and no fallback is provided", async () => {
    const breaker = new ConfidenceCircuitBreaker("test", [new ErrorRateStrategy(0.1)]);
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    for (let i = 0; i < 5; i++) {
      await breaker.execute(fn).catch(() => {});
    }
    await expect(breaker.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
  });
});

describe("SlidingWindowCircuitBreaker.execute", () => {
  it("runs the function while closed and uses fallback while open", async () => {
    const breaker = new SlidingWindowCircuitBreaker("test", { failureThreshold: 2 });
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    const fallback = vi.fn(async () => "cached");

    await expect(breaker.execute(fn)).rejects.toThrow("boom");
    await expect(breaker.execute(fn)).rejects.toThrow("boom");
    // Open now.
    expect(await breaker.execute(fn, fallback)).toBe("cached");
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("throws CircuitOpenError when open and no fallback", async () => {
    const breaker = new SlidingWindowCircuitBreaker("test", { failureThreshold: 2 });
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(breaker.execute(fn)).rejects.toThrow("boom");
    await expect(breaker.execute(fn)).rejects.toThrow("boom");
    await expect(breaker.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("recovers through half-open after reset timeout", async () => {
    const breaker = new SlidingWindowCircuitBreaker("test", {
      failureThreshold: 2,
      resetTimeoutMs: 10,
    });
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    await breaker.execute(fn).catch(() => {});
    await breaker.execute(fn).catch(() => {});
    expect(breaker.getState()).toBe("open");

    await new Promise((r) => setTimeout(r, 20));
    expect(breaker.getState()).toBe("half-open");
    expect(await breaker.execute(async () => "ok")).toBe("ok");
  });
});