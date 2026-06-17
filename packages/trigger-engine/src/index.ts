// SPDX-License-Identifier: Apache-2.0
/**
 * trigger-engine — Automation trigger layer for Nexus.
 *
 * Trigger types:
 *   • DeltaTrigger     — fires when a document field changes
 *   • CronTrigger      — fires on a cron-like schedule
 *   • NLTrigger        — matches events by natural language description keywords
 *   • WebhookTrigger   — fires on incoming webhook events
 *
 * Infrastructure:
 *   • TriggerRegistry  — register / evaluate / list triggers
 *   • TriggerEvent     — the event payload routed to destinations
 *   • Destination      — where fired events are routed (URL / function)
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type TriggerType = "delta" | "cron" | "nl" | "webhook";

/** Trigger status type alias. */
export type TriggerStatus = "active" | "paused" | "disabled";

/** Trigger event interface definition. */
export interface TriggerEvent {
  triggerId: string;
  triggerType: TriggerType;
  firedAt: string;
  payload: Record<string, unknown>;
}

/** Destination fn type alias. */
export type DestinationFn = (event: TriggerEvent) => void | Promise<void>;

/** Destination interface definition. */
export interface Destination {
  type: "function" | "url";
  fn?: DestinationFn;
  url?: string;
}

/** Trigger interface definition. */
export interface Trigger {
  id: string;
  name: string;
  type: TriggerType;
  status: TriggerStatus;
  destinations: Destination[];
  createdAt: string;
  /** Returns true if this trigger should fire for the given context. */
  matches(context: Record<string, unknown>): boolean;
}

// ── ID generation ─────────────────────────────────────────────────────────────

