import { IExecutionAdapter } from "./execution.interface";

export interface IBrowserTask {
  id: string;
  url: string;
  actions: Array<{
    type: "navigate" | "click" | "type" | "screenshot";
    selector?: string;
    value?: string;
  }>;
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
  getWriteLog(): Array<{ timestamp: Date; file: string; bytes: number }>;
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

export interface ICapabilityPolicy {
  evaluateCapability(
    taskType: string,
    environment: IExecutionEnvironment
  ): Promise<{
    allowed: boolean;
    reason?: string;
  }>;
}
