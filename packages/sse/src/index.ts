// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/sse — Server-Sent Events infrastructure
 *
 * Provides:
 *  • Domain event types  — TaskUpdateEvent, SignalEvent, VerdictEvent, etc.
 *  • formatSseEvent()    — serialises an SseEvent to the SSE wire format
 *  • SseEventBus         — typed in-process pub/sub (Node EventEmitter wrapper)
 *  • globalBus           — shared singleton used by API routes and workers
 *
 * Channel naming convention
 * ─────────────────────────
 *   "tasks"             — all task status transitions
 *   "tasks:<taskId>"    — events for a single task
 *   "signals"           — all ingest signals
 *   "verdicts"          — all council verdicts
 *   "verdicts:<taskId>" — verdict for a specific task
 */

import { EventEmitter } from "events";

// ── Wire-format types ─────────────────────────────────────────────────────────

export interface SseEvent<T = unknown> {
  /** SSE `event:` field. Omit for unnamed (data-only) events. */
  event?: string;
  /** Payload — will be JSON.stringify'd into the `data:` field */
  data: T;
  /** Optional SSE `id:` field for client-side reconnect tracking */
  id?: string;
  /** Optional SSE `retry:` field (milliseconds) */
  retry?: number;
}

// ── Domain event payloads ─────────────────────────────────────────────────────

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "paused";

/** Task update payload interface definition. */
export interface TaskUpdatePayload {
  taskId: string;
  status: TaskStatus;
  /** Human-readable progress note */
  message?: string;
  /** 0–100 progress percentage */
  progress?: number;
  /** ISO 8601 timestamp */
  updatedAt: string;
}

/** Signal priority type alias. */
export type SignalPriority = "low" | "medium" | "high" | "critical";

/** Signal payload interface definition. */
export interface SignalPayload {
  signalId: string;
  signalType: string;
  summary: string;
  priority: SignalPriority;
  createdAt: string;
}

/** Verdict outcome type alias. */
export type VerdictOutcome = "approved" | "rejected" | "deferred" | "escalated";

/** Verdict payload interface definition. */
export interface VerdictPayload {
  verdictId: string;
  taskId?: string;
  signalId?: string;
  outcome: VerdictOutcome;
  rationale: string;
  createdAt: string;
}

// ── SSE wire-format serialiser ────────────────────────────────────────────────

/**
 * Serialise an SseEvent to the SSE wire format string.
 *
 * Output example:
 *   id: abc-123\n
 *   event: task.update\n
 *   data: {"taskId":"t1","status":"running"}\n
 *   \n
 *
 * Rules (per https://html.spec.whatwg.org/multipage/server-sent-events.html):
 *  - Each field is `<name>: <value>\n`
 *  - Multi-line data values are split on \n and each line prefixed with `data: `
 *  - The event is terminated by an extra blank line (`\n\n` total)
 */
export function formatSseEvent<T>(event: SseEvent<T>): string {
  const parts: string[] = [];

  if (event.id !== undefined) {
    parts.push(`id: ${event.id}`);
  }

  if (event.retry !== undefined) {
    parts.push(`retry: ${event.retry}`);
  }

  if (event.event !== undefined) {
    parts.push(`event: ${event.event}`);
  }

  const dataStr = typeof event.data === "string" ? event.data : JSON.stringify(event.data);

  // Multi-line data must be split across multiple `data:` lines
  for (const line of dataStr.split("\n")) {
    parts.push(`data: ${line}`);
  }

  return parts.join("\n") + "\n\n";
}

/**
 * Format a keepalive comment ping — invisible to the client EventSource API
 * but keeps the TCP connection alive through proxies.
 */
export function formatPing(): string {
  return ":ping\n\n";
}

// ── SseEventBus ───────────────────────────────────────────────────────────────

export type SseListener<T = unknown> = (event: SseEvent<T>) => void;

/**
 * Typed in-process pub/sub bus.
 *
 * Wraps Node's EventEmitter with explicit channel typing.
 * Each channel is an EventEmitter event name.
 *
 * `maxListeners` defaults to 500 — tuned for many concurrent SSE connections.
 */
export class SseEventBus {
  private readonly emitter: EventEmitter;

  constructor(maxListeners = 500) {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(maxListeners);
  }

  /**
   * Subscribe to a channel. Returns an unsubscribe function.
   */
  subscribe<T>(channel: string, listener: SseListener<T>): () => void {
    this.emitter.on(channel, listener as SseListener);
    return () => this.unsubscribe(channel, listener);
  }