let _counter = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++_counter}`;
}

// ── DeltaTrigger ──────────────────────────────────────────────────────────────

export interface DeltaTriggerConfig {
  name: string;
  /** Document field to watch. Supports dot notation: "meta.status" */
  field: string;
  /** Only fire if new value matches this (string exact or regex). Optional. */
  matchValue?: string | RegExp;
  destinations?: Destination[];
}

/** Delta trigger. */
export class DeltaTrigger implements Trigger {
  readonly id: string;
  readonly name: string;
  readonly type = "delta" as const;
  status: TriggerStatus = "active";
  destinations: Destination[];
  readonly createdAt: string;
  private field: string;
  private matchValue?: string | RegExp;

  constructor(config: DeltaTriggerConfig) {
    this.id = uid("delta");
    this.name = config.name;
    this.field = config.field;
    this.matchValue = config.matchValue;
    this.destinations = config.destinations ?? [];
    this.createdAt = new Date().toISOString();
  }

  matches(context: Record<string, unknown>): boolean {
    if (this.status !== "active") return false;
    const { field, oldValue, newValue } = context as {
      field?: string;
      oldValue?: unknown;
      newValue?: unknown;
    };
    if (field !== this.field) return false;
    if (oldValue === newValue) return false; // no actual change
    if (this.matchValue === undefined) return true;
    const newStr = String(newValue ?? "");
    if (this.matchValue instanceof RegExp) return this.matchValue.test(newStr);
    return newStr === this.matchValue;
  }
}

// ── CronTrigger ───────────────────────────────────────────────────────────────

export interface CronTriggerConfig {
  name: string;
  /** Simplified cron expression. Supported: @hourly, @daily, @weekly, or "HH:MM" */
  schedule: string;
  destinations?: Destination[];
}

function parseCronNextMs(schedule: string, fromMs: number): number {
  if (schedule === "@hourly") return fromMs + 3_600_000;
  if (schedule === "@daily") return fromMs + 86_400_000;
  if (schedule === "@weekly") return fromMs + 604_800_000;
  if (schedule === "@minutely") return fromMs + 60_000;

  // HH:MM format — next occurrence today or tomorrow
  const match = /^(\d{1,2}):(\d{2})$/.exec(schedule);
  if (match) {
    const h = parseInt(match[1]!, 10);
    const m = parseInt(match[2]!, 10);
    const base = new Date(fromMs);
    const candidate = new Date(base);
    candidate.setHours(h, m, 0, 0);
    if (candidate.getTime() <= fromMs) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate.getTime();
  }
  throw new Error(`Unsupported schedule: ${schedule}`);
}

/** Cron trigger. */
export class CronTrigger implements Trigger {
  readonly id: string;
  readonly name: string;
  readonly type = "cron" as const;
  status: TriggerStatus = "active";
  destinations: Destination[];
  readonly createdAt: string;
  readonly schedule: string;
  private lastFiredMs: number;

  constructor(config: CronTriggerConfig) {
    this.id = uid("cron");
    this.name = config.name;
    this.schedule = config.schedule;
    this.destinations = config.destinations ?? [];
    this.createdAt = new Date().toISOString();
    this.lastFiredMs = Date.now();
  }

  matches(context: Record<string, unknown>): boolean {
    if (this.status !== "active") return false;
    const nowMs = (context["nowMs"] as number | undefined) ?? Date.now();
    const nextMs = parseCronNextMs(this.schedule, this.lastFiredMs);
    if (nowMs >= nextMs) {
      this.lastFiredMs = nowMs;
      return true;
    }
    return false;
  }

  /** Force-reset lastFiredMs for testing. */
  _setLastFiredMs(ms: number): void {
    this.lastFiredMs = ms;
  }
}

// ── NLTrigger ─────────────────────────────────────────────────────────────────

export interface NLTriggerConfig {
  name: string;
  /**
   * Natural-language description of what should trigger this.
   * Keywords are extracted and matched against event descriptions.
   */
  description: string;
  destinations?: Destination[];
}

function extractKeywords(text: string): Set<string> {
  const stopWords = new Set([
    "a",
    "an",
    "the",
    "is",
    "are",
    "was",
    "were",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "and",
    "or",
    "when",
    "if",
    "it",
    "this",
    "that",
    "be",
    "has",
    "have",
    "with",
    "as",
  ]);
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w)),
  );
}

/** Nl trigger. */
export class NLTrigger implements Trigger {
  readonly id: string;
  readonly name: string;
  readonly type = "nl" as const;
  status: TriggerStatus = "active";
  destinations: Destination[];
  readonly createdAt: string;
  readonly description: string;
  private keywords: Set<string>;

  constructor(config: NLTriggerConfig) {
    this.id = uid("nl");
    this.name = config.name;
    this.description = config.description;
    this.keywords = extractKeywords(config.description);
    this.destinations = config.destinations ?? [];
    this.createdAt = new Date().toISOString();
  }

  matches(context: Record<string, unknown>): boolean {
    if (this.status !== "active") return false;
    const text = (context["description"] as string | undefined) ?? "";
    if (!text) return false;
    const eventKeywords = extractKeywords(text);
    let matchCount = 0;
    for (const kw of this.keywords) {
      if (eventKeywords.has(kw)) matchCount++;
    }
    // Require at least 30% of trigger keywords to match
    const threshold = Math.max(1, Math.ceil(this.keywords.size * 0.3));
    return matchCount >= threshold;
  }
}

// ── WebhookTrigger ────────────────────────────────────────────────────────────

export interface WebhookTriggerConfig {
  name: string;
  eventType?: string; // e.g. "pull_request.opened"
  secret?: string;
  destinations?: Destination[];
}

/** Webhook trigger. */
export class WebhookTrigger implements Trigger {
  readonly id: string;
  readonly name: string;
  readonly type = "webhook" as const;
  status: TriggerStatus = "active";
  destinations: Destination[];
  readonly createdAt: string;
  private eventType?: string;

  constructor(config: WebhookTriggerConfig) {
    this.id = uid("wh");
    this.name = config.name;
    this.eventType = config.eventType;
    this.destinations = config.destinations ?? [];
    this.createdAt = new Date().toISOString();
  }

  matches(context: Record<string, unknown>): boolean {
    if (this.status !== "active") return false;
    if (!this.eventType) return true; // match all webhook events
    return context["eventType"] === this.eventType;
  }
}

// ── TriggerRegistry ────────────────────────────────────────────────────────────

export interface EvaluateResult {
  trigger: Trigger;
  fired: boolean;
  deliveryResults: DeliveryResult[];
}

/** Delivery result interface definition. */
export interface DeliveryResult {
  destination: Destination;
  success: boolean;
  error?: string;
}

/** Trigger registry. */
export class TriggerRegistry {
  private triggers = new Map<string, Trigger>();

  register(trigger: Trigger): this {
    this.triggers.set(trigger.id, trigger);
    return this;
  }

  get(id: string): Trigger | undefined {
    return this.triggers.get(id);
  }

  deregister(id: string): boolean {
    return this.triggers.delete(id);
  }

  list(type?: TriggerType): Trigger[] {
    const all = [...this.triggers.values()];
    return type ? all.filter((t) => t.type === type) : all;
  }

  count(): number {
    return this.triggers.size;
  }

  /**
   * Evaluate all active triggers against the given context.
   * Fired triggers deliver the event to each destination.
   */
  async evaluate(context: Record<string, unknown>): Promise<EvaluateResult[]> {
    const results: EvaluateResult[] = [];
    for (const trigger of this.triggers.values()) {
      if (trigger.status !== "active") continue;
      const fired = trigger.matches(context);
      const deliveryResults: DeliveryResult[] = [];
      if (fired) {
        const event: TriggerEvent = {
          triggerId: trigger.id,
          triggerType: trigger.type,
          firedAt: new Date().toISOString(),
          payload: context,
        };
        for (const dest of trigger.destinations) {
          deliveryResults.push(await this.deliver(dest, event));
        }
      }
      results.push({ trigger, fired, deliveryResults });
    }
    return results;
  }

  private async deliver(dest: Destination, event: TriggerEvent): Promise<DeliveryResult> {
    try {
      if (dest.type === "function" && dest.fn) {
        await dest.fn(event);
        return { destination: dest, success: true };
      }
      if (dest.type === "url" && dest.url) {
        // In production this would do a fetch POST; here we just acknowledge
        return { destination: dest, success: true };
      }
      return { destination: dest, success: false, error: "No handler configured" };
    } catch (err) {
      return {
        destination: dest,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ── Remote function / trigger primitives (from iii SDK) ───────────────────────
//
// Extracted from iii-hq/iii iii-browser SDK. These complement the local
// trigger matching above with a remote invocation layer: functions are
// registered with an engine (over WebSocket or HTTP), triggers bind to them,
// and callers invoke them via `trigger()` with sync/async/void/enqueue actions.
//
// ISdk               — full engine SDK interface
// RemoteFunctionHandler — typed async function handler
// TriggerHandler<T>  — pluggable trigger-type lifecycle (register/unregister)
// TriggerConfig<T>   — config passed to TriggerHandler on lifecycle events
// TriggerTypeRef<T>  — typed handle for a registered trigger type
// FunctionRef        — handle for a registered function (id + unregister)
// ApiRequest<TBody>  — structured HTTP trigger request payload
// ApiResponse<S,B>   — structured HTTP trigger response

/**
 * Typed async handler for a remotely-registered function.
 *
 * @typeParam TInput  – Invocation payload type.
 * @typeParam TOutput – Return value type.
 *
 * @example
 * ```ts
 * const greet: RemoteFunctionHandler<{ name: string }, { message: string }> =
 *   async (data) => ({ message: `Hello, ${data.name}!` });
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RemoteFunctionHandler<TInput = any, TOutput = any> = (
  data: TInput,
) => Promise<TOutput>;

