// SPDX-License-Identifier: Apache-2.0
// Durable-workflow activities + signals (pass 75, row 218 temporal): a named
// activity registry with per-activity Temporal-style retry policy, and signal
// delivery that wakes a waiting workflow or buffers pre-wait signals until the
// workflow waits on that name. Fast backoff intervals keep the retry tests
// sub-second; everything is in-process and offline.
import { describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";

import {
  ActivityNotFoundError,
  DurableRuntime,
  type ActivityDefinition,
} from "./durable.js";

describe("DurableRuntime activities", () => {
  it("runs a registered activity by name and returns its output", async () => {
    const runtime = new DurableRuntime();
    runtime.registerActivity({
      name: "charge-card",
      run: (input: { amount: number }) => `charged ${input.amount}`,
    });
    const out = await runtime.runActivity("charge-card", { amount: 42 });
    expect(out).toBe("charged 42");
  });

  it("rejects unknown activity names with ActivityNotFoundError", async () => {
    const runtime = new DurableRuntime();
    await expect(runtime.runActivity("nope", {})).rejects.toBeInstanceOf(
      ActivityNotFoundError,
    );
  });

  it("retries a failing activity per its policy and succeeds once it stabilizes", async () => {
    const runtime = new DurableRuntime();
    let attempts = 0;
    runtime.registerActivity({
      name: "flaky",
      run: async () => {
        attempts++;
        if (attempts < 3) throw new Error("transient");
        return `ok-after-${attempts}`;
      },
      retry: { initialIntervalMs: 1, backoffCoefficient: 1, maximumAttempts: 5 },
    });
    const out = await runtime.runActivity("flaky", null);
    expect(out).toBe("ok-after-3");
    expect(attempts).toBe(3);
  });

  it("exhausts maximumAttempts and rejects with the last error", async () => {
    const runtime = new DurableRuntime();
    let attempts = 0;
    runtime.registerActivity({
      name: "doomed",
      run: async () => {
        attempts++;
        throw new Error(`boom-${attempts}`);
      },
      retry: { initialIntervalMs: 1, backoffCoefficient: 1, maximumAttempts: 2 },
    });
    await expect(runtime.runActivity("doomed", null)).rejects.toThrow("boom-2");
    expect(attempts).toBe(2);
  });
});

describe("DurableRuntime signals", () => {
  it("completes a workflow that waits for a signal once it is delivered", async () => {
    const runtime = new DurableRuntime();
    const run = runtime.start<{ approved: boolean }>("w1", async (ctx) => {
      const verdict = await ctx.waitForSignal<{ approved: boolean }>("approve");
      return verdict;
    });
    // Not yet signaled → still pending.
    const pending = await Promise.race([
      run.then(() => "done" as const),
      sleep(10).then(() => "pending" as const),
    ]);
    expect(pending).toBe("pending");

    expect(runtime.signal("w1", "approve", { approved: true })).toBe(true);
    await expect(run).resolves.toEqual({ approved: true });
  });

  it("buffers signals sent before the workflow waits (send-before-handle guarantee)", async () => {
    const runtime = new DurableRuntime();
    const order: string[] = [];
    const run = runtime.start<{ step: number }>("w2", async (ctx) => {
      order.push("start");
      await ctx.sleep(15); // body is busy — not waiting yet
      order.push("waiting");
      const s1 = await ctx.waitForSignal<{ step: number }>("go");
      order.push("got");
      const s2 = await ctx.waitForSignal<{ step: number }>("go");
      order.push("got2");
      return { step: s1.step + s2.step };
    });
    // Delivered while the body sleeps (before either wait) — must not be lost.
    expect(runtime.signal("w2", "go", { step: 1 })).toBe(true);
    expect(runtime.signal("w2", "go", { step: 2 })).toBe(true);
    await expect(run).resolves.toEqual({ step: 3 });
    expect(order).toEqual(["start", "waiting", "got", "got2"]);
  });

  it("delivers a signal to the right workflow only (instances are isolated)", async () => {
    const runtime = new DurableRuntime();
    const a = runtime.start("a", async (ctx) => ctx.waitForSignal<string>("ping"));
    const b = runtime.start("b", async (ctx) => ctx.waitForSignal<string>("ping"));
    expect(runtime.signal("a", "ping", "for-a")).toBe(true);
    await expect(a).resolves.toBe("for-a");
    expect(runtime.signal("b", "ping", "for-b")).toBe(true);
    await expect(b).resolves.toBe("for-b");
  });

  it("rejects for unknown workflows and times out a bounded wait", async () => {
    const runtime = new DurableRuntime();
    expect(runtime.signal("ghost", "ping", 1)).toBe(false);

    const run = runtime.start("w3", async (ctx) =>
      ctx.waitForSignal("never", { timeoutMs: 5 }),
    );
    await expect(run).rejects.toThrow(/timed out after 5ms: never/);
  });
});

describe("DurableRuntime workflows compose activities + signals", () => {
  it("a workflow calls an activity and then waits on a signal for the result path", async () => {
    const runtime = new DurableRuntime();
    const echo: ActivityDefinition<{ text: string }, string> = {
      name: "echo",
      run: (input) => `echo:${input.text}`,
    };
    runtime.registerActivity(echo);
    const run = runtime.start("w4", async (ctx) => {
      const echoed = await ctx.runActivity("echo", { text: "hello" });
      const gate = await ctx.waitForSignal<string>("release");
      return `${echoed}|${gate}`;
    });
    expect(runtime.signal("w4", "release", "open")).toBe(true);
    await expect(run).resolves.toBe("echo:hello|open");
  });
});