  /**
   * Subscribe to a channel for exactly one event, then auto-unsubscribe.
   */
  once<T>(channel: string, listener: SseListener<T>): void {
    this.emitter.once(channel, listener as SseListener);
  }

  /**
   * Unsubscribe a previously registered listener.
   */
  unsubscribe<T>(channel: string, listener: SseListener<T>): void {
    this.emitter.off(channel, listener as SseListener);
  }

  /**
   * Publish an event to a channel. All subscribers are called synchronously.
   */
  publish<T>(channel: string, event: SseEvent<T>): void {
    this.emitter.emit(channel, event);
  }

  /**
   * Remove ALL listeners from a channel (useful in tests).
   */
  clear(channel: string): void {
    this.emitter.removeAllListeners(channel);
  }

  /**
   * Remove ALL listeners from ALL channels.
   */
  clearAll(): void {
    this.emitter.removeAllListeners();
  }

  /**
   * Return the number of active listeners on a channel.
   */
  listenerCount(channel: string): number {
    return this.emitter.listenerCount(channel);
  }
}

// ── Shared singleton ──────────────────────────────────────────────────────────

/**
 * Global bus — imported by API routes and worker handlers.
 *
 * In a multi-process deployment (separate API + worker processes) this
 * in-process bus only spans the single process. For cross-process delivery,
 * replace with a Redis pub/sub adapter that calls globalBus.publish() on
 * receipt. The SSE routes do not need to change.
 */
export const globalBus = new SseEventBus();

// ── Convenience publishers ────────────────────────────────────────────────────

/**
 * Publish a task status update to both the "tasks" channel and the
 * task-specific "tasks:<taskId>" channel.
 */
export function publishTaskUpdate(payload: TaskUpdatePayload): void {
  const event: SseEvent<TaskUpdatePayload> = {
    event: "task.update",
    data: payload,
    id: `task-${payload.taskId}-${Date.now()}`,
  };
  globalBus.publish("tasks", event);
  globalBus.publish(`tasks:${payload.taskId}`, event);
}

/**
 * Publish a new signal to the "signals" channel.
 */
export function publishSignal(payload: SignalPayload): void {
  const event: SseEvent<SignalPayload> = {
    event: "signal.new",
    data: payload,
    id: `signal-${payload.signalId}`,
  };
  globalBus.publish("signals", event);
}

/**
 * Publish a council verdict to the "verdicts" channel and, if a taskId
 * is present, to the task-specific "verdicts:<taskId>" channel.
 */
export function publishVerdict(payload: VerdictPayload): void {
  const event: SseEvent<VerdictPayload> = {
    event: "verdict.new",
    data: payload,
    id: `verdict-${payload.verdictId}`,
  };
  globalBus.publish("verdicts", event);
  if (payload.taskId) {
    globalBus.publish(`verdicts:${payload.taskId}`, event);
  }
}

// ── Agent-run streaming (cross-process worker → API bridge) ─────────────────────
//
// Agent runs execute in the worker process; their step/compaction/status events
// must reach SSE clients connected to the API process. The worker PUBLISHes each
// event as JSON on AGENT_EVENTS_CHANNEL; the API's Redis subscriber bridge calls
// `dispatchAgentEvent` for each message, re-publishing onto this in-process bus
// so the SSE routes deliver it unchanged.

/** Redis pub/sub channel carrying agent-run events across processes. */
export const AGENT_EVENTS_CHANNEL = "nexus:agent-events";

export type AgentEventType = "run_started" | "step" | "compaction" | "status" | "learnings";

/** A worker-published agent-run event, scoped to one run's stream id. */
export interface AgentStreamEvent {
  /** Stream subscribers filter on — the run's sessionId or taskId. */
  stream: string;
  type: AgentEventType;
  data: Record<string, unknown>;
  /** Epoch ms the event was produced. */
  ts: number;
}

/**
 * Re-publish a cross-process agent event onto the in-process bus, fanning it to
 * the run-specific `agent:<stream>` channel and the firehose `agent` channel.
 * Called by the API bridge for each message on {@link AGENT_EVENTS_CHANNEL}.
 */
export function dispatchAgentEvent(ev: AgentStreamEvent): void {
  const event: SseEvent = {
    event: `agent.${ev.type}`,
    data: { stream: ev.stream, ...ev.data },
    id: `agent-${ev.stream}-${ev.ts}`,
  };
  globalBus.publish(`agent:${ev.stream}`, event);
  globalBus.publish("agent", event);
}