/**
 * Configuration passed to a TriggerHandler on register/unregister lifecycle events.
 *
 * @typeParam TConfig – Trigger-specific configuration shape.
 */
export type TriggerConfig<TConfig> = {
  /** Trigger instance ID. */
  id: string;
  /** ID of the function to invoke when the trigger fires. */
  function_id: string;
  /** Trigger-specific configuration. */
  config: TConfig;
};

/**
 * Handler interface for pluggable trigger types.
 * Implement this to define how a custom trigger type registers and
 * unregisters instances (e.g. cron scheduler, webhook subscription).
 *
 * @typeParam TConfig – Trigger-specific configuration shape.
 *
 * @example
 * ```ts
 * const cronHandler: TriggerHandler<{ expression: string }> = {
 *   async registerTrigger({ id, function_id, config }) {
 *     startCronJob(id, config.expression, () => sdk.trigger({ function_id, payload: {} }));
 *   },
 *   async unregisterTrigger({ id }) {
 *     stopCronJob(id);
 *   },
 * };
 * ```
 */
export type TriggerHandler<TConfig> = {
  registerTrigger(config: TriggerConfig<TConfig>): Promise<void>;
  unregisterTrigger(config: TriggerConfig<TConfig>): Promise<void>;
};

/**
 * Typed handle returned when registering a trigger type.
 * Provides convenience methods scoped to the type so callers don't repeat `type`.
 *
 * @typeParam TConfig – Trigger-specific configuration shape.
 */
export type TriggerTypeRef<TConfig = unknown> = {
  /** Trigger type identifier. */
  id: string;
  /** Register a trigger bound to this trigger type. */
  registerTrigger(functionId: string, config: TConfig): RemoteTrigger;
  /** Register a function and immediately bind it to this trigger type. */
  registerFunction(
    functionId: string,
    handler: RemoteFunctionHandler,
    config: TConfig,
  ): FunctionRef;
  /** Unregister this trigger type from the engine. */
  unregister(): void;
};

