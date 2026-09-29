// SPDX-License-Identifier: Apache-2.0
/**
 * agent-queue — API-side BullMQ producer for launching agent runs.
 *
 * Enqueues an `agent.run` job onto the high-priority queue the worker drains.
 * The returned `sessionId` is what clients stream on via `/sse/agent/:sessionId`
 * (the worker scopes its events to it). Lazily loads bullmq via dynamic import
 * and is a no-op without `REDIS_URL`, so the API never hard-fails on a missing
 * queue in single-process/local setups.
 */
import { randomUUID } from "node:crypto";

import type { PresetName } from "@nexus/agent-runtime";
import type { LlmDriver } from "@nexus/llm-drivers";

const QUEUE_HIGH = "nexus-high";
const QUEUE_MEDIUM = "nexus-medium";

type QueueLike = {
  add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<{ id?: string }>;
};

/** Parse a redis:// URL into BullMQ ConnectionOptions (mirrors the worker). */
function parseRedisUrl(url: string): {
  host: string;
  port: number;
  password?: string;
  db?: number;
} {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: parseInt(u.port || "6379", 10),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.pathname && u.pathname !== "/" ? { db: parseInt(u.pathname.slice(1), 10) } : {}),
  };
}

const _queues = new Map<string, QueueLike>();

async function getQueue(name = QUEUE_HIGH): Promise<QueueLike | null> {
  const open = _queues.get(name);
  if (open) return open;
  if (!process.env.REDIS_URL) return null;
  try {
    const { Queue } = await import("bullmq");
    const queue = new Queue(name, {
      connection: parseRedisUrl(process.env.REDIS_URL),
    }) as unknown as QueueLike;
    _queues.set(name, queue);
    return queue;
  } catch {
    return null;
  }
}

/** Add a job to the priority's queue. False when no queue is configured. */
export async function enqueueJob(
  name: string,
  data: Record<string, unknown>,
  priority: "low" | "medium" | "high",
): Promise<boolean> {
  const queue = await getQueue(`nexus-${priority}`);
  if (!queue) return false;
  await queue.add(name, data, { removeOnComplete: true, removeOnFail: 100 });
  return true;
}

/** Fields accepted when launching an agent run (subset of the worker payload). */
export interface LaunchAgentInput {
  instruction: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
  maxSteps?: number;
  /** Directory the coding tools work in. */
  workspaceDir?: string;
  /** Per-command limit for the agent's shell tool. */
  commandTimeoutMs?: number;
  /** Leave out the council/debate tools and the batch-script tool. */
  disableCouncilTools?: boolean;
  disablePtc?: boolean;
  /** Run inside an isolated git-worktree workspace (Phase 3). */
  worktree?: Record<string, unknown>;
  /** Resume an existing session instead of starting a new one. */
  sessionId?: string;
  userId?: string;
  /**
   * Compress tool-result text before it re-enters context. `"lossless"` (default)
   * or `"off"`/`false` to disable. Usually set from the `x-nexus-compress` header.
   */
  compressToolOutput?: PresetName | false;
}

/**
 * Map an `x-nexus-compress` header value to a `compressToolOutput` setting.
 * `off`/`false`/`0`/`none`/`no` → false (disable); `lossless`/`on`/`true`/`1`/`yes`
 * → "lossless"; anything else (incl. absent/array) → undefined (keep the runtime
 * default, currently lossless). Never throws.
 */
export function parseCompressHeader(
  value: string | string[] | undefined,
): PresetName | false | undefined {
  const v = (Array.isArray(value) ? value[0] : value)?.trim().toLowerCase();
  if (!v) return undefined;
  if (["off", "false", "0", "none", "no"].includes(v)) return false;
  if (["lossless", "on", "true", "1", "yes"].includes(v)) return "lossless";
  return undefined;
}

/**
 * Build the `agent.run` job payload from launch input. The same id is used as
 * sessionId and taskId so the SSE stream, session persistence, and worktree
 * name all key off one value. Pure — exported for tests.
 */
export function buildAgentRunJob(
  input: LaunchAgentInput,
  sessionId: string,
): Record<string, unknown> {
  return { ...input, sessionId, taskId: sessionId };
}

/** Enqueue an agent.run job. Returns null when no queue is configured. */
export async function launchAgentRun(
  input: LaunchAgentInput,
): Promise<{ sessionId: string; jobId?: string } | null> {
  const queue = await getQueue();
  if (!queue) return null;
  const sessionId = input.sessionId ?? randomUUID();
  const job = await queue.add("agent.run", buildAgentRunJob(input, sessionId), {
    removeOnComplete: true,
    removeOnFail: 100,
  });
  return { sessionId, ...(job.id ? { jobId: job.id } : {}) };
}

/**
 * With no queue (the desktop app), run the worker's agent loop in this process on `driver`.
 * A restart ends the run; its session row keeps the messages saved so far.
 */
export async function runAgentInProcess(
  input: LaunchAgentInput & { sessionId: string },
  driver: LlmDriver,
): Promise<{ sessionId: string }> {
  const { handleAgentRunJob } = await import("@nexus/worker/agent-handler");
  const { sessionId } = input;
  void handleAgentRunJob(buildAgentRunJob(input, sessionId), driver).catch((e: unknown) =>
    console.error(
      "[agent-run] %s failed:",
      JSON.stringify(sessionId),
      e instanceof Error ? e.message : e,
    ),
  );
  return { sessionId };
}

/**
 * Enqueue a `browser.task` job for an existing session, so the run survives an
 * API restart. Returns false when no queue is configured, which is the signal
 * to run the loop in this process instead.
 */
export async function launchBrowserTask(sessionId: string): Promise<boolean> {
  const queue = await getQueue(QUEUE_MEDIUM);
  if (!queue) return false;
  try {
    await queue.add(
      "browser.task",
      { sessionId },
      { jobId: `browser-task-${sessionId}`, removeOnComplete: true, removeOnFail: 100 },
    );
    return true;
  } catch {
    return false;
  }
}
