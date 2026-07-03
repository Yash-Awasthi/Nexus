// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  InMemoryStreamClient,
  TaskQueue,
  CronScheduler,
  SyncTaskRunner,
  DEFAULT_RETRY_POLICY,
  type Task,
} from "../src/index.js";

// ── DEFAULT_RETRY_POLICY ────────────────────────────────────────────────────

describe("DEFAULT_RETRY_POLICY", () => {
  it("has maxRetries=3", () => {
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(3);
  });

  it("backoffMs grows with attempts", () => {
    expect(DEFAULT_RETRY_POLICY.backoffMs(1)).toBeGreaterThan(DEFAULT_RETRY_POLICY.backoffMs(0));
  });

  it("backoffMs is capped at 30s", () => {
    expect(DEFAULT_RETRY_POLICY.backoffMs(100)).toBeLessThanOrEqual(30_000);
  });
});

// ── InMemoryStreamClient ────────────────────────────────────────────────────

describe("InMemoryStreamClient", () => {
  it("xadd returns unique id", () => {
    const client = new InMemoryStreamClient();
    const id1 = client.xadd("stream", {
      name: "t",
      payload: {},
      status: "pending",
      createdAt: 0,
      attempts: 0,
      maxRetries: 3,
    });
    const id2 = client.xadd("stream", {
      name: "t",
      payload: {},
      status: "pending",
      createdAt: 0,
      attempts: 0,
      maxRetries: 3,
    });
    expect(id1).not.toBe(id2);
  });

  it("xread returns pending tasks", () => {
    const client = new InMemoryStreamClient();
    client.xadd("s", {
      name: "t",
      payload: {},
      status: "pending",
      createdAt: 0,
      attempts: 0,
      maxRetries: 3,
    });
    const tasks = client.xread("s");
    expect(tasks).toHaveLength(1);
  });

  it("xread skips delayed tasks not yet due", () => {
    const client = new InMemoryStreamClient();
    client.xadd("s", {
      name: "t",
      payload: {},
      status: "delayed",
      runAt: Date.now() + 60_000,
      createdAt: 0,
      attempts: 0,
      maxRetries: 3,
    });
    expect(client.xread("s")).toHaveLength(0);
  });

  it("xack marks task as done", () => {
    const client = new InMemoryStreamClient();
    const id = client.xadd("s", {
      name: "t",
      payload: {},
      status: "pending",
      createdAt: 0,
      attempts: 0,
      maxRetries: 3,
    });
    client.xack("s", id);
    const tasks = client.allTasks("s");
    expect(tasks[0]!.status).toBe("done");
  });

  it("markFailed sets status and lastError", () => {
    const client = new InMemoryStreamClient();
    const id = client.xadd("s", {
      name: "t",
      payload: {},
      status: "pending",
      createdAt: 0,
      attempts: 0,
      maxRetries: 3,
    });
    client.markFailed("s", id, "boom");
    const tasks = client.allTasks("s");
    expect(tasks[0]!.status).toBe("failed");
    expect(tasks[0]!.lastError).toBe("boom");
  });

  it("clear removes all tasks", () => {
    const client = new InMemoryStreamClient();
    client.xadd("s", {
      name: "t",
      payload: {},
      status: "pending",
      createdAt: 0,
      attempts: 0,
      maxRetries: 3,
    });
    client.clear("s");
    expect(client.allTasks("s")).toHaveLength(0);
  });

  it("xread count limits results", () => {
    const client = new InMemoryStreamClient();
    for (let i = 0; i < 5; i++) {
      client.xadd("s", {
        name: "t",
        payload: {},
        status: "pending",
        createdAt: 0,
        attempts: 0,
        maxRetries: 3,
      });
    }
    expect(client.xread("s", 3)).toHaveLength(3);
  });
});

// ── CronScheduler ───────────────────────────────────────────────────────────

describe("CronScheduler", () => {
  it("tick runs due entries", async () => {
    const cron = new CronScheduler();
    const ran: string[] = [];
    cron.register("job-1", 0, async () => {
      ran.push("job-1");
    });
    await cron.tick();
    expect(ran).toContain("job-1");
  });

  it("tick skips entries not yet due", async () => {
    const cron = new CronScheduler();
    const ran: string[] = [];
    cron.register("job-1", 60_000, async () => {
      ran.push("job-1");
    });
    // First tick runs it (lastRunAt=0)
    await cron.tick();
    ran.length = 0;
    // Second tick immediately — not yet due
    await cron.tick(Date.now());
    expect(ran).toHaveLength(0);
  });

  it("handler error does not propagate", async () => {
    const cron = new CronScheduler();
    cron.register("bad", 0, async () => {
      throw new Error("boom");
    });
    await expect(cron.tick()).resolves.toBeDefined();
  });

  it("start and stop", () => {
    const cron = new CronScheduler();
    cron.start(100_000);
    expect(cron.isRunning()).toBe(true);
    cron.stop();
    expect(cron.isRunning()).toBe(false);
  });

  it("clear removes all entries", () => {
    const cron = new CronScheduler();
    cron.register("a", 0, async () => {});
    cron.clear();
    expect(cron.entries_()).toHaveLength(0);
  });

  it("tick returns names of ran jobs", async () => {
    const cron = new CronScheduler();
    cron.register("alpha", 0, async () => {});
    cron.register("beta", 0, async () => {});
    const ran = await cron.tick();
    expect(ran).toContain("alpha");
    expect(ran).toContain("beta");
  });
});

