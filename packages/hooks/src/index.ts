// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/hooks — typed plugin and hook system.
 *
 * Allows external tools, agents, and plugins to extend platform behaviour
 * at well-defined lifecycle points without modifying core packages.
 *
 * Lifecycle hooks:
 *   session.init / session.end   — session lifecycle
 *   task.before / task.after / task.error  — task execution lifecycle
 *   memory.before_write / memory.after_write — memory persistence
 *   agent.observe                — structured agent observation events
 *   file.before_edit / file.after_edit — file operation lifecycle
 *
 * Dispatch model:
 *   • Handlers run sequentially in descending priority order (higher first).
 *   • before/after ordering constraints refine position within priority tier.
 *   • A handler returning { abort: true } stops the remaining chain and
 *     triggers registered compensation handlers in reverse registration order.
 *   • Each handler may declare a timeoutMs after which it is force-cancelled.
 *   • Handler errors are collected and returned in EmitResult — one bad
 *     handler never prevents the rest from running.
 *
 * Persistence:
 *   • Inject a HookStore to persist handler metadata (label / event / priority).
 *   • Call registry.rehydrate(namedHandlers) on startup to re-register
 *     persisted handlers by matching stored labels to live handler functions.
 *
 * Plugin bundles:
 *   • A Plugin is a named object with an install() that registers hooks.
 *   • install() receives the registry — plugins can also call .on() themselves.
 *   • uninstall() (optional) is called by HookRegistry.unuse() and must
 *     call registry.off() for any registrations it wants to clean up.
 *
 * Usage:
 * ```ts
 * import { globalHooks } from "@nexus/hooks";
 *
 * globalHooks.on("task.before", async ({ taskId, taskType }) => {
 *   console.log("starting", taskType, taskId);
 * }, { priority: 10, label: "logger", timeoutMs: 2000 });
 *
 * await globalHooks.emit("task.before", { taskId: "t1", taskType: "doc.ingest", payload: {}, attempt: 1 });
 * ```
 */

import { randomUUID } from "node:crypto";

// ── Hook event payloads ───────────────────────────────────────────────────────

export interface SessionInitPayload {
  sessionId: string;
  startedAt: number;
  metadata?: Record<string, unknown>;
}

export interface SessionEndPayload {
  sessionId: string;
  endedAt: number;
  durationMs: number;
}

export interface TaskBeforePayload {
  taskId: string;
  taskType: string;
  payload: unknown;
  attempt: number;
}

export interface TaskAfterPayload {
  taskId: string;
  taskType: string;
  result: unknown;
  durationMs: number;
}

export interface TaskErrorPayload {
  taskId: string;
  taskType: string;
  error: string;
  attempt: number;
  willRetry: boolean;
}

export interface MemoryBeforeWritePayload {
  text: string;
  metadata: Record<string, unknown>;
}

