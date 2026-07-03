// SPDX-License-Identifier: Apache-2.0
export interface IMCPTask {
  id: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  correlationId: string;
  timeoutMs?: number;
  priority?: "low" | "medium" | "high";
  dependencies?: string[];
}

export interface IMCPExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
  correlationId: string;
}

interface IMCPExecutionContext {
  correlationId: string;
  startTime: Date;
  attempt: number;
  environment: Record<string, string>;
}

export interface IMCPTransport {
  send(message: unknown): Promise<unknown>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface IMCPServerInfo {
  name: string;
  transportType: "stdio" | "http" | "websocket";
  endpoint: string;
  status: "active" | "inactive" | "failed";
  tools: string[];
}

export interface IMCPServerRegistry {
  registerServer(info: IMCPServerInfo, transport: IMCPTransport): Promise<void>;
  getServer(name: string): Promise<{ info: IMCPServerInfo; transport: IMCPTransport } | undefined>;
  listServers(): Promise<IMCPServerInfo[]>;
}

export interface IMCPToolAdapter {
  canAdapt(serverName: string, toolName: string): Promise<boolean>;
  invokeTool(task: IMCPTask, context: IMCPExecutionContext): Promise<IMCPExecutionResult>;
}

export interface IMCPRuntimeMetrics {
  invocations: number;
  successes: number;
  failures: number;
  timeouts: number;
  avgDurationMs: number;
}

export interface IMCPRuntime {
  executeTask(task: IMCPTask): Promise<IMCPExecutionResult>;
  getMetrics(): Promise<IMCPRuntimeMetrics>;
  getExecutionsLog(): Promise<IMCPExecutionResult[]>;
}
