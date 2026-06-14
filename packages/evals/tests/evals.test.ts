// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  EvalRunner,
  EvalSuite,
  exactMatch,
  fieldsPresent,
  containsString,
  matchesSchema,
  allOf,
} from "../src/index.js";
import type { EvalAdapter } from "../src/index.js";

// ── Stub adapter ──────────────────────────────────────────────────────────────

const echoAdapter: EvalAdapter = {
  name: "echo",
  execute: async (task) => task,
};

const throwingAdapter: EvalAdapter = {
  name: "thrower",
  execute: async () => {
    throw new Error("adapter failed");
  },
};

const greetAdapter: EvalAdapter = {
  name: "greeter",
  execute: async (task) => {
    const t = task as { name: string };
    return { greeting: `Hello, ${t.name}!`, length: t.name.length };
  },
};

// ── Scorers ───────────────────────────────────────────────────────────────────

describe("exactMatch", () => {
  it("passes when outputs are deeply equal", () => {
    const r = exactMatch({ a: 1 })({ a: 1 });
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
  });

  it("fails when outputs differ", () => {
    const r = exactMatch({ a: 1 })({ a: 2 });
    expect(r.pass).toBe(false);
    expect(r.score).toBe(0);
    expect(r.reason).toBeTruthy();
  });
});

describe("fieldsPresent", () => {
  it("passes when all keys present", () => {
    const r = fieldsPresent("id", "name")({ id: "1", name: "Jane" });
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
  });

  it("partial score when some fields missing", () => {
    const r = fieldsPresent("id", "name", "email")({ id: "1", name: "Jane" });
    expect(r.pass).toBe(false);
    expect(r.score).toBeCloseTo(2 / 3);
    expect(r.reason).toContain("email");
  });

  it("fails on non-object output", () => {
    const r = fieldsPresent("id")("not-an-object");
    expect(r.pass).toBe(false);
    expect(r.score).toBe(0);
  });

  it("passes with no required keys", () => {
    const r = fieldsPresent()({});
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
  });
});

describe("containsString", () => {
  it("passes when output JSON contains the needle", () => {
    const r = containsString("hello")({ msg: "hello world" });
    expect(r.pass).toBe(true);
  });

  it("respects ignoreCase option", () => {
    const r = containsString("HELLO", { ignoreCase: true })({ msg: "hello world" });
    expect(r.pass).toBe(true);
  });

  it("fails when needle absent", () => {
    const r = containsString("missing")({ msg: "hello world" });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("missing");
  });
});

describe("matchesSchema", () => {
  it("passes when all fields match their types", () => {
    const r = matchesSchema({ id: "string", count: "number", tags: "array" })({
      id: "abc",
      count: 42,
      tags: ["x"],
    });
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
  });

  it("fails and reports violations", () => {
    const r = matchesSchema({ id: "string", count: "number" })({
      id: 123,
      count: "not-a-number",
    });
    expect(r.pass).toBe(false);
    expect(r.score).toBe(0);
    expect(r.reason).toContain("id");
  });

  it("any type always passes", () => {
    const r = matchesSchema({ x: "any" })({ x: null });
    expect(r.pass).toBe(true);
  });
});

describe("allOf", () => {
  it("passes when all scorers pass", () => {
    const scorer = allOf(fieldsPresent("id"), containsString("abc"));
    const r = scorer({ id: "abc" });
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
  });

  it("fails and takes min score when any scorer fails", () => {
    const scorer = allOf(fieldsPresent("id", "missing"), containsString("id"));
    const r = scorer({ id: "abc" });
    expect(r.pass).toBe(false);
    expect(r.score).toBeLessThan(1);
  });
});

// ── EvalRunner ────────────────────────────────────────────────────────────────