export interface MemoryAfterWritePayload {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface AgentObservePayload {
  agentId: string;
  /** Dot-notation observation label e.g. "tool.call", "reasoning.step" */
  event: string;
  data: unknown;
}

export interface FileBeforeEditPayload {
  path: string;
  operation: "create" | "update" | "delete";
}

export interface FileAfterEditPayload {
  path: string;
  operation: "create" | "update" | "delete";
  success: boolean;
  /** Error message if success=false */
  error?: string;
}

// ── Hook event map ────────────────────────────────────────────────────────────

export interface HookEventMap {
  "session.init": SessionInitPayload;
  "session.end": SessionEndPayload;
  "task.before": TaskBeforePayload;
  "task.after": TaskAfterPayload;
  "task.error": TaskErrorPayload;
  "memory.before_write": MemoryBeforeWritePayload;
  "memory.after_write": MemoryAfterWritePayload;
  "agent.observe": AgentObservePayload;
  "file.before_edit": FileBeforeEditPayload;
  "file.after_edit": FileAfterEditPayload;
}

export type HookEvent = keyof HookEventMap;

// ── Handler contract ──────────────────────────────────────────────────────────

export interface HookResult {
  /**
   * When true, stops dispatch — no further handlers for this emit run.
   * Triggers any registered compensation handlers.
   * Use sparingly; most hooks should not abort the chain.
   */
  abort?: boolean;
}

export type HookHandler<T> = (
  payload: T,
) => Promise<HookResult | void> | HookResult | void;

// ── Registration handle ───────────────────────────────────────────────────────

export interface HookRegistration {
  readonly id: string;
  readonly event: HookEvent;
  readonly priority: number;
  readonly label?: string;
}

export interface HookOptions {
  /**
   * Handlers with higher priority run before those with lower priority.
   * Ties are broken by insertion order (FIFO).
   * Default: 0.
   */
  priority?: number;
  /** Human-readable label for debug output and ordering declarations */
  label?: string;
  /**
   * This handler must run before the handler whose label matches this value.
   * Applied within the same priority tier.
   */
  before?: string;
  /**
   * This handler must run after the handler whose label matches this value.
   * Applied within the same priority tier.
   */
  after?: string;
  /**
   * Maximum milliseconds this handler may run before it is considered timed
   * out.  A timeout is recorded as an error in EmitResult.errors.
   * Default: no timeout.
   */
  timeoutMs?: number;
  /**
   * When true, this handler is a compensation handler.
   * Compensation handlers run in reverse registration order when a prior
   * handler aborts the chain (returns { abort: true }).
   * Compensation handlers themselves cannot abort.
   */
  compensate?: boolean;
  /**
   * When true and a HookStore is configured, the handler metadata (label,
   * event, priority, timeoutMs) is persisted so it can be rehydrated after
   * a process restart.
   */
  persist?: boolean;
}

// ── Emit result ───────────────────────────────────────────────────────────────

export interface HandlerError {
  handlerId: string;
  label?: string;
  error: string;
}

export interface EmitResult {
  /** Event that was emitted */
  event: HookEvent;
  /** Number of normal handlers that executed (including aborted) */
  handled: number;
  /** True if a handler returned { abort: true } */
  aborted: boolean;
  /** Number of compensation handlers that ran after abort */
  compensationsRan: number;
  /** Errors thrown by individual handlers (collected, not re-thrown) */
  errors: HandlerError[];
}

// ── Persistence store interface ───────────────────────────────────────────────

export interface StoredHandler {
  id: string;
  event: HookEvent;
  label: string;
  priority: number;
  timeoutMs?: number;
  createdAt: number;
}

/**
 * Minimal persistence interface for HookRegistry.
 * Implement this to survive process restarts (e.g. in-memory, Redis, SQLite).
 */
export interface HookStore {
  save(entry: StoredHandler): Promise<void>;
  delete(id: string): Promise<void>;
  loadAll(): Promise<StoredHandler[]>;
}

/** In-memory HookStore — for testing and single-process use. */
export class MemoryHookStore implements HookStore {
  private readonly store = new Map<string, StoredHandler>();

