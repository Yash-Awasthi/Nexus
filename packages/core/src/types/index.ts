// ─── Identity ──────────────────────────────────────────────────────────────────
export type AgentId   = string;
export type MessageId = string;
export type TaskId    = string;

// ─── Agent lifecycle ───────────────────────────────────────────────────────────
export enum AgentStatus {
  IDLE    = 'idle',
  BUSY    = 'busy',
  ERROR   = 'error',
  OFFLINE = 'offline',
}

// ─── Messaging ─────────────────────────────────────────────────────────────────
export enum MessagePriority {
  LOW      = 0,
  NORMAL   = 1,
  HIGH     = 2,
  CRITICAL = 3,
}

export interface AgentMessage<T = unknown> {
  id:            MessageId;
  from:          AgentId;
  to:            AgentId | 'broadcast';
  topic:         string;
  payload:       T;
  priority:      MessagePriority;
  timestamp:     number;
  correlationId?: MessageId;   // for request/response pairing
  ttl?:           number;      // expiry in ms
}

// ─── Tasks ─────────────────────────────────────────────────────────────────────
export interface AgentTask<TInput = unknown> {
  id:          TaskId;
  type:        string;
  input:       TInput;
  context?:    Record<string, unknown>;
  deadline?:   number;    // unix ms
  retries?:    number;
  maxRetries?: number;
}

export interface AgentResult<TOutput = unknown> {
  taskId:     TaskId;
  agentId:    AgentId;
  success:    boolean;
  output?:    TOutput;
  error?:     string;
  durationMs: number;
}

// ─── Configuration ─────────────────────────────────────────────────────────────
export interface AgentConfig {
  id:              AgentId;
  name:            string;
  description:     string;
  version:         string;
  capabilities:    string[];
  model?:          string;
  maxConcurrency?: number;
  timeout?:        number;  // ms per task
  systemPrompt?:   string;
}

// ─── Tools ─────────────────────────────────────────────────────────────────────
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name:        string;
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema
  handler:     (input: TInput) => Promise<TOutput>;
}

// ─── Health ────────────────────────────────────────────────────────────────────
export interface AgentHealth {
  agentId:   AgentId;
  status:    AgentStatus;
  uptime:    number;
  tasks:     { completed: number; failed: number };
  lastSeen:  number;
}

// ─── Events ────────────────────────────────────────────────────────────────────
export interface AgentStatusEvent {
  agentId:   AgentId;
  status:    AgentStatus;
  timestamp: number;
}

export interface TaskStartedEvent {
  taskId:    TaskId;
  agentId:   AgentId;
  taskType:  string;
  timestamp: number;
}

export interface TaskCompletedEvent {
  taskId:    TaskId;
  agentId:   AgentId;
  success:   boolean;
  durationMs: number;
  timestamp: number;
}
