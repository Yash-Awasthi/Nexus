// SPDX-License-Identifier: Apache-2.0
/**
 * worker-events — Typed SSE event bus for worker ↔ client communication.
 *
 * Provides:
 *   • Typed event definitions for session lifecycle + observation pipeline
 *   • EventChannel — per-session pub/sub channel
 *   • SessionEventBroadcaster — named channel registry + fan-out
 *   • SseSerializer — serialize events to SSE wire format
 *   • EventFilter — predicate-based subscription filtering
 *   • EventReplay — in-memory ring buffer for late-join catch-up
 */

// ── Event type definitions ────────────────────────────────────────────────────

export type WorkerEventType =
  | "session_started"
  | "new_prompt"
  | "observation_queued"
  | "observation_processed"
  | "session_completed"
  | "summarize_queued"
  | "summarize_completed"
  | "error"
  | "heartbeat";

export interface BaseWorkerEvent {
  type: WorkerEventType;
  sessionId: string;
  timestamp: string; // ISO
  id: string;        // monotonic per channel
}

export interface SessionStartedEvent extends BaseWorkerEvent {
  type: "session_started";
  model: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface NewPromptEvent extends BaseWorkerEvent {
  type: "new_prompt";
  promptId: string;
  role: "user" | "assistant" | "system";
  contentPreview: string; // first 200 chars
  tokenEstimate?: number;
}

export interface ObservationQueuedEvent extends BaseWorkerEvent {
  type: "observation_queued";
  observationId: string;
  kind: string;
  priority?: number;
}

export interface ObservationProcessedEvent extends BaseWorkerEvent {
  type: "observation_processed";
  observationId: string;
  success: boolean;
  durationMs: number;
}

export interface SessionCompletedEvent extends BaseWorkerEvent {
  type: "session_completed";
  totalPrompts: number;
  totalObservations: number;
  durationMs: number;
  reason: "user_end" | "timeout" | "max_turns" | "error";
}

export interface SummarizeQueuedEvent extends BaseWorkerEvent {
  type: "summarize_queued";
  targetSessionId: string;
  triggerReason: "context_limit" | "periodic" | "manual";
}

export interface SummarizeCompletedEvent extends BaseWorkerEvent {
  type: "summarize_completed";
  targetSessionId: string;
  summaryTokens: number;
  durationMs: number;
}

export interface ErrorEvent extends BaseWorkerEvent {
  type: "error";
  code: string;
  message: string;
  fatal: boolean;
}

export interface HeartbeatEvent extends BaseWorkerEvent {
  type: "heartbeat";
  uptimeMs: number;
}

export type WorkerEvent =
  | SessionStartedEvent
  | NewPromptEvent
  | ObservationQueuedEvent
  | ObservationProcessedEvent
  | SessionCompletedEvent
  | SummarizeQueuedEvent
  | SummarizeCompletedEvent
  | ErrorEvent
  | HeartbeatEvent;

// ── SseSerializer ─────────────────────────────────────────────────────────────

export class SseSerializer {
  /** Encode a WorkerEvent as an SSE data frame. */
  encode(event: WorkerEvent): string {
    const lines = [
      `id: ${event.id}`,
      `event: ${event.type}`,
      `data: ${JSON.stringify(event)}`,
      "",
      "",
    ];
    return lines.join("\n");
  }

  /** Decode an SSE data frame back to a WorkerEvent (throws on parse error). */
  decode(frame: string): WorkerEvent {
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("data: ")) data = line.slice(6);
    }
    return JSON.parse(data) as WorkerEvent;
  }
}

// ── EventFilter ───────────────────────────────────────────────────────────────

export type EventPredicate = (event: WorkerEvent) => boolean;

export class EventFilter {
  static byType(...types: WorkerEventType[]): EventPredicate {
    const set = new Set(types);
    return (e) => set.has(e.type);
  }

  static bySession(sessionId: string): EventPredicate {
    return (e) => e.sessionId === sessionId;
  }

  static and(...predicates: EventPredicate[]): EventPredicate {
    return (e) => predicates.every((p) => p(e));
  }

  static or(...predicates: EventPredicate[]): EventPredicate {
    return (e) => predicates.some((p) => p(e));
  }

  static not(predicate: EventPredicate): EventPredicate {
    return (e) => !predicate(e);
  }
}

// ── EventReplay ring-buffer ───────────────────────────────────────────────────

