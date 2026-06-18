/**
 * Event store persistence interface.
 *
 * IEventStore provides append-only write-before-dispatch semantics for
 * durable event persistence. Implementations may use JSONL files,
 * in-memory stores, or any backend supporting sequential writes and replay.
 */

export interface EventRecord {
  event: string;
  payload: unknown;
  timestamp: string;
}

export interface IEventStore {
  /** Serialize and persist an event. */
  saveEvent(event: string, payload: unknown): Promise<void>;
  /** Replay events, optionally filtered since a given timestamp. Returns parsed event records. */
  replayEvents(since?: Date): Promise<EventRecord[]>;
}
