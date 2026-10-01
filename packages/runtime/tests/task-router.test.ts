// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

import { TaskRouter, type Task } from "../src/task-router.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    title: "Test task",
    description: "A test task",
    priority: "medium",
    status: "pending",
    dependencies: [],
    ...overrides,
  };
}

describe("TaskRouter", () => {
  let mockBus: { publish: ReturnType<typeof vi.fn> };
  let mockEventStore: { saveEvent: ReturnType<typeof vi.fn> };
  let router: TaskRouter;

  beforeEach(() => {
    mockBus = { publish: vi.fn().mockResolvedValue(undefined) };
    mockEventStore = { saveEvent: vi.fn().mockResolvedValue(undefined) };
    router = new TaskRouter(mockBus as never, mockEventStore as never);
  });

  describe("route()", () => {
    it("sets task status to 'routed'", async () => {
      const task = makeTask({ status: "pending" });
      const routed = await router.route(task);
      expect(routed.status).toBe("routed");
    });

    it("adds the task to the internal queue", async () => {
      const task = makeTask();
      await router.route(task);
      expect(router.getQueue()).toHaveLength(1);
      expect(router.getQueue()[0]?.id).toBe(task.id);
    });

    it("publishes 'task_routed' event to the bus", async () => {
      const task = makeTask();
      await router.route(task);
      expect(mockBus.publish).toHaveBeenCalledWith(
        "task_routed",
        expect.objectContaining({ id: task.id }),
      );
    });

    it("saves the event to the event store when provided", async () => {
      const task = makeTask();
      await router.route(task);
      expect(mockEventStore.saveEvent).toHaveBeenCalledWith(
        "task_routed",
        expect.objectContaining({ id: task.id }),
      );
    });

    it("works without an event store", async () => {
      const routerNoStore = new TaskRouter(mockBus as never);
      const task = makeTask();
      await routerNoStore.route(task);
      expect(routerNoStore.getQueue()).toHaveLength(1);
    });

    it("accumulates multiple tasks", async () => {
      await router.route(makeTask({ id: "a" }));
      await router.route(makeTask({ id: "b" }));
      await router.route(makeTask({ id: "c" }));
      expect(router.getQueue()).toHaveLength(3);
    });
  });

  describe("replayEvent()", () => {
    it("re-adds a task_routed event if not already in queue", async () => {
      const task = makeTask({ id: "replay-task", status: "routed" });
      await router.replayEvent({ event: "task_routed", payload: task });
      expect(router.getQueue()).toHaveLength(1);
    });

    it("does not add duplicate tasks on replay", async () => {
      const task = makeTask({ id: "dup-task", status: "routed" });
      // Route normally first
      await router.route(task);
      // Replay the same task — should be deduped
      await router.replayEvent({ event: "task_routed", payload: task });
      expect(router.getQueue()).toHaveLength(1);
    });

    it("removes a task from the queue on task_completed replay", async () => {
      const task = makeTask({ id: "done-task" });
      await router.route(task);
      expect(router.getQueue()).toHaveLength(1);

      await router.replayEvent({ event: "task_completed", payload: { id: "done-task" } });
      expect(router.getQueue()).toHaveLength(0);
    });

    it("ignores unknown event types gracefully", async () => {
      await router.replayEvent({ event: "unknown_event", payload: {} });
      expect(router.getQueue()).toHaveLength(0);
    });
  });

  describe("getQueue()", () => {
    it("returns an empty array initially", () => {
      expect(router.getQueue()).toEqual([]);
    });

    it("reflects the current queue state", async () => {
      const t1 = makeTask({ id: "t1" });
      const t2 = makeTask({ id: "t2" });
      await router.route(t1);
      await router.route(t2);
      const queue = router.getQueue();
      expect(queue.map((t) => t.id)).toEqual(["t1", "t2"]);
    });
  });
});
