// SPDX-License-Identifier: Apache-2.0
/** A browser task reaches the queue under an id BullMQ accepts, so the worker gets it. */
import { expect, it, vi } from "vitest";

const added = vi.hoisted(() => [] as { name: string; opts: { jobId?: string } }[]);
vi.mock("bullmq", () => ({
  Queue: class {
    async add(name: string, _data: unknown, opts: { jobId?: string }) {
      // BullMQ's own rule: a custom id may hold a colon only in its repeat-job form.
      if (opts.jobId?.includes(":") && opts.jobId.split(":").length !== 3)
        throw new Error("Custom Id cannot contain :");
      added.push({ name, opts });
      return { id: opts.jobId };
    }
  },
}));
process.env.REDIS_URL = "redis://127.0.0.1:6379";

const { launchBrowserTask } = await import("../../src/lib/agent-queue.js");

it("queues a browser task rather than falling back to this process", async () => {
  expect(await launchBrowserTask("session-1")).toBe(true);
  expect(added).toEqual([
    expect.objectContaining({
      name: "browser.task",
      opts: expect.objectContaining({ jobId: expect.stringContaining("session-1") }),
    }),
  ]);
});
