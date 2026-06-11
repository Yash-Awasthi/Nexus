import { CircuitBreaker, CircuitBreakerOpenError, HealthAwareCircuitBreaker } from "../orchestration/circuit-breaker";
import { LocalEventBus } from "../orchestration/event-bus";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;
  let eventBus: LocalEventBus;

  beforeEach(() => {
    eventBus = new LocalEventBus();
    breaker = new CircuitBreaker(
      {
        failureThreshold: 3,
        recoveryTimeoutMs: 5000,
        halfOpenMaxRequests: 3,
        halfOpenSuccessRate: 0.5,
        name: "test-breaker"
      },
      eventBus
    );
  });

  test("initial state is closed", () => {
    expect(breaker.getState()).toBe("closed");
  });

  test("executes successful operations", async () => {
    const result = await breaker.execute(async () => "success");
    expect(result).toBe("success");
    expect(breaker.getState()).toBe("closed");
  });

  test("tracks successful executions", async () => {
    await breaker.execute(async () => "ok");
    await breaker.execute(async () => "ok");
    const metrics = breaker.getMetrics();
    expect(metrics.successCount).toBe(2);
    expect(metrics.totalRequests).toBe(2);
  });

  test("opens circuit after failure threshold", async () => {
    // First 3 failures should open the circuit
    for (let i = 0; i < 3; i++) {
      try {
        await breaker.execute(async () => {
          throw new Error(`failure ${i}`);
        });
      } catch {
        // expected
      }
    }

    expect(breaker.getState()).toBe("open");

    const metrics = breaker.getMetrics();
    expect(metrics.failureCount).toBe(3);
    expect(metrics.state).toBe("open");
    expect(metrics.openedAt).not.toBeNull();
  });

  test("throws CircuitBreakerOpenError when circuit is open", async () => {
    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      try {
        await breaker.execute(async () => {
          throw new Error("fail");
        });
      } catch {
        // expected
      }
    }

    // Now circuit should be open
    try {
      await breaker.execute(async () => "should not reach");
      fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitBreakerOpenError);
      const cbErr = err as CircuitBreakerOpenError;
      expect(cbErr.breakerName).toBe("test-breaker");
      expect(cbErr.retryAfterMs).toBeGreaterThan(0);
    }
  });

  test("transitions to half-open after recovery timeout", async () => {
    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      try {
        await breaker.execute(async () => {
          throw new Error("fail");
        });
      } catch {
        // expected
      }
    }

    expect(breaker.getState()).toBe("open");

    // Use a shorter recovery timeout for the test
    const fastBreaker = new CircuitBreaker(
      {
        failureThreshold: 1,
        recoveryTimeoutMs: 50,
        halfOpenMaxRequests: 3,
        halfOpenSuccessRate: 0.5,
        name: "fast-breaker"
      }
    );

    try {
      await fastBreaker.execute(async () => {
        throw new Error("fail");
      });
    } catch {
      // expected
    }

    // Circuit should be open
    expect(fastBreaker.getState()).toBe("open");

    // Wait for recovery timeout
    await new Promise((r) => setTimeout(r, 60));

    // Next execution should transition to half-open
    const result = await fastBreaker.execute(async () => "recovered");
    expect(result).toBe("recovered");
    expect(fastBreaker.getState()).toBe("half-open");
  });

  test("closes circuit after success in half-open", async () => {
    // Config: halfOpenMaxRequests=3 means at least 3 probes are allowed.
    // With halfOpenSuccessRate=0.6, need successes / maxRequests >= 0.6
    // After 1 success: 1/3 ≈ 0.33 < 0.6 → stays half-open
    // After 2 successes: 2/3 ≈ 0.67 >= 0.6 → closes
    const fastBreaker = new CircuitBreaker(
      {
        failureThreshold: 1,
        recoveryTimeoutMs: 50,
        halfOpenMaxRequests: 3,
        halfOpenSuccessRate: 0.6,
        name: "recovery-breaker"
      }
    );

    // Trip
    try {
      await fastBreaker.execute(async () => { throw new Error("fail"); });
    } catch { /* expected */ }

    expect(fastBreaker.getState()).toBe("open");

    // Wait for recovery
    await new Promise((r) => setTimeout(r, 60));

    // First half-open success — rate = 1/3 ≈ 0.33 < 0.6, stays half-open
    await fastBreaker.execute(async () => "ok");
    expect(fastBreaker.getState()).toBe("half-open");

    // Second half-open success — rate = 2/3 ≈ 0.67 >= 0.6, closes
    await fastBreaker.execute(async () => "ok");
    expect(fastBreaker.getState()).toBe("closed");
  });

  test("half-open failure immediately re-opens circuit", async () => {
    const fastBreaker = new CircuitBreaker(
      {
        failureThreshold: 1,
        recoveryTimeoutMs: 100,
        halfOpenMaxRequests: 3,
        halfOpenSuccessRate: 0.5,
        name: "immediate-reopen"
      }
    );

    // Trip
    try { await fastBreaker.execute(async () => { throw new Error("fail"); }); } catch { /* expected */ }

    // Wait for recovery
    await new Promise((r) => setTimeout(r, 120));

    // Transition to half-open with success
    await fastBreaker.execute(async () => "ok");

    // Now fail in half-open
    try { await fastBreaker.execute(async () => { throw new Error("fail again"); }); } catch { /* expected */ }

    // Should immediately re-open
    expect(fastBreaker.getState()).toBe("open");
  });

  test("reset restores to closed state", async () => {
    // Trip
    for (let i = 0; i < 3; i++) {
      try { await breaker.execute(async () => { throw new Error("fail"); }); } catch { /* expected */ }
    }

    expect(breaker.getState()).toBe("open");

    breaker.reset();

    expect(breaker.getState()).toBe("closed");
    const metrics = breaker.getMetrics();
    expect(metrics.failureCount).toBe(0);
    expect(metrics.totalRequests).toBe(0);
    expect(metrics.openedAt).toBeNull();

    // Should work again
    const result = await breaker.execute(async () => "back online");
    expect(result).toBe("back online");
  });

  test("getMetrics returns correct state", () => {
    const metrics = breaker.getMetrics();
    expect(metrics).toHaveProperty("state", "closed");
    expect(metrics).toHaveProperty("failureCount");
    expect(metrics).toHaveProperty("successCount");
    expect(metrics).toHaveProperty("totalRequests");
    expect(metrics).toHaveProperty("lastFailureTime");
    expect(metrics).toHaveProperty("lastSuccessTime");
    expect(metrics).toHaveProperty("openedAt");
  });

  test("publishes circuit_breaker_opened event", async () => {
    const events: any[] = [];
    eventBus.subscribe("circuit_breaker_opened", (payload) => {
      events.push(payload);
    });

    for (let i = 0; i < 3; i++) {
      try { await breaker.execute(async () => { throw new Error("fail"); }); } catch { /* expected */ }
    }

    expect(events.length).toBe(1);
    expect(events[0].name).toBe("test-breaker");
  });

  test("publishes circuit_breaker_closed event on recovery", async () => {
    const events: string[] = [];
    eventBus.subscribe("circuit_breaker_closed", () => { events.push("closed"); });

    const fastBreaker = new CircuitBreaker(
      {
        failureThreshold: 1,
        recoveryTimeoutMs: 50,
        halfOpenMaxRequests: 2,
        halfOpenSuccessRate: 0.5,
        name: "event-test"
      },
      eventBus
    );

    // Trip
    try { await fastBreaker.execute(async () => { throw new Error("fail"); }); } catch { /* expected */ }

    // Recover
    await new Promise((r) => setTimeout(r, 60));
    await fastBreaker.execute(async () => "ok");
    await fastBreaker.execute(async () => "ok");

    expect(events).toContain("closed");
  });
});

describe("HealthAwareCircuitBreaker", () => {
  test("health check probe triggers half-open", async () => {
    let healthy = false;
    let healthCheckCount = 0;

    const breaker = new HealthAwareCircuitBreaker(
      {
        failureThreshold: 1,
        recoveryTimeoutMs: 10000,
        halfOpenMaxRequests: 3,
        halfOpenSuccessRate: 0.5,
        name: "health-breaker"
      },
      async () => {
        healthCheckCount++;
        return healthy;
      },
      50,
      undefined,
      undefined,
      undefined
    );

    try {
      // Trip the breaker
      await expect(breaker.execute(async () => { throw new Error("fail"); })).rejects.toThrow();

      expect(breaker.getState()).toBe("open");

      // Now make health check pass
      healthy = true;

      // Wait for health probe to trigger
      await new Promise((r) => setTimeout(r, 100));

      expect(breaker.getState()).toBe("half-open");
      expect(healthCheckCount).toBeGreaterThan(0);
    } finally {
      // Clean up interval to prevent Jest from hanging
      breaker.destroy();
    }
  });
});