/** Handle returned when registering a remote trigger. */
export type RemoteTrigger = {
  /** Remove this trigger from the engine. */
  unregister(): void;
};

/** Handle returned when registering a remote function. */
export type FunctionRef = {
  /** Unique function identifier. */
  id: string;
  /** Remove this function from the engine. */
  unregister(): void;
};

/**
 * Structured HTTP request received by a function registered with an HTTP trigger.
 *
 * @typeParam TBody – Parsed request body type.
 */
export type ApiRequest<TBody = unknown> = {
  path_params: Record<string, string>;
  query_params: Record<string, string | string[]>;
  body: TBody;
  headers: Record<string, string | string[]>;
  method: string;
};

/**
 * Structured HTTP response returned from HTTP function handlers.
 *
 * @typeParam TStatus – HTTP status code literal type.
 * @typeParam TBody   – Response body type.
 *
 * @example
 * ```ts
 * const res: ApiResponse = { status_code: 200, body: { ok: true } };
 * ```
 */
export type ApiResponse<
  TStatus extends number = number,
  TBody = string | Record<string, unknown>,
> = {
  status_code: TStatus;
  headers?: Record<string, string>;
  body?: TBody;
};

/**
 * Full SDK interface for an iii-style function/trigger engine.
 * Implement against any engine backend (WebSocket, HTTP, in-process).
 */
export interface ISdk {
  /** Register a function with a local handler. */
  registerFunction(
    functionId: string,
    handler: RemoteFunctionHandler,
    options?: Omit<{ id: string; description?: string }, 'id'>,
  ): FunctionRef;
  /** Register a trigger instance against a registered trigger type. */
  registerTrigger(trigger: {
    type: string;
    function_id: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: any;
  }): RemoteTrigger;
  /** Register a custom trigger type. */
  registerTriggerType<TConfig>(
    triggerType: { id: string; description?: string },
    handler: TriggerHandler<TConfig>,
  ): TriggerTypeRef<TConfig>;
  /** Unregister a trigger type. */
  unregisterTriggerType(triggerType: { id: string }): void;
  /** Invoke a function and return its result. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trigger<TInput, TOutput>(request: {
    function_id: string;
    payload: TInput;
    timeoutMs?: number;
  }): Promise<TOutput>;
  /** Subscribe to engine connection-state transitions. Returns an unsubscribe fn. */
  addConnectionStateListener(
    handler: (state: 'connecting' | 'connected' | 'disconnected' | 'error') => void,
  ): () => void;
  /** Gracefully shut down the engine connection. */
  shutdown(): Promise<void>;
}

// ── InvocationError + isErrorBody (from iii SDK) ─────────────────────────────
//
// Typed error class for SDK function invocations. Wraps engine rejection
// payloads (RBAC, handler failure, timeout) into a self-describing class
// with a stable `code` field — callers no longer get `[object Object]`.

export interface InvocationErrorInit {
  code: string;
  message: string;
  functionId?: string;
  stacktrace?: string;
}

/**
 * Typed error for failed SDK function invocations.
 * Disambiguate via `err.code` (e.g. "FORBIDDEN", "TIMEOUT", "HANDLER_ERROR").
 */
export class InvocationError extends Error {
  readonly code: string;
  readonly functionId?: string;
  readonly stacktrace?: string;

  constructor(init: InvocationErrorInit) {
    super(`${init.code}: ${init.message}`);
    this.name = "InvocationError";
    this.code = init.code;
    this.functionId = init.functionId;
    this.stacktrace = init.stacktrace;
  }
}

/**
 * Type guard for the wire `ErrorBody` the engine sends in invocation results.
 * Distinguishes engine rejections from JS `Error` instances thrown elsewhere.
 *
 * @example
 * ```ts
 * try { await sdk.trigger(...) } catch (err) {
 *   if (isErrorBody(err)) console.error(err.code, err.message);
 * }
 * ```
 */
export function isErrorBody(value: unknown): value is {
  code: string;
  message: string;
  stacktrace?: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { code?: unknown; message?: unknown; stacktrace?: unknown };
  return (
    typeof v.code === "string" &&
    typeof v.message === "string" &&
    (v.stacktrace === undefined || typeof v.stacktrace === "string")
  );
}
