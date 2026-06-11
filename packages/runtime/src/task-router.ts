// SPDX-License-Identifier: Apache-2.0
import type { IEventBus } from "./event-bus.js";
import type { IEventStore } from "./interfaces/persistence.interface.js";

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  dependencies: string[];
  /** Explicit adapter routing (from workflow spec files). */
  type?: string;
  action?: string;
  arguments?: Record<string, unknown>;
}

export class TaskRouter {
  private bus: IEventBus;
  private eventStore?: IEventStore;
  private queue: Task[] = [];

  constructor(bus: IEventBus, eventStore?: IEventStore) {
    this.bus = bus;
    this.eventStore = eventStore;
  }

  async route(task: Task): Promise<Task> {
    task.status = "routed";
    this.queue.push(task);

    if (this.eventStore) {
      await this.eventStore.saveEvent("task_routed", task);
    }

    await this.bus.publish("task_routed", task);
    return task;
  }

  async replayEvent(eventRecord: { event: string; payload: any }): Promise<void> {
    const { event, payload } = eventRecord;
    if (event === "task_routed") {
      const task = payload as Task;
      if (!this.queue.some((t) => t.id === task.id)) {
        this.queue.push(task);
      }
    } else if (event === "task_completed") {
      const task = payload as { id: string };
      this.queue = this.queue.filter((t) => t.id !== task.id);
    }
  }

  getQueue(): Task[] {
    return this.queue;
  }
}
