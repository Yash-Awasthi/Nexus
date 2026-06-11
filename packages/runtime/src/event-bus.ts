import { IEventStore } from "./interfaces/event-store.interface";
export { IEventStore };
import { ILogger } from "./interfaces/logger.interface";

export interface EventSubscription {
  unsubscribe(): void;
}

export interface SequenceGap {
  expectedSequence: number;
  missingSequenceNumbers: number[];
}

export interface CausalValidationReport {
  totalEvents: number;
  eventsWithCauses: number;
  missingCauseEvents: string[];
  orphanChains: number;
  cycleDetected: boolean;
  valid: boolean;
}

export interface EventBusConfig {
  /** Max events retained in the in-memory history ring buffer (default 10000). */
  maxHistorySize?: number;
  /** Optional event store for write-before-dispatch persistence. */
  eventStore?: IEventStore;
  /** Optional filter: only persist events whose name passes this predicate. */
  persistFilter?: (event: string) => boolean;
  /** Optional logger — replaces raw console calls with structured output. */
  logger?: ILogger;
}

export interface IEventBus {
  publish(event: string, payload: any, options?: { causeEventId?: string; dedupKey?: string }): Promise<void>;
  subscribe(event: string, handler: (payload: any) => void | Promise<void>): EventSubscription;
  getActiveSubscriptionCount(): number;
  getDeduplicationCount(): number;
  /** Compact dedup window and return cleanup stats. */
  compact(): { dedupKeysCleared: number };
  /** Full event bus diagnostics. */
  getStats(): EventBusStats;
  /** Return the most recent N events from the history ring buffer for replay/verification. */
  getHistory(count?: number): EventEnvelope[];
  /** Detect missing sequence numbers in history. */
  getOrderingGaps(): SequenceGap[];
  /** Validate causal lineage integrity: orphan detection, missing causes, cycles. */
  validateCausalChains(): CausalValidationReport;
  /** Return all history events since a given timestamp for replay. */
  replayEvents(since: Date): EventEnvelope[];
  /** Compact the event history ring buffer to a given max age (in ms). */
  compactHistory(maxAgeMs: number): { prunedCount: number };
}

export interface EventBusStats {
  activeSubscriptions: number;
  pendingHandlers: number;
  dedupCount: number;
  backpressureCount: number;
  backpressureTotalWaitMs: number;
  sequenceCounter: number;
  dedupKeysInWindow: number;
  historySize: number;
  persistedEventCount: number;
}

export interface EventEnvelope {
  eventId: string;
  event: string;
  payload: any;
  timestamp: string;
  sequenceNumber: number;
  causeChain?: string[];
  dedupKey?: string;
}

export class LocalEventBus implements IEventBus {
  private handlers = new Map<string, Set<(payload: any) => void | Promise<void>>>();
  private eventCounter = 0;
  private sequenceCounter = 0;
  private recentDedupKeys = new Set<string>();
  private readonly MAX_PENDING = 100;
  private readonly DEDUP_WINDOW_MS = 5000;
  private subscriptionCount = 0;
  private dedupCount = 0;
  private backpressureCount = 0;
  private backpressureTotalWaitMs = 0;
  private pendingCount = 0;

  /** Bounded history ring buffer — preserves event order for replay verification. */
  private history: EventEnvelope[] = [];
  private readonly maxHistorySize: number;

  /** Optional event store for durable write-before-dispatch semantics. */
  private readonly eventStore?: IEventStore;
  private readonly persistFilter?: (event: string) => boolean;
  private persistedEventCount = 0;
  private readonly logger?: ILogger;

  constructor(config?: EventBusConfig) {
    this.maxHistorySize = config?.maxHistorySize ?? 10000;
    this.eventStore = config?.eventStore;
    this.persistFilter = config?.persistFilter;
    this.logger = config?.logger;
  }

