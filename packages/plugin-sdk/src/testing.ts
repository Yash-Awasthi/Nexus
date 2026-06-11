// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/plugin-sdk — testing utilities
 *
 * Helpers for unit-testing adapters without spinning up real infrastructure.
 */

import type { IExecutionContext, ILogger, IExecutionAdapter } from "./index.js";

// ── Mock logger ───────────────────────────────────────────────────────────────

export interface MockLogEntry {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  context?: Record<string, unknown>;
}

export interface MockLogger extends ILogger {
  entries: MockLogEntry[];
  clear(): void;
}

export function createMockLogger(): MockLogger {
  const entries: MockLogEntry[] = [];

  const log =
    (level: MockLogEntry["level"]) =>
    (message: string, context?: Record<string, unknown>) => {
      entries.push({ level, message, context });
    };

  return {
    entries,
    clear() {
      entries.splice(0, entries.length);
    },
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    debug: log("debug"),
  };
}

// ── Mock context ──────────────────────────────────────────────────────────────

export function createMockContext(
  overrides: Partial<IExecutionContext> = {},
): IExecutionContext {
  return {
    taskId: overrides.taskId ?? `test-task-${Date.now()}`,
    startTime: overrides.startTime ?? new Date(),
    attempt: overrides.attempt ?? 1,
    environment: overrides.environment ?? {},
    logger: overrides.logger ?? createMockLogger(),
  };
}

// ── Test adapter ──────────────────────────────────────────────────────────────

export interface TestAdapterCall {
  task: unknown;
  context: IExecutionContext;
  result: unknown;
  error?: Error;
  durationMs: number;
}

export interface TestAdapter extends IExecutionAdapter {
  calls: TestAdapterCall[];
  reset(): void;
}

/**
 * Wraps any IExecutionAdapter to record all calls for assertions.
 */
export function createTestAdapter(adapter: IExecutionAdapter): TestAdapter {
  const calls: TestAdapterCall[] = [];

  return {
    name: adapter.name,
    version: adapter.version,
    capabilities: adapter.capabilities,
    calls,

    reset() {
      calls.splice(0, calls.length);
    },

    canExecute(taskType: string): boolean {
      return adapter.canExecute(taskType);
    },

    async execute(task: unknown, context: IExecutionContext): Promise<unknown> {
      const start = Date.now();
      try {
        const result = await adapter.execute(task, context);
        calls.push({ task, context, result, durationMs: Date.now() - start });
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        calls.push({
          task,
          context,
          result: undefined,
          error,
          durationMs: Date.now() - start,
        });
        throw error;
      }
    },
  };
}

// ── Stub factory ──────────────────────────────────────────────────────────────

/**
 * Create a minimal stub adapter for testing pipeline logic without real adapters.
 */
export function createStubAdapter(
  name: string,
  taskTypes: string[],
  response: unknown = { ok: true },
): IExecutionAdapter {
  return {
    name,
    version: "0.0.0",
    capabilities: [],
    canExecute: (taskType: string) => taskTypes.includes(taskType),
    execute: async () => response,
  };
}
