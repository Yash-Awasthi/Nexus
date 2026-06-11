// SPDX-License-Identifier: Apache-2.0
/**
 * SignalProcessor — the core pipeline stage.
 *
 * Responsibility:
 *   1. Pull unprocessed IngestedEvents from the store (IEventSource)
 *   2. Classify each event into a typed Signal via SignalClassifier
 *   3. Persist the Signal (ISignalSink)
 *   4. Mark the source event as processed
 *   5. Publish nexus.signals.created on the event bus
 *
 * Deduplication:
 *   Events are marked processed before publishing. If the publish fails the
 *   event remains marked processed (signal was persisted) — acceptable because
 *   the council can query signals directly. The reverse (publish but not mark)
 *   would cause double-processing, which is worse.
 *
 * Batching:
 *   Processes up to `batchSize` events per tick (default 50) to bound latency.
 *
 * Polling:
 *   SignalProcessor.start() polls on a configurable interval. Use
 *   SignalProcessor.processOnce() in workers that prefer push-based triggering.
 */

import { randomUUID } from "node:crypto";

import { SignalClassifier, type ClassificationInput } from "./classifier.js";

// ── Storage adapter interfaces ────────────────────────────────────────────────

export interface RawEvent {
  id: string;
  source: string;
  eventType: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface IEventSource {
  /** Return up to `limit` unprocessed events, ordered by created_at ASC */
  getUnprocessed(limit: number): Promise<RawEvent[]>;
  /** Mark an event as processed (idempotent) */
  markProcessed(eventId: string): Promise<void>;
}

export interface CreatedSignal {
  id: string;
  signalType: string;
  sourceEventIds: string[];
  summary: string;
  priority: "low" | "medium" | "high" | "critical";
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface ISignalSink {
  /** Persist a new Signal and return it with its assigned id */
  create(signal: Omit<CreatedSignal, "id" | "createdAt">): Promise<CreatedSignal>;
}

export interface ISignalEventBus {
  publish(event: string, payload: unknown): Promise<void>;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface SignalProcessorConfig {
  eventSource: IEventSource;
  signalSink: ISignalSink;
  eventBus?: ISignalEventBus;
  classifier?: SignalClassifier;
  batchSize?: number;
  pollIntervalMs?: number;
  onError?: (err: Error, eventId: string) => void;
}

// ── ProcessBatchResult ────────────────────────────────────────────────────────

export interface ProcessBatchResult {
  processed: number;
  skipped: number;
  errors: number;
  signals: CreatedSignal[];
}

// ── SignalProcessor ───────────────────────────────────────────────────────────

export class SignalProcessor {
  private readonly eventSource: IEventSource;
  private readonly signalSink: ISignalSink;
  private readonly eventBus?: ISignalEventBus;
  private readonly classifier: SignalClassifier;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly onError?: (err: Error, eventId: string) => void;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(config: SignalProcessorConfig) {
    this.eventSource = config.eventSource;
    this.signalSink = config.signalSink;
    if (config.eventBus !== undefined) { this.eventBus = config.eventBus; }
    this.classifier = config.classifier ?? new SignalClassifier();
    this.batchSize = config.batchSize ?? 50;
    this.pollIntervalMs = config.pollIntervalMs ?? 5000;
    if (config.onError !== undefined) { this.onError = config.onError; }
  }

  /**
   * Start the polling loop. Safe to call multiple times (idempotent).
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  /**
   * Stop the polling loop gracefully.
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Process one batch immediately. Used by workers that are triggered by
   * queue events rather than polling.
   */
  async processOnce(): Promise<ProcessBatchResult> {
    const events = await this.eventSource.getUnprocessed(this.batchSize);

    let processed = 0;
    let skipped = 0;
    let errors = 0;
    const signals: CreatedSignal[] = [];

    for (const event of events) {
      try {
        const input: ClassificationInput = {
          source: event.source,
          eventType: event.eventType,
          payload: event.payload,
          ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
        };

        const classification = this.classifier.classify(input);

        const signal = await this.signalSink.create({
          signalType: classification.signalType,
          sourceEventIds: [event.id],
          summary: classification.summary,
          priority: classification.priority,
          metadata: {
            tags: classification.tags,
            originalSource: event.source,
            originalEventType: event.eventType,
          },
        });

        // Mark processed AFTER successful signal creation
        await this.eventSource.markProcessed(event.id);

        // Publish event (best-effort — failure doesn't roll back)
        if (this.eventBus) {
          await this.eventBus
            .publish("nexus.signals.created", {
              event_id: randomUUID(),
              occurred_at: new Date().toISOString(),
              version: "1.0.0",
              signal_id: signal.id,
              signal_type: signal.signalType,
              priority: signal.priority,
              source_event_ids: signal.sourceEventIds,
            })
            .catch(() => {
              /* best-effort */
            });
        }

        signals.push(signal);
        processed++;
      } catch (err) {
        errors++;
        if (err instanceof Error) {
          this.onError?.(err, event.id);
        }
      }
    }

    // Skipped = batch was smaller than requested (no more events)
    skipped = Math.max(0, this.batchSize - events.length);

    return { processed, skipped, errors, signals };
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.processOnce();
      } catch {
        /* polling errors are logged externally via onError */
      }
      this.scheduleNext();
    }, this.pollIntervalMs);
  }
}

// ── In-memory adapters for tests ──────────────────────────────────────────────

export class MemoryEventSource implements IEventSource {
  private events: (RawEvent & { processed: boolean })[] = [];

  seed(event: RawEvent): void {
    this.events.push({ ...event, processed: false });
  }

  async getUnprocessed(limit: number): Promise<RawEvent[]> {
    return this.events
      .filter((e) => !e.processed)
      .slice(0, limit)
      .map(({ processed: _, ...e }) => e);
  }

  async markProcessed(eventId: string): Promise<void> {
    const e = this.events.find((ev) => ev.id === eventId);
    if (e) e.processed = true;
  }

  getEvent(id: string): (RawEvent & { processed: boolean }) | undefined {
    return this.events.find((e) => e.id === id);
  }
}

export class MemorySignalSink implements ISignalSink {
  readonly signals: CreatedSignal[] = [];

  async create(signal: Omit<CreatedSignal, "id" | "createdAt">): Promise<CreatedSignal> {
    const created: CreatedSignal = { ...signal, id: randomUUID(), createdAt: new Date() };
    this.signals.push(created);
    return created;
  }
}
