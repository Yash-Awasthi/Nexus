/**
 * @nexus/resumable-streams — Resumable SSE streaming.
 *
 * Lets clients reconnect to in-flight server-sent-event streams after a page
 * refresh or network drop and continue receiving the same response from where
 * they left off.  Inspired by VoltAgent's resumable-streams package.
 *
 * Architecture:
 *   Publisher  — wraps an `AsyncIterable<StreamEvent>` and persists each
 *                emitted chunk to a ResumableStreamStore keyed by streamId.
 *   Subscriber — reconstructs a ReadableStream from stored chunks and
 *                continues emitting new chunks from the live publisher.
 *   Store      — pluggable persistence (in-memory, Redis, KV).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StreamEvent {
  /** Monotonically increasing sequence number (0-based). */
  seq: number;
  /** The raw chunk text / data. */
  data: string;
  /** Optional event type for SSE `event:` field. */
  event?: string;
  /** Timestamp when the chunk was emitted (ISO). */
  emittedAt: string;
}

export interface StreamMeta {
  streamId: string;
  /** Total events emitted so far. */
  totalEvents: number;
  /** Whether the stream has finished (successfully or with error). */
  done: boolean;
  /** Error message if the stream failed. */
  error?: string;
  /** Optional metadata attached at creation time. */
  metadata?: Record<string, unknown>;
}

export interface ResumableStreamStore {
  /** Create a new stream, returning the generated streamId. */
  createStream(meta?: Record<string, unknown>): Promise<string>;
  /** Append a chunk to an existing stream. */
  append(streamId: string, event: StreamEvent): Promise<void>;
  /** Mark the stream as done (optionally with an error). */
  markDone(streamId: string, error?: string): Promise<void>;
  /** Read stored events starting from `fromSeq` (inclusive). */
  read(streamId: string, fromSeq?: number): Promise<StreamEvent[]>;
  /** Get metadata about the stream. */
  getMeta(streamId: string): Promise<StreamMeta | null>;
  /** List active (not done) streams. */
  listActive(): Promise<StreamMeta[]>;
  /** Prune completed streams older than `maxAgeMs`. */
  prune(maxAgeMs: number): Promise<number>;
}

// ─── In-Memory Store ─────────────────────────────────────────────────────────

interface StoredStream {
  meta: StreamMeta;
  events: StreamEvent[];
  createdAt: number;
}

export class InMemoryStreamStore implements ResumableStreamStore {
  private streams = new Map<string, StoredStream>();

  async createStream(metadata?: Record<string, unknown>): Promise<string> {
    const streamId = crypto.randomUUID();
    this.streams.set(streamId, {
      meta: {
        streamId,
        totalEvents: 0,
        done: false,
        metadata,
      },
      events: [],
      createdAt: Date.now(),
    });
    return streamId;
  }

  async append(streamId: string, event: StreamEvent): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`Stream ${streamId} not found`);
    stream.events.push(event);
    stream.meta.totalEvents = event.seq + 1;
  }

  async markDone(streamId: string, error?: string): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`Stream ${streamId} not found`);
    stream.meta.done = true;
    stream.meta.error = error;
  }

  async read(streamId: string, fromSeq = 0): Promise<StreamEvent[]> {
    const stream = this.streams.get(streamId);
    if (!stream) return [];
    return stream.events.filter((e) => e.seq >= fromSeq);
  }

  async getMeta(streamId: string): Promise<StreamMeta | null> {
    return this.streams.get(streamId)?.meta ?? null;
  }

  async listActive(): Promise<StreamMeta[]> {
    return [...this.streams.values()]
      .filter((s) => !s.meta.done)
      .map((s) => s.meta);
  }

  async prune(maxAgeMs: number): Promise<number> {
    const now = Date.now();
    let pruned = 0;
    for (const [id, stream] of this.streams) {
      if (stream.meta.done && now - stream.createdAt > maxAgeMs) {
        this.streams.delete(id);
        pruned++;
      }
    }
    return pruned;
  }
}

// ─── Publisher ────────────────────────────────────────────────────────────────

export interface PublisherOptions {
  store: ResumableStreamStore;
  /** Optional TTL in ms for completed streams (default: 5 min). */
  ttlMs?: number;
}

/**
 * Wraps an async iterable of stream events and persists each chunk to the
 * store so that a subscriber can resume later.
 */
export class ResumablePublisher {
  private store: ResumableStreamStore;
  private ttlMs: number;

