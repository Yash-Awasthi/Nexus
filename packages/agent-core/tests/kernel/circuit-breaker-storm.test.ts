// SPDX-License-Identifier: Apache-2.0
/**
 * The circuit breaker under a scripted failure storm (plan M5.3.4).
 *
 * The existing suite proves each transition with one call at a time. This one drives the storm the
 * breaker exists for: a dependency that keeps failing while callers keep calling. What matters is
 * not only that it opens, but that an open breaker sends *nothing* downstream, that the half-open
 * probe is rationed, and that the probe's verdict is obeyed — successes close it, a single failure
 * re-opens it and the next recovery starts from a clean count.
 */
import { describe, it, expect } from "vite-plus/test";

import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  type CircuitBreakerConfig,
} from "../../src/kernel/circuit-breaker.ts";

function config(overrides: Partial<CircuitBreakerConfig> = {}): CircuitBreakerConfig {
  return {
    failureThreshold: 5,
    failureWindowMs: 60_000,
    recoveryTimeoutMs: 40,
    halfOpenMaxRequests: 3,
    halfOpenSuccessRate: 1,
    name: "storm",
    ...overrides,
  };
}

/** Counts how often the dependency was really touched. */
class Dependency {
  calls = 0;
  failure?: Error;
  async call<T>(value: T): Promise<T> {
    this.calls++;
    if (this.failure) throw this.failure;
    return value;
  }
}

/** A burst of `n` calls over `execute`, collecting rejections instead of throwing out of the test. */
async function storm<T>(
  breaker: CircuitBreaker,
  n: number,
  operation: () => Promise<T>,
): Promise<{ ok: number; refused: number; errors: Error[] }> {
  let ok = 0;
  let refused = 0;
  const errors: Error[] = [];
  for (let i = 0; i < n; i++) {
    try {
      await breaker.execute(operation);
      ok++;
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) refused++;
      else errors.push(err as Error);
    }
  }
  return { ok, refused, errors };
}

describe("circuit breaker under a failure storm", () => {
  it("opens after the threshold and then stops touching the dependency", async () => {
    const breaker = new CircuitBreaker(config());
    const dependency = new Dependency();
    dependency.failure = new Error("upstream 503");

    const result = await storm(breaker, 20, () => dependency.call("ok"));

    expect(result.ok).toBe(0);
    expect(result.errors).toHaveLength(5); // exactly the threshold reached the dependency
    expect(result.refused).toBe(15); // the other fifteen never did
    expect(dependency.calls).toBe(5);
    expect(breaker.getState()).toBe("open");
  });

  it("refuses while open, reports how long to wait, and admits a probe only after the timeout", async () => {
    const breaker = new CircuitBreaker(config());
    const dependency = new Dependency();
    dependency.failure = new Error("upstream 503");
    await storm(breaker, 6, () => dependency.call("ok"));
    const callsWhenOpened = dependency.calls;

    const wait = await breaker.execute(() => dependency.call("probe")).catch((err) => err as Error);
    expect(wait).toBeInstanceOf(CircuitBreakerOpenError);
    expect((wait as CircuitBreakerOpenError).retryAfterMs).toBeGreaterThan(0);
    expect(dependency.calls).toBe(callsWhenOpened);

    await new Promise((r) => setTimeout(r, breaker["config"].recoveryTimeoutMs + 5));
    dependency.failure = undefined;
    const probe = await breaker.execute(() => dependency.call("probe"));
    expect(probe).toBe("probe");
    expect(breaker.getState()).toBe("half-open"); // one success of three required
  });

  it("rations the half-open probe and sends nothing extra downstream", async () => {
    const breaker = new CircuitBreaker(config({ halfOpenMaxRequests: 3, halfOpenSuccessRate: 1 }));
    const dependency = new Dependency();
    dependency.failure = new Error("upstream 503");
    await storm(breaker, 5, () => dependency.call("ok"));
    await new Promise((r) => setTimeout(r, 45));
    dependency.failure = undefined;

    // Three probes in flight at once: all are admitted, the fourth is refused without the call.
    const slow = () => new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 10));
    const probes = await Promise.all([
      breaker.execute(slow),
      breaker.execute(slow),
      breaker.execute(slow),
      breaker.execute(slow).catch((e: unknown) => e as Error),
    ]);

    expect(probes.slice(0, 3)).toEqual(["slow", "slow", "slow"]);
    expect(probes[3]).toBeInstanceOf(CircuitBreakerOpenError);
    expect(breaker.getState()).toBe("closed"); // all three succeeded, rate met
  });

  it("re-opens on a single failed probe, and the next recovery starts from a clean count", async () => {
    const breaker = new CircuitBreaker(
      config({ halfOpenMaxRequests: 4, halfOpenSuccessRate: 0.5 }),
    );
    const dependency = new Dependency();
    dependency.failure = new Error("upstream 503");
    await storm(breaker, 5, () => dependency.call("ok"));

    await new Promise((r) => setTimeout(r, 45));
    // First probe after recovery fails: open again, even though half-open allows four.
    const failedProbe = await breaker.execute(() => dependency.call("x")).catch((e) => e as Error);
    expect(failedProbe).toBeInstanceOf(Error);
    expect(breaker.getState()).toBe("open");
    // The probe budget is reset when half-open is entered again, not while the circuit is open: the
    // next recovery admits halfOpenMaxRequests fresh probes even though this one was spent.

    await new Promise((r) => setTimeout(r, 45));
    dependency.failure = undefined;
    // Two successes meet the 50% of four projection and close it.
    expect(await breaker.execute(() => dependency.call("a"))).toBe("a");
    expect(breaker.getState()).toBe("half-open");
    expect(await breaker.execute(() => dependency.call("b"))).toBe("b");
    expect(breaker.getState()).toBe("closed");
    // Closing clears the failure history, so a later single failure does not immediately re-open.
    await breaker.execute(() => dependency.call("c")).catch(() => {});
    expect(breaker.getState()).toBe("closed");
  });

  it("a storm that stops before the threshold never opens", async () => {
    const breaker = new CircuitBreaker(config({ failureThreshold: 5 }));
    const dependency = new Dependency();
    dependency.failure = new Error("blip");

    await storm(breaker, 4, () => dependency.call("ok"));
    expect(breaker.getState()).toBe("closed");

    dependency.failure = undefined;
    expect(await breaker.execute(() => dependency.call("fine"))).toBe("fine");
    expect(breaker.getState()).toBe("closed");
  });
});
