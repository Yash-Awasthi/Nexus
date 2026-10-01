// SPDX-License-Identifier: Apache-2.0
import type { IExecutionAdapter } from "./execution.interface.js";

/**
 * The one browser action vocabulary. Both executors speak it: the declarative
 * plan an {@link IBrowserTask} carries, and the step an LLM agent loop decides
 * on its own. They used to describe the same four verbs with two unrelated
 * shapes, which is why a plan could not be handed from one to the other.
 *
 * `extract` and `done` are loop-only: they read or end rather than touch the
 * page, so a declarative plan never contains them.
 */
export type BrowserActionType = "navigate" | "click" | "type" | "screenshot" | "extract" | "done";

export interface BrowserAction {
  type: BrowserActionType;
  /** CSS selector for click/type; the destination URL for `navigate`. */
  selector?: string;
  /** Text to type, or any value the action needs. */
  value?: string;
}

export interface IBrowserTask {
  id: string;
  url: string;
  actions: BrowserAction[];
  timeoutMs: number;
}

export interface IScrapingTask {
  id: string;
  url: string;
  selectors: string[];
  maxDepth?: number;
  maxRequests?: number;
}

export interface IBrowserExecutionAdapter extends IExecutionAdapter {
  executeBrowserTask(task: IBrowserTask): Promise<{
    success: boolean;
    screenshotUrl?: string;
    content?: string;
    logs: string[];
  }>;
}

export interface IScrapingExecutionAdapter extends IExecutionAdapter {
  executeScrapingTask(task: IScrapingTask): Promise<{
    success: boolean;
    data: Record<string, string>;
    requestsCount: number;
    bytesFetched: number;
  }>;
}

export interface IFilesystemSandbox {
  createDirectory(pathSegment: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  readFile(filePath: string): Promise<string>;
  deleteFile(filePath: string): Promise<void>;
  getWriteLog(): { timestamp: Date; file: string; bytes: number }[];
  cleanup(): Promise<void>;
}

export interface ISandboxConstraint {
  maxWriteBytes: number;
  allowedPathPrefix: string;
  validateWrite(filePath: string, contentSize: number, currentTotal: number): boolean;
}

export interface IEnvironmentTelemetry {
  browserSessionsActive: number;
  totalBytesFetched: number;
  totalWritesCount: number;
  totalBytesWritten: number;
  navigationHistory: string[];
  recordNavigation(url: string): void;
  recordFetch(bytes: number): void;
  recordWrite(bytes: number): void;
}

export interface IExecutionEnvironment {
  name: string;
  capabilities: string[];
  telemetry: IEnvironmentTelemetry;
}
