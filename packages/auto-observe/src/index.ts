// SPDX-License-Identifier: Apache-2.0

// ── Types ─────────────────────────────────────────────────────────────────────

export type ObservationEventType =
  | "llm.request"
  | "llm.response"
  | "llm.error"
  | "tool.call"
  | "tool.result"
  | "tool.error"
  | "agent.start"
  | "agent.step"
  | "agent.end"
  | "agent.error"
  | "memory.read"
  | "memory.write"
  | (string & {}); // open union

export interface ObservationEvent<T = unknown> {
  id: string;
  type: ObservationEventType;
  /** Which component emitted this (e.g. "llm-router", "agent:task-42"). */
  source: string;
  data: T;
  /** Unix timestamp in ms. */
  timestamp: number;
  /** Optional key-value metadata. */
  tags?: Record<string, string>;
}

export type ObserverFn<T = unknown> = (event: ObservationEvent<T>) => void | Promise<void>;

// ── ObservationBus ────────────────────────────────────────────────────────────

/** Lightweight pub/sub bus. Subscribe to a specific event type or "*" for all. */
export class ObservationBus {
  private readonly _listeners = new Map<string, Set<ObserverFn<unknown>>>();

  /**
   * Register a listener for `type` or `"*"` (all events).
   * @returns Unsubscribe function.
   */
  on<T = unknown>(type: string, fn: ObserverFn<T>): () => void {
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add(fn as ObserverFn<unknown>);
    return () => {
      this._listeners.get(type)?.delete(fn as ObserverFn<unknown>);
    };
  }

  async emit<T = unknown>(event: ObservationEvent<T>): Promise<void> {
    const typed = this._listeners.get(event.type);
    const wildcard = this._listeners.get("*");
    const fns = [
      ...(typed ? Array.from(typed) : []),
      ...(wildcard ? Array.from(wildcard) : []),
    ];
    await Promise.all(fns.map((fn) => fn(event)));
  }

  listenerCount(type: string): number {
    return this._listeners.get(type)?.size ?? 0;
  }

  removeAll(type?: string): void {
    if (type) {
      this._listeners.delete(type);
    } else {
      this._listeners.clear();
    }
  }
}

// ── ObservationStore ──────────────────────────────────────────────────────────

export interface ObservationQuery {
  type?: string;
  source?: string;
  since?: number;
  until?: number;
  limit?: number;
  tags?: Record<string, string>;
}

/** In-memory observation store with FIFO eviction. */
export class ObservationStore {
  private _events: ObservationEvent[] = [];

  constructor(private readonly maxSize = 10_000) {}

  record(event: ObservationEvent): void {
    this._events.push(event);
    if (this._events.length > this.maxSize) {
      this._events.splice(0, this._events.length - this.maxSize);
    }
  }

  query(filter: ObservationQuery = {}): ObservationEvent[] {
    let results = this._events;

    if (filter.type) {
      results = results.filter((e) => e.type === filter.type);
    }
    if (filter.source) {
      results = results.filter((e) => e.source === filter.source);
    }
    if (filter.since !== undefined) {
      results = results.filter((e) => e.timestamp >= filter.since!);
    }
    if (filter.until !== undefined) {
      results = results.filter((e) => e.timestamp <= filter.until!);
    }
    if (filter.tags) {
      const filterTags = filter.tags;
      results = results.filter((e) => {
        if (!e.tags) return false;
        return Object.entries(filterTags).every(([k, v]) => e.tags![k] === v);
      });
    }
    if (filter.limit !== undefined) {
      results = results.slice(-filter.limit);
    }

    return results;
  }

  /** Most recent event matching filter, or undefined. */
  latest(filter: ObservationQuery = {}): ObservationEvent | undefined {
    const results = this.query(filter);
    return results[results.length - 1];
  }

  clear(): void {
    this._events = [];
  }

  size(): number {
    return this._events.length;
  }

  all(): ReadonlyArray<ObservationEvent> {
    return this._events;
  }
}

// ── AutoObserver ──────────────────────────────────────────────────────────────

let _idCounter = 0;

function genId(): string {
  return `obs_${Date.now()}_${(_idCounter++).toString(36)}`;
}

/**
 * Combines ObservationBus + ObservationStore.
 * Every emitted event is automatically recorded in the store.
 */
export class AutoObserver {
  readonly bus: ObservationBus;
  readonly store: ObservationStore;

  constructor(opts: { bus?: ObservationBus; store?: ObservationStore; maxStoreSize?: number } = {}) {
    this.bus = opts.bus ?? new ObservationBus();
    this.store = opts.store ?? new ObservationStore(opts.maxStoreSize);
    // Auto-record all emitted events
    this.bus.on("*", (event) => this.store.record(event));
  }

  /** Emit an event — it is auto-recorded in the store and dispatched to all listeners. */
  async emit<T = unknown>(
    type: ObservationEventType,
    source: string,
    data: T,
    opts?: { id?: string; tags?: Record<string, string> },
  ): Promise<ObservationEvent<T>> {
    const event: ObservationEvent<T> = {
      id: opts?.id ?? genId(),
      type,
      source,
      data,
      timestamp: Date.now(),
      tags: opts?.tags,
    };
    await this.bus.emit(event);
    return event;
  }

  on<T = unknown>(type: string, fn: ObserverFn<T>): () => void {
    return this.bus.on(type, fn);
  }

  query(filter?: ObservationQuery): ObservationEvent[] {
    return this.store.query(filter);
  }

  latest(filter?: ObservationQuery): ObservationEvent | undefined {
    return this.store.latest(filter);
  }

  clear(): void {
    this.store.clear();
  }
}

// ── LLM types (minimal, injectable) ──────────────────────────────────────────

export interface LLMMessage {
  role: string;
  content: string;
}

export interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  [key: string]: unknown;
}

export interface LLMResponse {
  id: string;
  model: string;
  content: string;
  provider: string;
  latencyMs?: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export interface LLMProvider {
  name: string;
  models: string[];
  complete(req: LLMRequest): Promise<LLMResponse>;
}

// ── ObservingLLMProvider ──────────────────────────────────────────────────────

/** LLMProvider decorator that emits llm.request / llm.response / llm.error observations. */
export class ObservingLLMProvider implements LLMProvider {
  constructor(
    private readonly inner: LLMProvider,
    private readonly observer: AutoObserver,
    private readonly source?: string,
  ) {}

  get name(): string {
    return `observed(${this.inner.name})`;
  }

  get models(): string[] {
    return this.inner.models;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const src = this.source ?? this.inner.name;
    await this.observer.emit("llm.request", src, { model: req.model, messageCount: req.messages.length });

    const t0 = Date.now();
    try {
      const res = await this.inner.complete(req);
      await this.observer.emit("llm.response", src, {
        model: res.model,
        latencyMs: Date.now() - t0,
        usage: res.usage,
      });
      return res;
    } catch (err) {
      await this.observer.emit("llm.error", src, {
        model: req.model,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

// ── ObservationError ──────────────────────────────────────────────────────────

export class ObservationError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ObservationError";
    this.code = code;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function makeAutoObserver(opts: { maxStoreSize?: number } = {}): AutoObserver {
  return new AutoObserver(opts);
}
