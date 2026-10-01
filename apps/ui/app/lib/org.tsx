// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, useEffect, useRef } from "react";

import { apiFetch } from "~/lib/api";

/** What the caller may do with the open company, as the server reports it in `can`. */
export const CompanyCan = createContext<readonly string[]>([]);
export const useCan = (what: string) => useContext(CompanyCan).includes(what);
/** Whether the caller owns a company, and so may manage it. */
export const canManage = (c: { can: string[] }) => c.can.includes("manage");

/**
 * Client for the org API (/api/org/*). One place owns the request shape and
 * error mapping so every org page reports failures the same way.
 */

export type CompanyStatus = "active" | "paused" | "archived";
export type AgentStatus =
  "idle" | "running" | "paused" | "error" | "pending_approval" | "terminated";
export type AdapterType =
  "nexus" | "claude_code" | "codex" | "gemini" | "opencode" | "shell" | "http";

export interface Company {
  id: string;
  name: string;
  mission: string;
  description: string;
  status: CompanyStatus;
  pauseReason: "manual" | "budget" | null;
  taskPrefix: string;
  requireHireApproval: boolean;
  /** Absent on companies created before council review existed. */
  councilReviewsApprovals?: boolean;
  /** The council checks work an agent calls done before it counts. */
  councilGatesDone?: boolean;
  replaysWhilePaused?: boolean;
  /** Agents move to the cheaper model their scorecard recommends. */
  autoModel?: boolean;
  /** The workspace whose members may read this company. */
  workspaceId?: string | null;
  /** What you may do here: "manage" as its owner, else the member writes a workspace allows. */
  can: string[];
  createdAt: string;
}

export interface HeartbeatPolicy {
  enabled: boolean;
  intervalSec: number;
  cron: string | null;
  wakeOnAssign: boolean;
}

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title: string;
  reportsTo: string | null;
  capabilities: string;
  archetypeId: string | null;
  instructions: string;
  model: string | null;
  adapterType: AdapterType;
  adapterConfig: Record<string, unknown>;
  heartbeat: HeartbeatPolicy;
  skills: string[];
  knowledgeBaseIds?: string[];
  secretNames: string[];
  status: AgentStatus;
  pauseReason: "manual" | "budget" | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
}

export interface OrgNode {
  agent: Agent;
  reports: OrgNode[];
}

export interface Activity {
  id: string;
  actorType: "user" | "agent" | "system";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export type GoalLevel = "company" | "team" | "agent" | "task";
export type GoalStatus = "planned" | "active" | "achieved" | "cancelled";

export interface Goal {
  id: string;
  title: string;
  description: string;
  level: GoalLevel;
  parentId: string | null;
  ownerAgentId: string | null;
  status: GoalStatus;
  createdAt: string;
}

export type TaskStatus =
  "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
export type Priority = "critical" | "high" | "medium" | "low";

export interface Actor {
  type: "user" | "agent" | "system";
  id: string;
}

export interface Task {
  id: string;
  companyId: string;
  identifier: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  goalId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  blockedBy: string[];
  workMode: "standard" | "planning" | "ask";
  checkoutRunId: string | null;
  createdBy: Actor;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  taskId: string;
  author: Actor;
  body: string;
  createdAt: string;
}

export interface TaskDetail {
  task: Task;
  comments: Comment[];
  why: { tasks: Task[]; goals: Goal[] };
  subtasks: Task[];
  openBlockers: Task[];
  transitions: TaskStatus[];
}

export const BOARD_COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "backlog", label: "Backlog" },
  { status: "todo", label: "To do" },
  { status: "in_progress", label: "In progress" },
  { status: "in_review", label: "In review" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

export const PRIORITY_TONE: Record<Priority, string> = {
  critical: "text-destructive",
  high: "text-warning",
  medium: "text-primary",
  low: "text-muted-foreground",
};

export type RunStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "skipped";

export interface LlmStep {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cached: boolean;
  error?: string;
}

export interface RunSummary {
  id: string;
  agentId: string;
  taskId: string | null;
  source: string;
  reason: string;
  status: RunStatus;
  adapterType: AdapterType;
  coalescedCount: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  outcome: { status: string | null; summary: string; subtasks: string[] } | null;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Run extends RunSummary {
  steps: LlmStep[];
  log: { ts: string; stream: "system" | "stdout" | "stderr" | "agent"; text: string }[];
  output: string;
  /** The run kept its prompt, so it can be replayed on another model. */
  replayable: boolean;
}

export interface Replay {
  original: { model: string | null; output: string };
  replay: { model: string; output: string; costUsd: number };
  diff: { op: " " | "-" | "+"; line: string }[];
}

export function usd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function duration(from: string | null, to: string | null): string {
  if (!from) return "—";
  const ms = (to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime();
  return ms < 1000
    ? `${ms}ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(1)}s`
      : `${Math.round(ms / 60_000)}m`;
}

export const ADAPTERS: { id: AdapterType; label: string; hint: string }[] = [
  {
    id: "nexus",
    label: "Nexus (built in)",
    hint: "Runs on your provider keys with failover, skills and memory.",
  },
  {
    id: "claude_code",
    label: "Claude Code",
    hint: "Starts the local claude CLI in the agent's workspace.",
  },
  { id: "codex", label: "Codex", hint: "Starts the local codex CLI." },
  { id: "gemini", label: "Gemini CLI", hint: "Starts the local gemini CLI." },
  { id: "opencode", label: "OpenCode", hint: "Starts the local opencode CLI." },
  {
    id: "shell",
    label: "Shell command",
    hint: "Runs a command you choose; output becomes the result.",
  },
  { id: "http", label: "HTTP webhook", hint: "POSTs the task to a URL and records the reply." },
];

/** A call to the org API (/api/org/*); failures throw an ApiError. */
export const orgApi = <T,>(path: string, init: RequestInit & { json?: unknown } = {}) =>
  apiFetch<T>(`/api/org${path}`, init);

const OK = "bg-success/15 text-success";
const BUSY = "bg-primary/15 text-primary";
const WAIT = "bg-warning/15 text-warning";
const BAD = "bg-destructive/15 text-destructive";
const OFF = "bg-muted text-muted-foreground";

const STATUS_TONE: Record<string, string> = {
  idle: OK,
  running: BUSY,
  paused: WAIT,
  error: BAD,
  pending_approval: WAIT,
  terminated: OFF,
  todo: "bg-chart-2/15 text-chart-2",
  backlog: OFF,
  in_progress: BUSY,
  in_review: WAIT,
  blocked: BAD,
  done: OK,
  cancelled: `${OFF} line-through`,
  planned: OFF,
  queued: OFF,
  succeeded: OK,
  failed: BAD,
  timed_out: BAD,
  skipped: OFF,
  achieved: OK,
  active: OK,
  archived: OFF,
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[status] ?? OFF}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

/** Call `fn` every `ms` while the tab is visible, so live views stay current. */
export function useVisibleInterval(fn: () => void, ms: number): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") ref.current();
    }, ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
