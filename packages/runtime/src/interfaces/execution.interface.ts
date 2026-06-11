import { ILogger } from "./logger.interface.js";

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(task: any, context: IExecutionContext): Promise<Record<string, unknown>>;
}

export interface ITaskDependencyResolver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveOrder(tasks: any[]): any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  detectCycles(tasks: any[]): boolean;
}

export interface ITaskExecutor {
  start(): Promise<void>;
  executeNext(): Promise<boolean>;
  runLoop(maxIterations?: number, idleDelayMs?: number): Promise<number>;
}
