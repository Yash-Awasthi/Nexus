// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { MemoryQueueBackend } from "../src/queue-backend.js";
import type { QueueJob } from "../src/interfaces/queue.interface.js";

function job(id: string, priority: QueueJob["priority"], createdAt: Date, retries = 0, maxRetries = 3): QueueJob {
  return { id, payload: { type: "floci" }, priority, retries, maxRetries, createdAt };
}

describe("MemoryQueueBackend", () => {
  it("pops in priority order (high → medium → low), FIFO within a priority", async () => {
    const q = new MemoryQueueBackend();
    const t0 = new Date();
    await q.push(job("low-1", "low", new Date(t0.getTime() + 1)));
    await q.push(job("low-2", "low", new Date(t0.getTime() + 2)));
    await q.push(job("high-1", "high", new Date(t0.getTime() + 3)));
    await q.push(job("medium-1", "medium", new Date(t0.getTime() + 4)));
    await q.push(job("high-2", "high", new Date(t0.getTime() + 5)));

    const order: string[] = [];
    let j: QueueJob | undefined;
    while ((j = await q.pop())) order.push(j.id);
    expect(order).toEqual(["high-1", "high-2", "medium-1", "low-1", "low-2"]);
  });

  it("returns undefined on an empty queue and reports the active length", async () => {
    const q = new MemoryQueueBackend();
    expect(await q.pop()).toBeUndefined();
    expect(await q.getQueueLength()).toBe(0);
    await q.push(job("a", "medium", new Date()));
    expect(await q.getQueueLength()).toBe(1);
  });

  it("routes a job whose retries are exhausted straight to the dead-letter queue", async () => {
    const q = new MemoryQueueBackend();
    await q.push(job("exhausted", "high", new Date(), 3, 3));
    expect(await q.getQueueLength()).toBe(0);
    expect((await q.getDeadLetterQueue()).map((j) => j.id)).toEqual(["exhausted"]);
  });

  it("moveToDeadLetter removes the job from the active queue", async () => {
    const q = new MemoryQueueBackend();
    const j = job("doomed", "medium", new Date());
    await q.push(j);
    await q.moveToDeadLetter(j, "bad payload");
    expect(await q.getQueueLength()).toBe(0);
    expect((await q.getDeadLetterQueue()).map((x) => x.id)).toEqual(["doomed"]);
  });

  it("clearDeadLetterQueue empties the DLQ", async () => {
    const q = new MemoryQueueBackend();
    await q.push(job("dlq-1", "low", new Date(), 1, 1));
    expect(await q.clearDeadLetterQueue());
    expect(await q.getDeadLetterQueue()).toEqual([]);
  });

  it("getActiveJobs returns a copy — mutating it does not affect the queue", async () => {
    const q = new MemoryQueueBackend();
    await q.push(job("a", "medium", new Date()));
    const snapshot = await q.getActiveJobs();
    snapshot.length = 0;
    expect(await q.getQueueLength()).toBe(1);
  });
});