describe("EvalRunner", () => {
  it("runs a passing eval case", async () => {
    const runner = new EvalRunner(echoAdapter);
    const result = await runner.run("echo suite", [
      {
        name: "echo returns input",
        task: { taskType: "echo", value: 42 },
        scorer: exactMatch({ taskType: "echo", value: 42 }),
      },
    ]);

    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.passRate).toBe(1);
    expect(result.results[0]?.pass).toBe(true);
    expect(result.results[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records adapter errors as failed with error field", async () => {
    const runner = new EvalRunner(throwingAdapter);
    const result = await runner.run("throw suite", [
      {
        name: "should catch error",
        task: { taskType: "whatever" },
        scorer: () => ({ pass: true, score: 1 }),
      },
    ]);

    expect(result.passed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.results[0]?.error).toContain("adapter failed");
  });

  it("runs multiple cases and aggregates pass rate", async () => {
    const runner = new EvalRunner(greetAdapter);
    const result = await runner.run("greeter suite", [
      {
        name: "greeting contains name",
        task: { taskType: "greet", name: "Alice" },
        scorer: containsString("Alice"),
      },
      {
        name: "response has greeting field",
        task: { taskType: "greet", name: "Bob" },
        scorer: fieldsPresent("greeting", "length"),
      },
      {
        name: "impossible: wrong name",
        task: { taskType: "greet", name: "Carol" },
        scorer: containsString("Dave"), // will fail
      },
    ]);

    expect(result.total).toBe(3);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.passRate).toBeCloseTo(2 / 3);
  });

  it("passThreshold gates score-based passing", async () => {
    const runner = new EvalRunner(greetAdapter);
    const result = await runner.run("threshold suite", [
      {
        name: "partial pass",
        task: { taskType: "greet", name: "X" },
        passThreshold: 0.5,
        scorer: () => ({ pass: true, score: 0.6 }), // above threshold
      },
      {
        name: "below threshold",
        task: { taskType: "greet", name: "Y" },
        passThreshold: 0.8,
        scorer: () => ({ pass: true, score: 0.5 }), // below threshold
      },
    ]);

    expect(result.results[0]?.pass).toBe(true);
    expect(result.results[1]?.pass).toBe(false);
  });

  it("returns passRate 1 for empty suite", async () => {
    const runner = new EvalRunner(echoAdapter);
    const result = await runner.run("empty", []);
    expect(result.passRate).toBe(1);
    expect(result.total).toBe(0);
  });
});

// ── EvalSuite ─────────────────────────────────────────────────────────────────

describe("EvalSuite", () => {
  it("registers cases and exposes them", () => {
    const suite = new EvalSuite("my suite");
    suite.add({
      name: "case 1",
      task: { taskType: "t" },
      scorer: exactMatch({}),
    });
    suite.addAll([
      { name: "case 2", task: { taskType: "t" }, scorer: exactMatch({}) },
      { name: "case 3", task: { taskType: "t" }, scorer: exactMatch({}) },
    ]);

    expect(suite.name).toBe("my suite");
    expect(suite.cases).toHaveLength(3);
    expect(suite.cases.map((c) => c.name)).toEqual(["case 1", "case 2", "case 3"]);
  });

  it("runs all cases via EvalRunner", async () => {
    const suite = new EvalSuite("runner integration");
    suite
      .add({ name: "pass 1", task: { taskType: "t", v: 1 }, scorer: fieldsPresent("taskType") })
      .add({ name: "pass 2", task: { taskType: "t", v: 2 }, scorer: fieldsPresent("taskType") });

    const runner = new EvalRunner(echoAdapter);
    const result = await runner.run(suite.name, suite.cases);

    expect(result.passRate).toBe(1);
    expect(result.total).toBe(2);
  });
});

// ── Logger stub coverage ───────────────────────────────────────────────────────

describe("EvalRunner context logger", () => {
  it("passes all four logger methods through to the adapter without error", async () => {
    // Exercises the info/warn/error/debug arrow stubs created by makeContext so
    // that v8 branch/function coverage includes them.
    let logCallCount = 0;
    const loggingAdapter: EvalAdapter = {
      name: "logger-probe",
      execute: async (task, ctx) => {
        ctx.logger.info("info probe");
        ctx.logger.warn("warn probe");
        ctx.logger.error("error probe");
        ctx.logger.debug("debug probe");
        logCallCount += 4;
        return task;
      },
    };
    const runner = new EvalRunner(loggingAdapter);
    const result = await runner.run("log suite", [
      { name: "log test", task: { taskType: "t" }, scorer: () => ({ pass: true, score: 1 }) },
    ]);
    expect(result.passed).toBe(1);
    expect(logCallCount).toBe(4);
  });

  it("makeContext forwards environment when provided via evalCase.context", async () => {
    let receivedEnv: Record<string, string> | undefined;
    const envAdapter: EvalAdapter = {
      name: "env-probe",
      execute: async (_task, ctx) => {
        receivedEnv = ctx.environment as Record<string, string>;
        return {};
      },
    };
    const runner = new EvalRunner(envAdapter);
    await runner.run("env suite", [
      {
        name: "env forwarding",
        task: { taskType: "t" },
        context: { environment: { MY_KEY: "my-value" } },
        scorer: () => ({ pass: true, score: 1 }),
      },
    ]);
    expect(receivedEnv?.["MY_KEY"]).toBe("my-value");
  });
});

// ── matchesSchema uncovered branches ──────────────────────────────────────────

describe("matchesSchema branch coverage", () => {
  it("fails when output is not an object", () => {
    const r = matchesSchema({ id: "string" })("not-an-object");
    expect(r.pass).toBe(false);
    expect(r.score).toBe(0);
    expect(r.reason).toContain("not an object");
  });

  it("reports missing field when key is absent in output", () => {
    const r = matchesSchema({ name: "string" })({});
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("missing");
  });

  it("reports violation when expected array but got non-array", () => {
    const r = matchesSchema({ tags: "array" })({ tags: "not-array" });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("expected array");
  });
});