  async save(entry: StoredHandler): Promise<void> {
    this.store.set(entry.id, { ...entry });
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  async loadAll(): Promise<StoredHandler[]> {
    return Array.from(this.store.values());
  }
}

// ── Plugin interface ──────────────────────────────────────────────────────────

export interface Plugin {
  /** Unique plugin identifier */
  readonly name: string;
  /** SemVer string */
  readonly version: string;
  readonly description?: string;
  /**
   * Called by HookRegistry.use().
   * Register all hooks here via registry.on().
   */
  install(registry: HookRegistry): void;
  /**
   * Called by HookRegistry.unuse().
   * Clean up hook registrations via registry.off().
   * Optional — if omitted, unuse() only removes the plugin record but
   * does NOT remove its registered handlers.
   */
  uninstall?(registry: HookRegistry): void;
}

// ── Internal handler record ───────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface HandlerRecord<T = any> {
  id: string;
  event: HookEvent;
  priority: number;
  label?: string;
  before?: string;
  after?: string;
  timeoutMs?: number;
  compensate: boolean;
  handler: HookHandler<T>;
  insertionOrder: number;
}

// ── Topological sort helper ───────────────────────────────────────────────────

/**
 * Given a list of handlers already sorted by (priority DESC, insertionOrder ASC),
 * apply before/after ordering constraints using a stable topological sort.
 * Cycles are silently ignored (the original order is preserved for cyclic pairs).
 */
function applyOrderingConstraints(handlers: HandlerRecord[]): HandlerRecord[] {
  // Build label→record map (last registration wins for duplicates)
  const labelMap = new Map<string, HandlerRecord>();
  for (const h of handlers) {
    if (h.label) labelMap.set(h.label, h);
  }

  // Build adjacency list: mustBefore[i] = set of indices that must come after i
  const n = handlers.length;
  const indexMap = new Map(handlers.map((h, i) => [h.id, i]));
  const before = new Array<Set<number>>(n).fill(null as unknown as Set<number>).map(() => new Set<number>());

  for (let i = 0; i < n; i++) {
    const h = handlers[i]!;
    if (h.before) {
      const target = labelMap.get(h.before);
      if (target) {
        const j = indexMap.get(target.id);
        if (j !== undefined && j !== i) before[i]!.add(j); // i must come before j
      }
    }
    if (h.after) {
      const source = labelMap.get(h.after);
      if (source) {
        const j = indexMap.get(source.id);
        if (j !== undefined && j !== i) before[j]!.add(i); // j must come before i
      }
    }
  }

  // Kahn's algorithm for topological sort; falls back to priority order on tie
  const inDegree = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (const j of before[i]!) inDegree[j] = (inDegree[j] ?? 0) + 1;
  }

  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }
  // Sort queue by original (priority) order for stable output
  queue.sort((a, b) => a - b);

  const result: HandlerRecord[] = [];
  while (queue.length > 0) {
    const i = queue.shift()!;
    result.push(handlers[i]!);
    const dependents = Array.from(before[i]!).sort((a, b) => a - b);
    for (const j of dependents) {
      if (--inDegree[j]! === 0) {
        queue.push(j);
        queue.sort((a, b) => a - b);
      }
    }
  }

  // If cycle detected (result.length < n), append remaining in original order
  if (result.length < n) {
    const seen = new Set(result.map((h) => h.id));
    for (const h of handlers) {
      if (!seen.has(h.id)) result.push(h);
    }
  }

  return result;
}

// ── HookRegistry ──────────────────────────────────────────────────────────────

export interface HookRegistryOptions {
  /**
   * Optional persistence store.  When provided, handlers registered with
   * `persist: true` will be saved here and can be reloaded via `rehydrate()`.
   */
  store?: HookStore;
}

/**
 * Central hook registry.
 *
 * Thread-safe for single-process Node.js use.  Not designed for concurrent
 * mutations during an active emit (mutations take effect on the next emit).
 */
