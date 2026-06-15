// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/plugin-sdk
 *
 * Stable interface contract for NEXUS execution adapters.
 * Every adapter in packages/adapters/* must implement IExecutionAdapter
 * via the defineAdapter factory.
 *
 * Compatible with Ghoststack's IExecutionAdapter so adapters can be
 * dropped straight into @nexus/runtime (M6) without changes.
 */

// ── Logging ──────────────────────────────────────────────────────────────────

export interface ILogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

// ── Execution context ─────────────────────────────────────────────────────────

export interface IExecutionContext {
  /** Unique ID for this task invocation */
  readonly taskId: string;
  /** Wall-clock time when the task was enqueued */
  readonly startTime: Date;
  /** 1-based attempt counter (1 = first try) */
  readonly attempt: number;
  /** Environment variables available to the adapter */
  readonly environment: Readonly<Record<string, string>>;
  /** Structured logger scoped to this task */
  readonly logger: ILogger;
}

// ── Capabilities ──────────────────────────────────────────────────────────────

export type AdapterCapability =
  | "llm.inference"
  | "storage.read"
  | "storage.write"
  | "search.web"
  | "communication.email"
  | "communication.chat"
  | "database.query"
  | "database.execute"
  | "secrets.read"
  | "monitoring.log"
  | "monitoring.alert"
  | "deploy.trigger"
  | "scraping.financial"
  | "deliberation.council"
  | "auth.verify";

// ── Core adapter interface ─────────────────────────────────────────────────────

export interface IExecutionAdapter {
  /** Unique adapter name, e.g. "nexus-adapter-groq" */
  readonly name: string;
  /** SemVer string, e.g. "0.1.0" */
  readonly version: string;
  /** Capability tags used for routing + observability */
  readonly capabilities: readonly AdapterCapability[];
  /**
   * Returns true if this adapter can handle the given task type.
   * Task types follow the convention: "<adapter>.<action>", e.g. "groq.inference".
   */
  canExecute(taskType: string): boolean;
  /**
   * Execute a task. The adapter owns full error handling — throw NexusAdapterError
   * for recoverable failures, let unknown errors propagate for dead-lettering.
   */
  execute(task: unknown, context: IExecutionContext): Promise<unknown>;
}

// ── defineAdapter factory ──────────────────────────────────────────────────────

export interface AdapterDefinition<TInput = unknown, TOutput = unknown> {
  /** Unique adapter name */
  name: string;
  /** SemVer version */
  version: string;
  /** Capability tags */
  capabilities: readonly AdapterCapability[];
  /** Exact task type strings this adapter handles */
  taskTypes: readonly string[];
  /** The actual execution logic */
  execute(task: TInput, context: IExecutionContext): Promise<TOutput>;
}

/**
 * Factory that wraps an AdapterDefinition into a fully-typed IExecutionAdapter.
 *
 * @example
 * ```ts
 * export const groqAdapter = defineAdapter({
 *   name: "nexus-adapter-groq",
 *   version: "0.1.0",
 *   capabilities: ["llm.inference"],
 *   taskTypes: ["groq.inference", "groq.chat"],
 *   async execute(task, ctx) { ... },
 * });
 * ```
 */
export function defineAdapter<TInput = unknown, TOutput = unknown>(
  definition: AdapterDefinition<TInput, TOutput>,
): IExecutionAdapter {
  const taskTypeSet = new Set(definition.taskTypes);

  return {
    name: definition.name,
    version: definition.version,
    capabilities: definition.capabilities,

    canExecute(taskType: string): boolean {
      return taskTypeSet.has(taskType);
    },

    execute(task: unknown, context: IExecutionContext): Promise<unknown> {
      return definition.execute(task as TInput, context);
    },
  };
}

// ── Adapter registry ───────────────────────────────────────────────────────────

export class AdapterRegistry {
  private readonly adapters = new Map<string, IExecutionAdapter>();

  register(adapter: IExecutionAdapter): this {
    if (this.adapters.has(adapter.name)) {
      throw new NexusAdapterError(
        `Adapter "${adapter.name}" is already registered`,
        "DUPLICATE_ADAPTER",
      );
    }
    this.adapters.set(adapter.name, adapter);
    return this;
  }

  resolve(taskType: string): IExecutionAdapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (adapter.canExecute(taskType)) {
        return adapter;
      }
    }
    return undefined;
  }

  list(): IExecutionAdapter[] {
    return Array.from(this.adapters.values());
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class NexusAdapterError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "NexusAdapterError";
  }
}

/** Adapter timeout error. */
export class AdapterTimeoutError extends NexusAdapterError {
  constructor(adapterName: string, taskType: string, timeoutMs: number) {
    super(
      `Adapter "${adapterName}" timed out after ${timeoutMs}ms handling "${taskType}"`,
      "ADAPTER_TIMEOUT",
      { adapterName, taskType, timeoutMs },
    );
    this.name = "AdapterTimeoutError";
  }
}

/** Adapter config error. */
export class AdapterConfigError extends NexusAdapterError {
  constructor(adapterName: string, missingKey: string) {
    super(
      `Adapter "${adapterName}" is missing required config key: ${missingKey}`,
      "ADAPTER_CONFIG_ERROR",
      { adapterName, missingKey },
    );
    this.name = "AdapterConfigError";
  }
}

/** Adapter http error. */
export class AdapterHttpError extends NexusAdapterError {
  constructor(
    adapterName: string,
    status: number,
    body: string,
    context?: Record<string, unknown>,
  ) {
    super(
      `Adapter "${adapterName}" received HTTP ${status}: ${body.slice(0, 200)}`,
      "ADAPTER_HTTP_ERROR",
      { adapterName, status, body: body.slice(0, 500), ...context },
    );
    this.name = "AdapterHttpError";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Require an env var from the execution context, throwing AdapterConfigError
 * if it is absent or empty.
 */
export function requireEnv(ctx: IExecutionContext, key: string): string {
  const value = ctx.environment[key];
  if (!value) {
    throw new AdapterConfigError("unknown", key);
  }
  return value;
}

/**
 * Wrapper that enforces a per-call timeout on adapter execution.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  adapterName: string,
  taskType: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new AdapterTimeoutError(adapterName, taskType, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
