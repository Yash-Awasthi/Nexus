import type { Task } from "./task-router.js";

export interface QueueJobPayload {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Maps a workflow task to the queue executor shape.
 *
 * Routing priority:
 *   1. Explicit type + action on the task (set by planner or direct callers) — used as-is.
 *   2. Explicit type only — payload falls back to task arguments.
 *   3. No type — legacy keyword matching on description for backward-compat tests.
 */
export function buildQueuePayloadFromTask(task: Task): QueueJobPayload {
  if (task.type && task.action) {
    return {
      type: task.type,
      payload: {
        action: task.action,
        ...(task.arguments ?? {})
      }
    };
  }

  // If type is set but action isn't, pass through with raw arguments
  if (task.type) {
    return {
      type: task.type,
      payload: { ...(task.arguments ?? {}) }
    };
  }

  // Legacy description-based routing (backward compat for tests and old templates)
  let payloadType = "floci";
  let payloadPayload: Record<string, unknown> = {};

  if (task.description.includes("browser")) {
    payloadType = "browser";
    payloadPayload = {
      url: task.description.includes("illegal") ? "file:///etc/passwd" : "https://github.com",
      actions: [{ type: "navigate", value: "https://news.ycombinator.com" }],
      timeoutMs: 5000
    };
  } else if (task.description.includes("scraping")) {
    payloadType = "scraping";
    payloadPayload = {
      url: "https://github.com",
      selectors: [".repo-title"],
      maxRequests: 3
    };
  } else if (task.description.includes("search")) {
    payloadType = "search";
    payloadPayload = { query: task.description, mode: "balanced" };
  } else if (task.description.includes("code")) {
    payloadType = "code";
    payloadPayload = { objective: task.description };
  } else if (task.description.includes("inference")) {
    payloadType = "inference";
    payloadPayload = { prompt: task.description };
  } else {
    payloadPayload = task.description.includes("bucket")
      ? { action: "create_s3_bucket", bucketName: task.id }
      : task.description.includes("queue")
        ? { action: "create_sqs_queue", queueName: task.id }
        : { action: "create_dynamodb_table", tableName: task.id };
  }

  return { type: payloadType, payload: payloadPayload };
}