export class HookRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly handlers = new Map<HookEvent, HandlerRecord<any>[]>();
  private readonly plugins = new Map<string, Plugin>();
  private readonly store?: HookStore;
  private insertionCounter = 0;

  constructor(opts: HookRegistryOptions = {}) {
    this.store = opts.store;
  }

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Register a handler for the given hook event.
   *
   * @returns A HookRegistration you can pass to `off()` to deregister.
   */
  on<E extends HookEvent>(
    event: E,
    handler: HookHandler<HookEventMap[E]>,
    opts: HookOptions = {},
  ): HookRegistration {
    const record: HandlerRecord<HookEventMap[E]> = {
      id: randomUUID(),
      event,
      priority: opts.priority ?? 0,
      label: opts.label,
      before: opts.before,
      after: opts.after,
      timeoutMs: opts.timeoutMs,
      compensate: opts.compensate ?? false,
      handler,
      insertionOrder: this.insertionCounter++,
    };

    const bucket = this.handlers.get(event) ?? [];
    bucket.push(record);
    this.handlers.set(event, bucket);

    // Persist metadata if requested
    if (opts.persist && this.store && opts.label) {
      const entry: StoredHandler = {
        id: record.id,
        event,
        label: opts.label,
        priority: record.priority,
        timeoutMs: record.timeoutMs,
        createdAt: Date.now(),
      };
      // Fire-and-forget; failures do not affect registration
      this.store.save(entry).catch(() => undefined);
    }

    return { id: record.id, event, priority: record.priority, label: record.label };
  }

  /**
   * Remove a previously registered handler by its registration handle.
   * No-op if the handle has already been removed.
   */
  off(registration: HookRegistration): void {
    const bucket = this.handlers.get(registration.event);
    if (!bucket) return;
    const idx = bucket.findIndex((r) => r.id === registration.id);
    if (idx !== -1) {
      bucket.splice(idx, 1);
      this.store?.delete(registration.id).catch(() => undefined);
    }
  }

  /**
   * Remove all handlers for `event`, or all handlers across all events when
   * `event` is omitted.
   */
  offAll(event?: HookEvent): void {
    if (event !== undefined) {
      this.handlers.set(event, []);
    } else {
      this.handlers.clear();
    }
  }

  // ── Rehydration (restart persistence) ─────────────────────────────────────

  /**
   * Re-register handlers whose metadata was persisted in the store.
   *
   * @param namedHandlers - Map from label string to actual handler function.
   *   Only stored entries whose label appears in this map will be re-registered.
   *
   * @returns Number of handlers successfully rehydrated.
   */
  async rehydrate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    namedHandlers: Record<string, HookHandler<any>>,
  ): Promise<number> {
    if (!this.store) return 0;
    const stored = await this.store.loadAll();
    let count = 0;
    for (const entry of stored) {
      const fn = namedHandlers[entry.label];
      if (!fn) continue;
      // Re-register with the persisted metadata, using the stored id
      const record: HandlerRecord = {
        id: entry.id,
        event: entry.event,
        priority: entry.priority,
        label: entry.label,
        timeoutMs: entry.timeoutMs,
        compensate: false,
        handler: fn,
        insertionOrder: this.insertionCounter++,
      };
      const bucket = this.handlers.get(entry.event) ?? [];
      // Avoid duplicate rehydration
      if (!bucket.some((r) => r.id === entry.id)) {
        bucket.push(record);
        this.handlers.set(entry.event, bucket);
        count++;
      }
    }
    return count;
  }

  // ── Emit ──────────────────────────────────────────────────────────────────

  /**
   * Fire all registered handlers for `event` in descending priority order
   * (with before/after ordering constraints applied within each priority tier).
   *
   * Returns an EmitResult describing what happened.  Never throws — errors
   * from individual handlers are collected in `result.errors`.
   *
   * When a handler aborts the chain, registered compensation handlers run
   * in reverse registration order before emit() returns.
   */
  async emit<E extends HookEvent>(
    event: E,
    payload: HookEventMap[E],
  ): Promise<EmitResult> {
    const result: EmitResult = {
      event,
      handled: 0,
      aborted: false,
      compensationsRan: 0,
      errors: [],
    };

    const raw = this.handlers.get(event) ?? [];

    // Separate normal and compensation handlers
    const normal = raw.filter((r) => !r.compensate);
    const compensations = raw.filter((r) => r.compensate);

    // Sort normal: priority DESC, insertionOrder ASC
    const prioritySorted = normal
      .slice()
      .sort((a, b) => b.priority - a.priority || a.insertionOrder - b.insertionOrder);

    // Apply before/after ordering constraints
    const sorted = applyOrderingConstraints(prioritySorted);

    for (const record of sorted) {
      result.handled++;

      let hookResult: HookResult | void;
      try {
        hookResult = await this._runWithTimeout(record, payload);
      } catch (err) {
        result.errors.push({
          handlerId: record.id,
          label: record.label,
          error: String(err),
        });
        continue;
      }

      if (hookResult?.abort) {
        result.aborted = true;
        break;
      }
    }

    // Run compensation handlers when abort was signalled
    if (result.aborted && compensations.length > 0) {
      // Reverse registration order for compensation
      const reversed = compensations.slice().reverse();
      for (const record of reversed) {
        try {
          await this._runWithTimeout(record, payload);
          result.compensationsRan++;
        } catch (err) {
          result.errors.push({
            handlerId: record.id,
            label: record.label,
            error: `[compensation] ${String(err)}`,
          });
        }
      }
    }

    return result;
  }

  /** Run a handler, racing against an optional timeout. */
  private async _runWithTimeout(
    record: HandlerRecord,
    payload: unknown,
  ): Promise<HookResult | void> {
    if (!record.timeoutMs) {
      return record.handler(payload);
    }

    return new Promise<HookResult | void>((resolve, reject) => {
      let done = false;

      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          reject(new Error(`Handler "${record.label ?? record.id}" timed out after ${record.timeoutMs}ms`));
        }
      }, record.timeoutMs);

      Promise.resolve(record.handler(payload)).then(
        (r) => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve(r);
          }
        },
        (err) => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            reject(err as Error);
          }
        },
      );
    });
  }

  // ── Plugin management ─────────────────────────────────────────────────────

  /**
   * Install a plugin.  Calls `plugin.install(this)` so the plugin can
   * register its hooks via `registry.on()`.
   *
   * @throws {HookError} DUPLICATE_PLUGIN — if a plugin with the same name is already installed.
   */
  use(plugin: Plugin): this {
    if (this.plugins.has(plugin.name)) {
      throw new HookError(
        `Plugin "${plugin.name}" is already installed`,
        "DUPLICATE_PLUGIN",
        { pluginName: plugin.name },
      );
    }
    this.plugins.set(plugin.name, plugin);
    plugin.install(this);
    return this;
  }

  /**
   * Uninstall a plugin by name.  Calls `plugin.uninstall(this)` if defined.
   * No-op if the plugin is not installed.
   */
  unuse(pluginName: string): this {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) return this;
    plugin.uninstall?.(this);
    this.plugins.delete(pluginName);
    return this;
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  /** Return all registered handlers for `event`, or all handlers if omitted. */
  listHandlers(event?: HookEvent): HookRegistration[] {
    if (event !== undefined) {
      return (this.handlers.get(event) ?? []).map(toRegistration);
    }
    const all: HookRegistration[] = [];
    for (const bucket of this.handlers.values()) {
      for (const r of bucket) {
        all.push(toRegistration(r));
      }
    }
    return all;
  }

  /** Return all installed plugins. */
  listPlugins(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  /** Count of handlers registered for `event`. */
  handlerCount(event: HookEvent): number {
    return (this.handlers.get(event) ?? []).length;
  }
}