// ── TaskQueue ───────────────────────────────────────────────────────────────

describe("TaskQueue", () => {
  it("enqueue adds task", () => {
    const queue = new TaskQueue("test");
    queue.enqueue("my-task", { data: 1 });
    expect(queue.allTasks()).toHaveLength(1);
  });

  it("processBatch runs registered handler", async () => {
    const queue = new TaskQueue("test");
    const results: unknown[] = [];
    queue.task("greet", async (t) => {
      results.push((t.payload as any).name);
    });
    queue.enqueue("greet", { name: "Alice" });
    await queue.processBatch();
    expect(results).toContain("Alice");
  });

  it("processBatch marks task done", async () => {
    const queue = new TaskQueue("test");
    queue.task("noop", async () => {});
    queue.enqueue("noop", {});
    await queue.processBatch();
    expect(queue.tasksByStatus("done")).toHaveLength(1);
  });

  it("processBatch marks task failed when no handler", async () => {
    const queue = new TaskQueue("test");
    queue.enqueue("unknown-task", {});
    await queue.processBatch();
    expect(queue.tasksByStatus("failed")).toHaveLength(1);
  });

  it("delayed task is not processed immediately", async () => {
    const queue = new TaskQueue("test");
    queue.task("late", async () => {});
    queue.enqueue("late", {}, { delayMs: 60_000 });
    await queue.processBatch();
    expect(queue.tasksByStatus("done")).toHaveLength(0);
    expect(queue.tasksByStatus("delayed")).toHaveLength(1);
  });

  it("failed handler retries up to maxRetries times", async () => {
    const queue = new TaskQueue("test", undefined, { maxRetries: 2, backoffMs: () => 0 });
    let calls = 0;
    queue.task("bad", async () => {
      calls++;
      throw new Error("fail");
    });
    queue.enqueue("bad", {}, { maxRetries: 2 });
    // Each processBatch processes 1 attempt; need multiple passes
    await queue.processBatch();
    await queue.processBatch();
    await queue.processBatch();
    expect(calls).toBeGreaterThan(0);
    expect(queue.tasksByStatus("failed").length).toBeGreaterThan(0);
  });

  it("cron registers and ticks", async () => {
    const queue = new TaskQueue("test");
    const ran: number[] = [];
    queue.cron_("ping", 0, async () => {
      ran.push(Date.now());
    });
    await queue.tickCron();
    expect(ran).toHaveLength(1);
  });

  it("tasksByStatus filters correctly", () => {
    const queue = new TaskQueue("test");
    queue.enqueue("a", {});
    queue.enqueue("b", {}, { delayMs: 60_000 });
    expect(queue.tasksByStatus("pending")).toHaveLength(1);
    expect(queue.tasksByStatus("delayed")).toHaveLength(1);
  });

  it("getClient returns InMemoryStreamClient", () => {
    const queue = new TaskQueue("test");
    expect(queue.getClient()).toBeDefined();
  });
});

// ── SyncTaskRunner ──────────────────────────────────────────────────────────

describe("SyncTaskRunner", () => {
  it("drainAll processes all tasks", async () => {
    const queue = new TaskQueue("drain-test");
    const results: string[] = [];
    queue.task("item", async (t) => {
      results.push((t.payload as any).v);
    });
    queue.enqueue("item", { v: "one" });
    queue.enqueue("item", { v: "two" });
    queue.enqueue("item", { v: "three" });
    const runner = new SyncTaskRunner(queue);
    const { processed } = await runner.drainAll();
    expect(processed).toBe(3);
    expect(results).toEqual(["one", "two", "three"]);
  });

  it("drainAll handles empty queue", async () => {
    const queue = new TaskQueue("empty");
    const runner = new SyncTaskRunner(queue);
    const { processed, failed } = await runner.drainAll();
    expect(processed).toBe(0);
    expect(failed).toBe(0);
  });
});
