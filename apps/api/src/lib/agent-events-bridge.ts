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
  on(event: "error", cb: (err: unknown) => void): void;
  connect(): Promise<unknown>;
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
  // Fire-and-forget: the bridge must NEVER block server startup. If Redis is
  // unreachable (common in local dev with a stale REDIS_URL), the connection
  // retries in the background and the SSE route still serves in-process
  // events. We resolve immediately and only track the promise for idempotency.
  _starting = (async () => {
    try {
      const ioredis = await import("ioredis");
      const Redis = (ioredis.default ?? ioredis) as unknown as new (
        url: string,
        opts: Record<string, unknown>,
      ) => SubRedis;
      const client = new Redis(process.env.REDIS_URL!, {
        // Defer the actual TCP connect so the constructor returns instantly;
        // we drive the subscribe below with a bounded timeout.
        lazyConnect: true,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        connectTimeout: 2_000,
        retryStrategy: (times: number) => (times > 5 ? null : Math.min(500 * times, 2_000)),
      });
      client.on("error", () => {
        // Swallow — redis-down is non-fatal for the bridge.
      });
      client.on("message", (channel, message) => {
        if (channel === AGENT_EVENTS_CHANNEL) handleAgentEventMessage(message);
      });
      // Attempt the connect + subscribe in the background with a hard 2s cap.
      // Failure is logged but never thrown to the caller.
      void Promise.race([
        client.connect().then(() => client.subscribe(AGENT_EVENTS_CHANNEL)),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("redis connect timeout")), 2_000),
        ),
      ])
        .then(() => {
          _client = client;
        })
        .catch((e: unknown) => {
          console.error(
            JSON.stringify({
              level: "error",
              event: "agent_events_bridge.start_failed",
              error: e instanceof Error ? e.message : String(e),
            }),
          );
          try {
            client.disconnect();
          } catch {
            /* ignore */
          }
        });
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
  // Resolve immediately — the background connection attempt continues on its own.
  // We deliberately do NOT await _starting so an unreachable Redis can never
  // block Fastify plugin registration (the cause of AVV_ERR_PLUGIN_EXEC_TIMEOUT).
  // The promise is tracked only for idempotency.
  _starting.catch(() => {});
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