  constructor(opts: PublisherOptions) {
    this.store = opts.store;
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
  }

  /**
   * Create a new stream and pipe events from `source` into the store.
   * Returns a `ResumableStreamController` that can be used to get the
   * streamId and monitor progress.
   */
  async publish(
    source: AsyncIterable<StreamEvent>,
    metadata?: Record<string, unknown>,
  ): Promise<ResumableStreamController> {
    const streamId = await this.store.createStream(metadata);
    const controller = new ResumableStreamController(streamId, this.store);

    // Background: consume the source and persist chunks
    (async () => {
      try {
        for await (const event of source) {
          await this.store.append(streamId, event);
          controller.emit(event);
        }
        await this.store.markDone(streamId);
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.store.markDone(streamId, msg);
        controller.error(msg);
      }
    })();

    return controller;
  }
}

// ─── Controller ───────────────────────────────────────────────────────────────

export class ResumableStreamController {
  readonly streamId: string;
  private store: ResumableStreamStore;
  private listeners: Array<(event: StreamEvent) => void> = [];
  private doneListeners: Array<() => void> = [];
  private errorListeners: Array<(err: string) => void> = [];

  constructor(streamId: string, store: ResumableStreamStore) {
    this.streamId = streamId;
    this.store = store;
  }

  /** Subscribe to new events. */
  onEvent(fn: (event: StreamEvent) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  /** Subscribe to stream completion. */
  onDone(fn: () => void): () => void {
    this.doneListeners.push(fn);
    return () => {
      this.doneListeners = this.doneListeners.filter((l) => l !== fn);
    };
  }

  /** Subscribe to errors. */
  onError(fn: (err: string) => void): () => void {
    this.errorListeners.push(fn);
    return () => {
      this.errorListeners = this.errorListeners.filter((l) => l !== fn);
    };
  }

  /** Get a ReadableStream that replays stored events then continues live. */
  async toReadableStream(fromSeq = 0): Promise<ReadableStream<StreamEvent>> {
    const stored = await this.store.read(this.streamId, fromSeq);
    const meta = await this.store.getMeta(this.streamId);

    // If the stream is already done and we have all events, just return them
    if (meta?.done && stored.length > 0) {
      let cancelled = false;
      return new ReadableStream({
        start(controller) {
          for (const event of stored) {
            if (cancelled) break;
            controller.enqueue(event);
          }
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      });
    }

    // Otherwise replay stored events then subscribe to live
    let cancelled = false;
    const buffer: StreamEvent[] = [...stored];
    let flushed = 0;

    return new ReadableStream({
      start: (controller) => {
        // Flush buffered events
        for (const event of buffer) {
          if (cancelled) break;
          controller.enqueue(event);
          flushed++;
        }

        // Subscribe to live events from the controller
        const unsub = this.onEvent((event) => {
          if (!cancelled) {
            controller.enqueue(event);
          }
        });

        this.onDone(() => {
          if (!cancelled) {
            unsub();
            controller.close();
          }
        });

        this.onError((err) => {
          if (!cancelled) {
            unsub();
            controller.error(new Error(err));
          }
        });
      },
      cancel() {
        cancelled = true;
      },
    });
  }

  /** @internal */
  emit(event: StreamEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  /** @internal */
  close(): void {
    for (const fn of this.doneListeners) fn();
  }

  /** @internal */
  error(msg: string): void {
    for (const fn of this.errorListeners) fn(msg);
  }
}

// ─── Subscriber ───────────────────────────────────────────────────────────────

export interface SubscriberOptions {
  store: ResumableStreamStore;
  /** The streamId to resume. */
  streamId: string;
  /** Sequence number to resume from (default: 0 — replay all). */
  fromSeq?: number;
  /** Poll interval in ms when waiting for new events (default: 100). */
  pollIntervalMs?: number;
  /** Max poll attempts before giving up (default: 300 = 30s at 100ms). */
  maxPollAttempts?: number;
}

/**
 * Resumes an existing stream by reading stored events and polling for new ones.
 */
export async function resumeStream(
  opts: SubscriberOptions,
): Promise<ReadableStream<StreamEvent>> {
  const {
    store,
    streamId,
    fromSeq = 0,
    pollIntervalMs = 100,
    maxPollAttempts = 300,
  } = opts;

  const stored = await store.read(streamId, fromSeq);
  const meta = await store.getMeta(streamId);

  if (!meta) {
    throw new Error(`Stream ${streamId} not found`);
  }

  // If already done, return stored events
  if (meta.done) {
    return new ReadableStream({
      start(controller) {
        for (const event of stored) controller.enqueue(event);
        controller.close();
      },
    });
  }

  // Poll for new events
  let cancelled = false;
  let lastSeq = stored.length > 0 ? stored[stored.length - 1].seq : fromSeq - 1;

  return new ReadableStream({
    start: (controller) => {
      // First emit all stored events
      for (const event of stored) {
        if (cancelled) break;
        controller.enqueue(event);
        lastSeq = event.seq;
      }

      // Then poll for new ones
      (async () => {
        let attempts = 0;
        while (!cancelled && attempts < maxPollAttempts) {
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          const newEvents = await store.read(streamId, lastSeq + 1);
          for (const event of newEvents) {
            if (cancelled) break;
            controller.enqueue(event);
            lastSeq = event.seq;
          }

          const currentMeta = await store.getMeta(streamId);
          if (currentMeta?.done) {
            controller.close();
            return;
          }

          attempts++;
        }
        if (!cancelled) {
          controller.close();
        }
      })();
    },
    cancel() {
      cancelled = true;
    },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create an SSE endpoint handler for a resumable stream.
 * Returns headers and a readable stream suitable for a Response.
 */
export function createSSEResponse(
  stream: ReadableStream<StreamEvent>,
  streamId: string,
): Response {
  const encoder = new TextEncoder();
  const sseStream = stream.pipeThrough(
    new TransformStream<StreamEvent, Uint8Array>({
      transform(event, controller) {
        const lines = [`id: ${event.seq}`, `data: ${event.data}`];
        if (event.event) lines.unshift(`event: ${event.event}`);
        lines.push("", ""); // SSE delimiter
        controller.enqueue(encoder.encode(lines.join("\n")));
      },
    }),
  );

  return new Response(sseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Stream-Id": streamId,
    },
  });
}

/**
 * Client-side helper to consume a resumable SSE stream with automatic
 * reconnection on disconnect.
 */
export function createResumableSSEClient(
  url: string,
  fromSeq = 0,
): {
  stream: ReadableStream<StreamEvent>;
  reconnect: () => void;
  close: () => void;
} {
  let currentUrl = fromSeq > 0 ? `${url}?from=${fromSeq}` : url;
  let controller: ReadableStreamDefaultController<StreamEvent> | null = null;
  let closed = false;

  const stream = new ReadableStream<StreamEvent>({
    start(ctrl) {
      controller = ctrl;
      connect(currentUrl);
    },
    cancel() {
      closed = true;
    },
  });

  async function connect(url: string) {
    if (closed) return;
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) {
        // Retry after delay
        setTimeout(() => connect(url), 2000);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastSeq = fromSeq - 1;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = parseSSEBuffer(buffer);
        buffer = events.remaining;

        for (const event of events.parsed) {
          if (closed) return;
          if (event.seq > lastSeq) {
            lastSeq = event.seq;
            controller?.enqueue(event);
          }
        }
      }

      // Stream ended — get the last seq for potential reconnect
      if (!closed) {
        currentUrl = `${url.split("?")[0]}?from=${lastSeq + 1}`;
        setTimeout(() => connect(currentUrl), 500);
      }
    } catch {
      // Connection error — retry
      if (!closed) {
        setTimeout(() => connect(currentUrl), 2000);
      }
    }
  }

  return {
    stream,
    reconnect() {
      if (closed) return;
      currentUrl = fromSeq > 0 ? `${url}?from=${fromSeq}` : url;
      connect(currentUrl);
    },
    close() {
      closed = true;
      controller?.close();
    },
  };
}

/** @internal Parse SSE text buffer into structured events. */
function parseSSEBuffer(buffer: string): {
  parsed: StreamEvent[];
  remaining: string;
} {
  const events: StreamEvent[] = [];
  const blocks = buffer.split("\n\n");
  const remaining = blocks.pop() ?? "";

  for (const block of blocks) {
    const lines = block.split("\n");
    let seq = 0;
    let data = "";
    let event: string | undefined;

    for (const line of lines) {
      if (line.startsWith("id: ")) seq = parseInt(line.slice(4), 10) || 0;
      else if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: "))
        data += (data ? "\n" : "") + line.slice(6);
    }

    if (data) {
      events.push({
        seq,
        data,
        event,
        emittedAt: new Date().toISOString(),
      });
    }
  }

  return { parsed: events, remaining };
}
