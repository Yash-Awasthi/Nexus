// SPDX-License-Identifier: Apache-2.0
/**
 * agent-events-bridge — API-side Redis→SSE bridge for agent-run streaming.
 *
 * Agent runs execute in the worker process and PUBLISH their step/compaction/
 * status events on {@link AGENT_EVENTS_CHANNEL}. This bridge SUBSCRIBEs to that
 * channel and re-publishes each event onto the API's in-process SSE bus
 * (`dispatchAgentEvent`), so the `/sse/agent/:stream` route delivers them to
 * connected clients.
 *
 * Fail-open: with no `REDIS_URL` (single-process / local dev) the bridge is a
 * no-op — the SSE route still works for events published in-process.
 */
import { AGENT_EVENTS_CHANNEL, dispatchAgentEvent, type AgentStreamEvent } from "@nexus/sse";

type SubRedis = {
  subscribe(channel: string): Promise<unknown>;
  on(event: "message", cb: (channel: string, message: string) => void): void;
  quit(): Promise<unknown>;
  disconnect(): void;
};

/**
 * Parse one raw channel message and dispatch it onto the SSE bus. Exported for
 * tests. Silently drops malformed JSON or events missing a `stream`/`type`.
 */
export function handleAgentEventMessage(message: string): void {
  let ev: AgentStreamEvent;
  try {
    ev = JSON.parse(message) as AgentStreamEvent;
  } catch {
    return;
  }
  if (!ev || typeof ev.stream !== "string" || typeof ev.type !== "string") return;
  dispatchAgentEvent({
    stream: ev.stream,
    type: ev.type,
    data: ev.data ?? {},
    ts: typeof ev.ts === "number" ? ev.ts : 0,
  });
}

let _client: SubRedis | null = null;
let _starting: Promise<void> | null = null;

/**
 * Start the subscriber once per process (idempotent). No-op without REDIS_URL
 * or if ioredis can't be loaded.
 */
export async function startAgentEventsBridge(): Promise<void> {
  if (_client || _starting) return _starting ?? undefined;
  if (!process.env.REDIS_URL) return;
  _starting = (async () => {
    try {
      const ioredis = await import("ioredis");
      const Redis = (ioredis.default ?? ioredis) as unknown as new (
        url: string,
        opts: Record<string, unknown>,
      ) => SubRedis;
      const client = new Redis(process.env.REDIS_URL!, {
        lazyConnect: false,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
      client.on("message", (channel, message) => {
        if (channel === AGENT_EVENTS_CHANNEL) handleAgentEventMessage(message);
      });
      await client.subscribe(AGENT_EVENTS_CHANNEL);
      _client = client;
    } catch (e) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "agent_events_bridge.start_failed",
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      _starting = null;
    }
  })();
  return _starting;
}

/** Stop the subscriber (on server shutdown). */
export async function stopAgentEventsBridge(): Promise<void> {
  const client = _client;
  _client = null;
  if (!client) return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
