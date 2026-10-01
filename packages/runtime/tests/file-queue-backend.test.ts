// SPDX-License-Identifier: Apache-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { QueueJob } from "../src/interfaces/queue.interface.js";
import { MetricsCollector } from "../src/observability-manager.js";
import { FileQueueBackend } from "../src/file-queue-backend.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fq-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function job(id: string, overrides: Partial<QueueJob> = {}): QueueJob {
  return {
    id,
    payload: { task: id },
    priority: "medium",
    retries: 0,
    maxRetries: 3,
    createdAt: new Date(2026, 0, 1, 0, 0, Number(id.slice(1)) || 1),
    ...overrides,
  };
}

describe("FileQueueBackend", () => {
  it("init creates the data directory and starts empty", async () => {
    const nested = path.join(dir, "a", "b");
    const backend = new FileQueueBackend(nested);
    expect(await backend.getQueueLength()).toBe(0);
    await backend.init();
    expect(fs.existsSync(path.join(nested, "queue.jsonl"))).toBe(false); // no writes yet
  });

  it("pushes jobs and pops in priority-then-FIFO order", async () => {
    const backend = new FileQueueBackend(dir);
    await backend.push(job("j1", { priority: "low", createdAt: new Date(2026, 0, 1) }));
    await backend.push(job("j2", { priority: "high", createdAt: new Date(2026, 0, 2) }));
    await backend.push(job("j3", { priority: "medium", createdAt: new Date(2026, 0, 3) }));
    await backend.push(job("j4", { priority: "high", createdAt: new Date(2026, 0, 4) }));

    expect(await backend.getQueueLength()).toBe(4);
    expect((await backend.pop())?.id).toBe("j2"); // high, earlier
    expect((await backend.pop())?.id).toBe("j4"); // high, later
    expect((await backend.pop())?.id).toBe("j3"); // medium
    expect((await backend.pop())?.id).toBe("j1"); // low
    expect(await backend.pop()).toBeUndefined();
  });

  it("persists jobs across restarts and revives dates", async () => {
    const b1 = new FileQueueBackend(dir);
    await b1.push(job("j1", { priority: "low" }));
    await b1.push(job("j2"));

    const b2 = new FileQueueBackend(dir);
    await b2.init();
    const popped = await b2.pop();
    expect(popped?.id).toBe("j2");
    expect(popped?.createdAt).toBeInstanceOf(Date);
    expect((await b2.getActiveJobs()).map((j) => j.id)).toEqual(["j1"]);
  });

  it("routes exhausted jobs to the dead-letter queue", async () => {
    const backend = new FileQueueBackend(dir);
    await backend.push(job("retry", { retries: 3, maxRetries: 3 }));
    expect(await backend.getQueueLength()).toBe(0);
    const dlq = await backend.getDeadLetterQueue();
    expect(dlq).toHaveLength(1);
    expect(dlq[0].id).toBe("retry");
  });

  it("clearDeadLetterQueue and clear() wipe state", async () => {
    const backend = new FileQueueBackend(dir);
    await backend.push(job("a1"));
    await backend.moveToDeadLetter(job("dl", { retries: 3, maxRetries: 3 }), "boom");
    await backend.clearDeadLetterQueue();
    expect(await backend.getDeadLetterQueue()).toHaveLength(0);
    await backend.push(job("a2"));
    await backend.clear(true);
    expect(await backend.getQueueLength()).toBe(0);
    expect(await backend.getDeadLetterQueue()).toHaveLength(0);
  });

  it("moveToDeadLetter removes the job from the active queue", async () => {
    const backend = new FileQueueBackend(dir);
    await backend.push(job("x1"));
    await backend.moveToDeadLetter(job("x1"), "manual");
    expect(await backend.getQueueLength()).toBe(0);
    expect(await backend.getDeadLetterQueue()).toHaveLength(1);
  });

  it("tolerates corrupted lines and reloads external edits", async () => {
    const backend = new FileQueueBackend(dir);
    await backend.push(job("good1"));
    fs.writeFileSync(
      path.join(dir, "queue.jsonl"),
      '{"id":"good1","payload":{}}\nnot-json\n{"id":"good2","payload":{},"createdAt":"2026-01-01T00:00:00.000Z"}\n',
      "utf8",
    );
    await backend.reload();
    const jobs = await backend.getActiveJobs();
    expect(jobs.map((j) => j.id)).toEqual(["good1", "good2"]);
    expect(jobs[1].createdAt).toBeInstanceOf(Date);
  });

  it("reports queue metrics when a collector is attached", async () => {
    const metrics = new MetricsCollector();
    const backend = new FileQueueBackend(dir, metrics);
    await backend.push(job("m1"));
    await backend.pop();
    await backend.moveToDeadLetter(job("m2", { retries: 3, maxRetries: 3 }), "e");
    const gauges = metrics.getMetrics().gauges as Record<string, { value: number }>;
    const counters = metrics.getMetrics().counters as Record<string, { value: number }>;
    expect(gauges["queue.active_length"]).toBeDefined();
    expect(counters["queue.push_total"].value).toBe(1);
    expect(counters["queue.pop_total"].value).toBe(1);
    expect(counters["queue.dlq_total"].value).toBe(1);
  });
});
