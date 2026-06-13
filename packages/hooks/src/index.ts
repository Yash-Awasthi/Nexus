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
 *   • A handler returning { abort: true } stops the remaining chain.
 *   • Handler errors are collected and returned in EmitResult — one bad
 *     handler never prevents the rest from running.
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
 * }, { priority: 10, label: "logger" });
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
  /** Human-readable label for debug output */
  label?: string;
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
  /** Number of handlers that executed (including aborted) */
  handled: number;
  /** True if a handler returned { abort: true } */
  aborted: boolean;
  /** Errors thrown by individual handlers (collected, not re-thrown) */
  errors: HandlerError[];
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

interface HandlerRecord<T> {
  id: string;
  event: HookEvent;
  priority: number;
  label?: string;
  handler: HookHandler<T>;
  insertionOrder: number;
}

// ── HookRegistry ──────────────────────────────────────────────────────────────

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
  private insertionCounter = 0;

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
      handler,
      insertionOrder: this.insertionCounter++,
    };

    const bucket = this.handlers.get(event) ?? [];
    bucket.push(record);
    this.handlers.set(event, bucket);

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
    if (idx !== -1) bucket.splice(idx, 1);
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

  // ── Emit ──────────────────────────────────────────────────────────────────

  /**
   * Fire all registered handlers for `event` in descending priority order.
   *
   * Returns an EmitResult describing what happened.  Never throws — errors
   * from individual handlers are collected in `result.errors`.
   */
  async emit<E extends HookEvent>(
    event: E,
    payload: HookEventMap[E],
  ): Promise<EmitResult> {
    const result: EmitResult = { event, handled: 0, aborted: false, errors: [] };

    const raw = this.handlers.get(event) ?? [];

    // Sort: higher priority first; ties broken by insertion order (lower = earlier)
    const sorted = raw
      .slice()
      .sort((a, b) => b.priority - a.priority || a.insertionOrder - b.insertionOrder);

    for (const record of sorted) {
      result.handled++;

      let hookResult: HookResult | void;
      try {
        hookResult = await record.handler(payload);
      } catch (err) {
        result.errors.push({
          handlerId: record.id,
          label: record.label,
          error: String(err),
        });
        // Continue chain even if a handler throws
        continue;
      }

      if (hookResult?.abort) {
        result.aborted = true;
        break;
      }
    }

    return result;
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
