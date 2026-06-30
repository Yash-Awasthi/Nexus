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

const QUEUE_HIGH = "nexus-high";

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

let _queue: QueueLike | null = null;

async function getQueue(): Promise<QueueLike | null> {
  if (_queue) return _queue;
  if (!process.env.REDIS_URL) return null;
  try {
    const { Queue } = await import("bullmq");
    _queue = new Queue(QUEUE_HIGH, {
      connection: parseRedisUrl(process.env.REDIS_URL),
    }) as unknown as QueueLike;
  } catch {
    _queue = null;
  }
  return _queue;
}

/** Fields accepted when launching an agent run (subset of the worker payload). */
export interface LaunchAgentInput {
  instruction: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
  maxSteps?: number;
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