function toRegistration(r: HandlerRecord<unknown>): HookRegistration {
  return { id: r.id, event: r.event, priority: r.priority, label: r.label };
}

// ── HookError ─────────────────────────────────────────────────────────────────

export class HookError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HookError";
  }
}

// ── Global registry ───────────────────────────────────────────────────────────

/**
 * Module-level global HookRegistry.
 *
 * Application code should import and use this directly.
 * Tests should create isolated `new HookRegistry()` instances to avoid
 * cross-test pollution.
 */
export const globalHooks = new HookRegistry();

// ── definePlugin helper ───────────────────────────────────────────────────────

/**
 * Type-safe helper for defining a Plugin object.
 *
 * @example
 * ```ts
 * export const auditPlugin = definePlugin({
 *   name: "nexus-audit",
 *   version: "0.1.0",
 *   install(registry) {
 *     registry.on("task.before", async ({ taskId, taskType }) => {
 *       await auditLog.write(taskId, taskType);
 *     });
 *   },
 * });
 * ```
 */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

// ── Well-known hook events (exported for type-safe use) ───────────────────────

export const HOOK_EVENTS = [
  "session.init",
  "session.end",
  "task.before",
  "task.after",
  "task.error",
  "memory.before_write",
  "memory.after_write",
  "agent.observe",
  "file.before_edit",
  "file.after_edit",
] as const satisfies readonly HookEvent[];
