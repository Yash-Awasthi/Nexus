// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { QueueJob } from "../src/interfaces/queue.interface.js";
import { RedisQueueBackend } from "../src/redis-queue-backend.js";

// ─── Fake BullMQ Queue ───────────────────────────────────────────────────────

interface FakeJob {
  id: string;
  data: Record<string, unknown>;
  state: "waiting" | "active";
  remove: ReturnType<typeof vi.fn>;
}

const fakeState = vi.hoisted(() => ({
  instances: [] as {
    name: string;
    jobs: FakeJob[];
    add: ReturnType<typeof vi.fn>;
    drain: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[],
}));

vi.mock("bullmq", () => {
  class FakeQueue {
    name: string;
    jobs: FakeJob[] = [];
    add = vi.fn(async (name: string, data: unknown, opts: { jobId?: string }) => {
      const job: FakeJob = {
        id: opts?.jobId ?? name,
        data: data as Record<string, unknown>,
        state: "waiting",
        remove: vi.fn(async () => {
          this.jobs = this.jobs.filter((j) => j.id !== job.id);
        }),
      };
      this.jobs.push(job);
    });
    drain = vi.fn(async () => {
      this.jobs = [];
    });
    close = vi.fn(async () => {});
    constructor(name: string) {
      this.name = name;
      fakeState.instances.push(this);
    }
    async getJobs(states: string[]) {
      return this.jobs.filter((j) => states.includes(j.state));
    }
    async getJob(id: string) {
      return this.jobs.find((j) => j.id === id) ?? null;
    }
    async count() {
      return this.jobs.filter((j) => j.state === "waiting").length;
    }
  }
  return { Queue: FakeQueue };
});

function job(id: string, overrides: Partial<QueueJob> = {}): QueueJob {
  return {
    id,
    payload: { task: id },
    priority: "medium",
    retries: 0,
    maxRetries: 3,
    createdAt: new Date(2026, 0, 1),
    ...overrides,
  };
}

beforeEach(() => {
  fakeState.instances = [];
});

function byName(name: string) {
  const inst = fakeState.instances.find((i) => i.name === name);
  if (!inst) throw new Error(`no fake queue named ${name}`);
  return inst;
}

describe("RedisQueueBackend", () => {
  it("creates four BullMQ queues (high/medium/low/dlq) sharing the connection", () => {
    const backend = new RedisQueueBackend({ connection: { host: "localhost", port: 6379 } });
    expect(fakeState.instances.map((i) => i.name).sort()).toEqual([
      "nexus-dlq",
      "nexus-high",
      "nexus-low",
      "nexus-medium",
    ]);
    void backend;
  });

  it("pushes to the correct priority queue with inverted numeric priority", async () => {
    const backend = new RedisQueueBackend({ connection: {} });
    await backend.push(job("a1", { priority: "high" }));
    await backend.push(job("b1", { priority: "low" }));

    const highAdd = byName("nexus-high").add;
    const lowAdd = byName("nexus-low").add;
    expect(highAdd).toHaveBeenCalledTimes(1);
    expect(lowAdd).toHaveBeenCalledTimes(1);
    const [, , optsH] = highAdd.mock.calls[0];
    const [, , optsL] = lowAdd.mock.calls[0];
    expect(optsH.priority).toBe(1);
    expect(optsL.priority).toBe(3);
    expect(optsH.jobId).toBe("a1");
  });

  it("moves an exhausted job to the DLQ on push", async () => {
    const backend = new RedisQueueBackend({ connection: {} });
    await backend.push(job("dead", { priority: "high", retries: 3, maxRetries: 3 }));
    expect(byName("nexus-high").add).not.toHaveBeenCalled();
    expect(byName("nexus-dlq").add).toHaveBeenCalledTimes(1);
    const [name, data] = byName("nexus-dlq").add.mock.calls[0];
    expect(name).toBe("dead");
    expect(data.dlqError).toBe("Retry attempts exhausted before enqueue");
  });

  it("pops from priority order and removes the job", async () => {
    const backend = new RedisQueueBackend({ connection: {} });
    await backend.push(job("h1", { priority: "high" }));
    await backend.push(job("m1"));
    await backend.push(job("l1", { priority: "low" }));

    const popped = await backend.pop();
    expect(popped?.id).toBe("h1");
    expect(popped?.priority).toBe("high");
    expect(popped?.createdAt).toBeInstanceOf(Date);
    // high queue now empty → next pop goes medium
    const next = await backend.pop();
    expect(next?.id).toBe("m1");
    const last = await backend.pop();
    expect(last?.id).toBe("l1");
    expect(await backend.pop()).toBeUndefined();
  });

  it("moveToDeadLetter removes from source queue when present", async () => {
    const backend = new RedisQueueBackend({ connection: {} });
    await backend.push(job("rm", { priority: "low" }));
    await backend.moveToDeadLetter(job("rm", { priority: "low" }), "manual dlq");
    const source = byName("nexus-low");
    expect(source.jobs).toHaveLength(0);
    expect(byName("nexus-dlq").jobs).toHaveLength(1);
  });

  it("lists the DLQ, clears it, and sums queue length", async () => {
    const backend = new RedisQueueBackend({ connection: {} });
    await backend.moveToDeadLetter(job("d1"), "e1");
    await backend.moveToDeadLetter(job("d2"), "e2");
    const dlq = await backend.getDeadLetterQueue();
    expect(dlq.map((j) => j.id)).toEqual(["d1", "d2"]);
    expect(await backend.getQueueLength()).toBe(0);
    await backend.push(job("q1"));
    expect(await backend.getQueueLength()).toBe(1);
    await backend.clearDeadLetterQueue();
    expect(await backend.getDeadLetterQueue()).toEqual([]);
  });

  it("returns active jobs across priority queues", async () => {
    const backend = new RedisQueueBackend({ connection: {} });
    // simulate an in-flight job
    const active = {
      data: {
        nexusJobId: "running",
        payload: { x: 1 },
        priority: "high",
        retries: 1,
        maxRetries: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      state: "active",
    };
    byName("nexus-high").jobs.push(active as never);
    const jobs = await backend.getActiveJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe("running");
    expect(jobs[0].priority).toBe("high");
  });

  it("closes all queue connections", async () => {
    const backend = new RedisQueueBackend({ connection: {} });
    await backend.close();
    for (const inst of fakeState.instances) {
      expect(inst.close).toHaveBeenCalledOnce();
    }
  });

  it("fromUrl parses redis URLs into connection options", () => {
    const backend = RedisQueueBackend.fromUrl("rediss://:secret@cache.example.com:6380/2");
    const conn = (backend as unknown as { connection: Record<string, unknown> }).connection;
    expect(conn.host).toBe("cache.example.com");
    expect(conn.port).toBe(6380);
    expect(conn.password).toBe("secret");
    expect(conn.db).toBe(2);
    expect(conn.tls).toEqual({});
    const plain = RedisQueueBackend.fromUrl("redis://localhost");
    const pconn = (plain as unknown as { connection: Record<string, unknown> }).connection;
    expect(pconn.port).toBe(6379);
    expect(pconn.tls).toBeUndefined();
    expect(pconn.db).toBe(0);
  });
});
