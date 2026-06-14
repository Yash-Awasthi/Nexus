// SPDX-License-Identifier: Apache-2.0
import type { ILogger } from "./logger.interface.js";

export interface IExecutionContext {
  taskId: string;
  startTime: Date;
  attempt: number;
  environment: Record<string, string>;
  /** Typed logger — replaces the previous `any` */
  logger: ILogger;
}

export interface IRuntimeEvent {
  eventId: string;
  taskId: string;
  type: "execution_started" | "execution_succeeded" | "execution_failed";
  timestamp: Date;
  /** Untyped at interface boundary — implementations narrow as needed */
  payload: unknown;
}

// Adapter boundary: tasks are heterogeneous across adapters (floci, browser, scraping,
// search, code, inference). The task parameter is `any` at this boundary; each adapter
// narrows to its own payload shape internally. The return type is tightened to
// Record<string, unknown> — callers may cast further when needed.
export interface IExecutionAdapter {
  canExecute(taskType: string): boolean;
  /**
   * Execute a task. The `task` parameter is intentionally `unknown` at the
   * interface boundary — tasks are heterogeneous across adapters (browser,
   * scraping, search, code, inference). Each implementation narrows `task`
   * to its own payload shape via type guards or casts.
   */
  execute(task: unknown, context: IExecutionContext): Promise<Record<string, unknown>>;
}

export interface ITaskDependencyResolver {
  /** Returns tasks sorted in dependency order. Items are `unknown` at interface level; implementations provide concrete types. */
  resolveOrder(tasks: unknown[]): unknown[];
  /** Detects circular dependencies. Items are `unknown` at interface level; implementations provide concrete types. */
  detectCycles(tasks: unknown[]): boolean;
}

export interface ITaskExecutor {
  start(): Promise<void>;
  executeNext(): Promise<boolean>;
  runLoop(maxIterations?: number, idleDelayMs?: number): Promise<number>;
}
