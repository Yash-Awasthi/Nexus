// SPDX-License-Identifier: Apache-2.0
/**
 * agent-events — worker-side publisher for agent-run streaming.
 *
 * Each agent step / compaction / status event is PUBLISHed as JSON on the
 * shared Redis channel; the API's subscriber bridge re-publishes it onto its
 * in-process SSE bus so connected clients receive it live. Best-effort and
 * fail-open: with no `REDIS_URL` (or if ioredis is unavailable) it is a no-op,
 * so the agent loop never blocks or fails on telemetry.
 */
import { AGENT_EVENTS_CHANNEL, type AgentEventType, type AgentStreamEvent } from "@nexus/sse";

type PubRedis = { publish(channel: string, message: string): Promise<unknown> };

let _redis: PubRedis | null = null;
let _tried = false;

async function getPublisher(): Promise<PubRedis | null> {
  if (_redis) return _redis;
  if (_tried || !process.env.REDIS_URL) return null;
  _tried = true; // only attempt the connection once per process
  try {
    const ioredis = await import("ioredis");
    const Redis = (ioredis.default ?? ioredis) as unknown as new (
      url: string,
      opts: Record<string, unknown>,
    ) => PubRedis;
    _redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
    });
  } catch {
    _redis = null;
  }
  return _redis;
}

/**
 * Fire-and-forget publish of an agent-run event for `stream` (the run's
 * sessionId/taskId). Never throws.
 */
export async function publishAgentEvent(
  stream: string,
  type: AgentEventType,
  data: Record<string, unknown>,
): Promise<void> {
  const redis = await getPublisher();
  if (!redis) return;
  const ev: AgentStreamEvent = { stream, type, data, ts: Date.now() };
  try {
    await redis.publish(AGENT_EVENTS_CHANNEL, JSON.stringify(ev));
  } catch {
    // best-effort telemetry — drop on failure
  }
}