export class EventReplay {
  private buffer: WorkerEvent[] = [];
  private maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  push(event: WorkerEvent): void {
    if (this.buffer.length >= this.maxSize) this.buffer.shift();
    this.buffer.push(event);
  }

  /** Return events since the given ID (exclusive). Empty ID = all events. */
  since(lastId: string): WorkerEvent[] {
    if (!lastId) return [...this.buffer];
    const idx = this.buffer.findIndex((e) => e.id === lastId);
    if (idx === -1) return [...this.buffer];
    return this.buffer.slice(idx + 1);
  }

  all(): WorkerEvent[] { return [...this.buffer]; }
  size(): number { return this.buffer.length; }
  clear(): void { this.buffer = []; }
}

// ── EventChannel ──────────────────────────────────────────────────────────────

export type UnsubscribeFn = () => void;

let _globalSeq = 0;

export class EventChannel {
  readonly sessionId: string;
  private subscribers = new Map<string, { predicate: EventPredicate | null; handler: (e: WorkerEvent) => void }>();
  private seq = 0;
  private replay: EventReplay;
  private closed = false;

  constructor(sessionId: string, replaySize = 50) {
    this.sessionId = sessionId;
    this.replay = new EventReplay(replaySize);
  }

  /** Subscribe to events matching an optional predicate. Returns an unsubscribe fn. */
  subscribe(handler: (e: WorkerEvent) => void, predicate?: EventPredicate): UnsubscribeFn {
    const id = `sub-${++_globalSeq}`;
    this.subscribers.set(id, { predicate: predicate ?? null, handler });
    return () => this.subscribers.delete(id);
  }

  /** Publish an event to all matching subscribers. */
  publish(eventPayload: Omit<WorkerEvent, "id" | "sessionId" | "timestamp">): WorkerEvent {
    if (this.closed) throw new Error(`Channel ${this.sessionId} is closed`);
    const event = {
      ...eventPayload,
      sessionId: this.sessionId,
      id: String(++this.seq),
      timestamp: new Date().toISOString(),
    } as WorkerEvent;

    this.replay.push(event);

    for (const { predicate, handler } of this.subscribers.values()) {
      if (!predicate || predicate(event)) {
        try { handler(event); } catch { /* subscriber errors don't break the bus */ }
      }
    }

    return event;
  }

  /** Catch-up replay for late-joining subscribers. */
  catchUp(lastId: string, handler: (e: WorkerEvent) => void): void {
    for (const event of this.replay.since(lastId)) {
      handler(event);
    }
  }

  close(): void { this.closed = true; this.subscribers.clear(); }
  get isClosed(): boolean { return this.closed; }
  get subscriberCount(): number { return this.subscribers.size; }
  getReplay(): EventReplay { return this.replay; }
}

// ── SessionEventBroadcaster ───────────────────────────────────────────────────

export class SessionEventBroadcaster {
  private channels = new Map<string, EventChannel>();
  private replaySize: number;

  constructor(replaySize = 50) {
    this.replaySize = replaySize;
  }

  /** Get or create a channel for the given session. */
  channel(sessionId: string): EventChannel {
    let ch = this.channels.get(sessionId);
    if (!ch) {
      ch = new EventChannel(sessionId, this.replaySize);
      this.channels.set(sessionId, ch);
    }
    return ch;
  }

  /** Publish to a named session channel. Creates the channel if needed. */
  publish(sessionId: string, event: Omit<WorkerEvent, "id" | "sessionId" | "timestamp">): WorkerEvent {
    return this.channel(sessionId).publish(event);
  }

  /** Fan-out to ALL open channels. */
  broadcast(event: Omit<WorkerEvent, "id" | "sessionId" | "timestamp"> & { sessionId: string }): void {
    for (const ch of this.channels.values()) {
      if (!ch.isClosed) {
        try { ch.publish(event); } catch { /* closed channels throw; skip */ }
      }
    }
  }

  /** Close and remove a channel. */
  closeChannel(sessionId: string): void {
    const ch = this.channels.get(sessionId);
    if (ch) { ch.close(); this.channels.delete(sessionId); }
  }

  /** Close all channels. */
  closeAll(): void {
    for (const ch of this.channels.values()) ch.close();
    this.channels.clear();
  }

  sessionIds(): string[] { return [...this.channels.keys()]; }
  hasChannel(sessionId: string): boolean { return this.channels.has(sessionId); }
  channelCount(): number { return this.channels.size; }
}