  async publish(
    event: string,
    payload: any,
    options?: { causeEventId?: string; dedupKey?: string }
  ): Promise<void> {
    // ── Backpressure: wait if too many pending ────────────────────────
    const maxWaitMs = 5000;
    const pollInterval = 10;
    let waited = 0;
    while (this.pendingCount >= this.MAX_PENDING && waited < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollInterval));
      waited += pollInterval;
    }
    if (this.pendingCount >= this.MAX_PENDING) {
      this.backpressureCount++;
      this.backpressureTotalWaitMs += waited;
      const bpMsg = `[EventBus] Backpressure threshold exceeded for event: ${event}. Dropping (pending=${this.pendingCount}, wait=${waited}ms, totalDrops=${this.backpressureCount}).`;
      if (this.logger) { this.logger.warn(bpMsg); } else { console.error(bpMsg); }
      return;
    }
    if (waited > 0) {
      this.backpressureCount++;
      this.backpressureTotalWaitMs += waited;
    }

    // ── Deduplication ────────────────────────────────────────────────
    if (options?.dedupKey) {
      if (this.recentDedupKeys.has(options.dedupKey)) {
        this.dedupCount++;
        return; // Silent dedup — event already processed
      }
      this.recentDedupKeys.add(options.dedupKey);
      // Prune dedup keys after the dedup window
      setTimeout(() => this.recentDedupKeys.delete(options.dedupKey!), this.DEDUP_WINDOW_MS).unref();
    }

    // ── Causal Chain & Sequence ──────────────────────────────────────
    this.eventCounter++;
    this.sequenceCounter++;
    const eventId = `evt-${Date.now()}-${this.eventCounter}`;
    const previousIds: string[] = [];
    if (options?.causeEventId) {
      previousIds.push(options.causeEventId);
    }

    const envelope: EventEnvelope = {
      eventId,
      event,
      payload,
      timestamp: new Date().toISOString(),
      sequenceNumber: this.sequenceCounter,
      causeChain: previousIds.length > 0 ? previousIds : undefined,
      dedupKey: options?.dedupKey
    };

    // ── Durable persistence (write-before-dispatch) ──────────────────
    // Pass the raw envelope object — the IEventStore implementation handles serialization
    // (e.g. FileEventStore wraps it in {event, payload, timestamp} and writes JSONL).
    if (this.eventStore && (!this.persistFilter || this.persistFilter(event))) {
      try {
        await this.eventStore.saveEvent(event, envelope);
        this.persistedEventCount++;
      } catch (err) {
        if (this.logger) {
          this.logger.error(`[EventBus] Failed to persist event ${eventId}`, err);
        } else {
          console.error(`[EventBus] Failed to persist event ${eventId}:`, err);
        }
      }
    }

    // ── History ring buffer ──────────────────────────────────────────
    this.history.push(envelope);
    if (this.history.length > this.maxHistorySize) {
      // Prune oldest entries — keep the most recent maxHistorySize
      this.history.splice(0, this.history.length - this.maxHistorySize);
    }

    // ── Dispatch to handlers ─────────────────────────────────────────
    const promises: Promise<void>[] = [];
    this.pendingCount++;

    // Exact-match handlers — receive raw payload (backward compatible)
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      for (const handler of eventHandlers) {
        promises.push(
          (async () => {
            try {
              await handler(payload);
            } catch (err) {
              if (this.logger) {
                this.logger.error(`[EventBus] Error in handler for ${event}`, err);
              } else {
                console.error(`[EventBus] Error in handler for ${event}:`, err);
              }
            }
          })()
        );
      }
    }

    // Wildcard ("*") handlers — receive full envelope with event metadata
    const wildcardHandlers = this.handlers.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        promises.push(
          (async () => {
            try {
              await handler(envelope);
            } catch (err) {
              if (this.logger) {
                this.logger.error(`[EventBus] Error in wildcard handler for ${event}`, err);
              } else {
                console.error(`[EventBus] Error in wildcard handler for ${event}:`, err);
              }
            }
          })()
        );
      }
    }

    await Promise.all(promises);
    this.pendingCount--;
  }

  subscribe(event: string, handler: (payload: any) => void | Promise<void>): EventSubscription {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    this.subscriptionCount++;

    return {
      unsubscribe: () => {
        const eventHandlers = this.handlers.get(event);
        if (eventHandlers) {
          eventHandlers.delete(handler);
          if (eventHandlers.size === 0) {
            this.handlers.delete(event);
          }
        }
        this.subscriptionCount--;
      }
    };
  }

  /** Return the last N events from the history ring buffer. */
  getHistory(count?: number): EventEnvelope[] {
    if (count === undefined || count >= this.history.length) {
      return [...this.history];
    }
    return this.history.slice(-count);
  }

  /** Return all history events since a given timestamp for replay. */
  replayEvents(since: Date): EventEnvelope[] {
    return this.history.filter(
      (e) => new Date(e.timestamp).getTime() >= since.getTime()
    );
  }

  /**
   * Detect missing sequence numbers in history.
   * Reports gaps where the expected sequential increment was skipped.
   */
  getOrderingGaps(): SequenceGap[] {
    if (this.history.length < 2) return [];

    const gaps: SequenceGap[] = [];
    const sorted = [...this.history].sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1].sequenceNumber;
      const curr = sorted[i].sequenceNumber;

      if (curr - prev > 1) {
        const missing: number[] = [];
        for (let n = prev + 1; n < curr; n++) {
          missing.push(n);
        }
        gaps.push({
          expectedSequence: curr,
          missingSequenceNumbers: missing
        });
      }
    }

    return gaps;
  }

  /**
   * Validate causal lineage integrity.
   * Checks every event with a causeChain for:
   *   - Missing cause event IDs (the cause doesn't exist in history)
   *   - Orphan chains (cause chain starts with an unknown event)
   *   - Cycles (an event causes itself — defensive check)
   */
  validateCausalChains(): CausalValidationReport {
    const eventIds = new Set(this.history.map((e) => e.eventId));
    const missingCauseEvents: string[] = [];
    let eventsWithCauses = 0;
    let orphanChains = 0;
    const visited = new Set<string>();

    for (const event of this.history) {
      if (!event.causeChain || event.causeChain.length === 0) continue;

      eventsWithCauses++;

      // Check for cycles
      if (event.causeChain.includes(event.eventId)) {
        return {
          totalEvents: this.history.length,
          eventsWithCauses,
          missingCauseEvents: [event.eventId],
          orphanChains,
          cycleDetected: true,
          valid: false
        };
      }

      // Check each cause in the chain
      let allPresent = true;
      for (const causeId of event.causeChain) {
        if (!eventIds.has(causeId)) {
          missingCauseEvents.push(causeId);
          allPresent = false;
        }
      }

      if (!allPresent && !visited.has(event.eventId)) {
        orphanChains++;
        visited.add(event.eventId);
      }
    }

    return {
      totalEvents: this.history.length,
      eventsWithCauses,
      missingCauseEvents: [...new Set(missingCauseEvents)],
      orphanChains,
      cycleDetected: false,
      valid: missingCauseEvents.length === 0
    };
  }

  /**
   * Compact the dedup window and history buffer.
   * Returns the number of dedup keys and stale history entries cleared.
   */
  compact(): { dedupKeysCleared: number } {
    const cleared = this.recentDedupKeys.size;
    this.recentDedupKeys.clear();
    if (cleared > 0) {
      const msg = `[EventBus] Compacted ${cleared} dedup key(s)`;
      if (this.logger) { this.logger.info(msg); } else { console.log(msg); }
    }
    return { dedupKeysCleared: cleared };
  }

  /** Compact the event history ring buffer to a given max age (in ms). */
  compactHistory(maxAgeMs: number): { prunedCount: number } {
    const cutoff = Date.now() - maxAgeMs;
    const before = this.history.length;
    this.history = this.history.filter(
      (e) => new Date(e.timestamp).getTime() >= cutoff
    );
    const pruned = before - this.history.length;
    if (pruned > 0) {
      const msg = `[EventBus] Compacted history: pruned ${pruned} event(s) older than ${maxAgeMs}ms`;
      if (this.logger) { this.logger.info(msg); } else { console.log(msg); }
    }
    return { prunedCount: pruned };
  }

  getStats(): EventBusStats {
    return {
      activeSubscriptions: this.subscriptionCount,
      pendingHandlers: this.pendingCount,
      dedupCount: this.dedupCount,
      backpressureCount: this.backpressureCount,
      backpressureTotalWaitMs: this.backpressureTotalWaitMs,
      sequenceCounter: this.sequenceCounter,
      dedupKeysInWindow: this.recentDedupKeys.size,
      historySize: this.history.length,
      persistedEventCount: this.persistedEventCount
    };
  }

  getActiveSubscriptionCount(): number {
    return this.subscriptionCount;
  }

  getDeduplicationCount(): number {
    return this.dedupCount;
  }
}

// Backward-compatible alias — consumers that `import { EventBus }` continue to work.
export { LocalEventBus as EventBus };
