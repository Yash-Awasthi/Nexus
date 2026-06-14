// SPDX-License-Identifier: Apache-2.0
/**
 * sse-reconnect — Resumable SSE with session-keyed fan-out.
 *
 * Provides:
 *   • SseEventType         — block | updateBlock | researchComplete | heartbeat | error
 *   • SseEvent             — typed SSE payload
 *   • SseEventBuffer       — ring buffer for replay on reconnect
 *   • SseSubscriber        — per-client subscription handle
 *   • SseChannel           — per-session channel with fan-out
 *   • SseSessionManager    — registry of active channels
 *   • SseSerializer        — wire-format encode/decode
 */

// ── Event types ───────────────────────────────────────────────────────────────

export type SseEventType =
  | "block"
  | "updateBlock"
  | "researchComplete"
  | "heartbeat"
  | "error"
  | "connected";

export interface SseEvent {
  id: string;
  type: SseEventType;
  sessionId: string;
  data: unknown;
  timestamp: string;
}

// ── SseSerializer ─────────────────────────────────────────────────────────────

export class SseSerializer {
  static encode(event: SseEvent): string {
    const lines: string[] = [
      `id: ${event.id}`,
      `event: ${event.type}`,
      `data: ${JSON.stringify({ sessionId: event.sessionId, data: event.data, timestamp: event.timestamp })}`,
    ];
    return lines.join("\n") + "\n\n";
  }

  static decode(frame: string): SseEvent | null {
    const lines = frame.trim().split("\n");
    let id = "";
    let type: SseEventType = "block";
    let rawData = "";

    for (const line of lines) {
      if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("event: ")) type = line.slice(7) as SseEventType;
      else if (line.startsWith("data: ")) rawData = line.slice(6);
    }

    if (!id) return null;
    try {
      const parsed = JSON.parse(rawData);
      return {
        id,
        type,
        sessionId: parsed.sessionId ?? "",
        data: parsed.data,
        timestamp: parsed.timestamp ?? new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }
}

// ── SseEventBuffer ────────────────────────────────────────────────────────────

export class SseEventBuffer {
  private events: SseEvent[] = [];
  private maxSize: number;

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
  }

  push(event: SseEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.shift();
    }
  }

  /** Return all events with id > lastId (for reconnect catch-up). */
  since(lastId: string): SseEvent[] {
    const idx = this.events.findIndex((e) => e.id === lastId);
    if (idx === -1) return [...this.events];
    return this.events.slice(idx + 1);
  }

  all(): SseEvent[] { return [...this.events]; }
  size(): number { return this.events.length; }
  clear(): void { this.events = []; }
  last(): SseEvent | undefined { return this.events[this.events.length - 1]; }
}

// ── SseSubscriber ─────────────────────────────────────────────────────────────

export type SseHandler = (event: SseEvent) => void;

export interface SseSubscriber {
  id: string;
  handler: SseHandler;
  lastId?: string;
  unsubscribe: () => void;
}

// ── SseChannel ────────────────────────────────────────────────────────────────

let _evtSeq = 0;
let _subSeq = 0;

export class SseChannel {
  readonly sessionId: string;
  private subscribers = new Map<string, SseSubscriber>();
  private buffer: SseEventBuffer;
  private closed = false;

  constructor(sessionId: string, bufferSize = 200) {
    this.sessionId = sessionId;
    this.buffer = new SseEventBuffer(bufferSize);
  }

  subscribe(handler: SseHandler, lastId?: string): SseSubscriber {
    const id = `sub-${++_subSeq}`;
    const unsub = () => this.subscribers.delete(id);
    const subscriber: SseSubscriber = { id, handler, lastId, unsubscribe: unsub };
    this.subscribers.set(id, subscriber);

    // Replay missed events on reconnect
    if (lastId !== undefined) {
      const missed = this.buffer.since(lastId);
      for (const event of missed) {
        try { handler(event); } catch { /* isolate */ }
      }
    }

    return subscriber;
  }

  publish(type: SseEventType, data: unknown): SseEvent {
    if (this.closed) throw new Error(`Channel ${this.sessionId} is closed`);
    const event: SseEvent = {
      id: String(++_evtSeq),
      type,
      sessionId: this.sessionId,
      data,
      timestamp: new Date().toISOString(),
    };
    this.buffer.push(event);
    for (const sub of this.subscribers.values()) {
      try { sub.handler(event); } catch { /* isolate */ }
    }
    return event;
  }

  /** Send a block event (primary content chunk). */
  block(content: string, blockId?: string): SseEvent {
    return this.publish("block", { content, blockId });
  }

  /** Update an existing block by ID. */
  updateBlock(blockId: string, content: string): SseEvent {
    return this.publish("updateBlock", { blockId, content });
  }

  /** Signal research is complete. */
  researchComplete(summary?: string): SseEvent {
    return this.publish("researchComplete", { summary });
  }

  heartbeat(): SseEvent {
    return this.publish("heartbeat", { ping: true });
  }

  close(): void {
    this.closed = true;
    this.subscribers.clear();
  }

  isClosed(): boolean { return this.closed; }
  subscriberCount(): number { return this.subscribers.size; }
  getBuffer(): SseEventBuffer { return this.buffer; }
}

// ── SseSessionManager ─────────────────────────────────────────────────────────

export class SseSessionManager {
  private channels = new Map<string, SseChannel>();
  private bufferSize: number;

  constructor(bufferSize = 200) {
    this.bufferSize = bufferSize;
  }

  /** Get or create a channel for the given session. */
  getOrCreate(sessionId: string): SseChannel {
    if (!this.channels.has(sessionId)) {
      this.channels.set(sessionId, new SseChannel(sessionId, this.bufferSize));
    }
    return this.channels.get(sessionId)!;
  }

  get(sessionId: string): SseChannel | undefined { return this.channels.get(sessionId); }
  has(sessionId: string): boolean { return this.channels.has(sessionId); }

  /** Close and remove a channel. */
  close(sessionId: string): boolean {
    const ch = this.channels.get(sessionId);
    if (!ch) return false;
    ch.close();
    this.channels.delete(sessionId);
    return true;
  }

  closeAll(): void {
    for (const ch of this.channels.values()) ch.close();
    this.channels.clear();
  }

  /** Subscribe to a session; reconnect from lastId if provided. */
  subscribe(sessionId: string, handler: SseHandler, lastId?: string): SseSubscriber {
    return this.getOrCreate(sessionId).subscribe(handler, lastId);
  }

  /** Publish an event to a session. */
  publish(sessionId: string, type: SseEventType, data: unknown): SseEvent {
    return this.getOrCreate(sessionId).publish(type, data);
  }

  activeSessions(): string[] { return [...this.channels.keys()]; }
  count(): number { return this.channels.size; }
}
