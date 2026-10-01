// SPDX-License-Identifier: Apache-2.0
/**
 * Org layer: companies of agents, each company owned by exactly one account.
 *
 * Every record carries `ownerId` and every lookup filters on it, so a caller
 * cannot name another account's company, agent or activity row even with a
 * valid id. Rows are durable through PersistentStore (Postgres or PGlite when
 * DATABASE_URL is set, a JSON file otherwise), which is what lets the org run
 * unchanged on the desktop build.
 *
 * The agent status machine and the org-tree invariants (same company, no
 * reporting cycles, terminated agents never come back) follow Paperclip's V1
 * implementation spec — https://github.com/paperclipai/paperclip
 * MIT License, Copyright (c) 2025 Paperclip AI.
 */

import crypto from "node:crypto";

import { listArchetypes } from "./archetype-store.js";
import { PersistentStore } from "./persistent-store.js";

export class OrgError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new OrgError(404, "not_found", `${what} not found.`);
export const invalid = (message: string) => new OrgError(400, "invalid", message);
const conflict = (message: string) => new OrgError(409, "conflict", message);

// ── Types ────────────────────────────────────────────────────────────────────

export type CompanyStatus = "active" | "paused" | "archived";
export type PauseReason = "manual" | "budget";

export interface Company {
  id: string;
  ownerId: string;
  name: string;
  /** The top-level reason the company exists; every run prompt carries it. */
  mission: string;
  description: string;
  status: CompanyStatus;
  pauseReason: PauseReason | null;
  /** Prefix for task identifiers, e.g. ACME in ACME-12. */
  taskPrefix: string;
  taskCounter: number;
  /** When set, a newly hired agent waits for an approval before it can run. */
  requireHireApproval: boolean;
  /** When set, the council reviews each new approval before the board sees it. */
  councilReviewsApprovals: boolean;
  /** When set, the council checks work an agent calls done before it counts as done. */
  councilGatesDone?: boolean;
  /** When set, a replay runs on a paused company or agent; budgets still apply. */
  replaysWhilePaused?: boolean;
  /** When set, an agent moves to the cheaper model its scorecard recommends (logged, once each). */
  autoModel?: boolean;
  /** Members of this workspace may read the company; only the owner changes it. */
  workspaceId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentStatus =
  "idle" | "running" | "paused" | "error" | "pending_approval" | "terminated";

export const ADAPTER_TYPES = [
  "nexus",
  "claude_code",
  "codex",
  "gemini",
  "opencode",
  "shell",
  "http",
] as const;
export type AdapterType = (typeof ADAPTER_TYPES)[number];

export interface HeartbeatPolicy {
  enabled: boolean;
  /** Seconds between timer wakes; at least 60. Ignored when `cron` is set. */
  intervalSec: number;
  /** Five-field cron expression (lib/cron.ts). */
  cron: string | null;
  /** Wake the agent when a task is assigned to it. */
  wakeOnAssign: boolean;
}

export interface Agent {
  id: string;
  ownerId: string;
  companyId: string;
  name: string;
  role: string;
  title: string;
  reportsTo: string | null;
  /** What this agent is for; peers read it to decide whom to delegate to. */
  capabilities: string;
  /** Persona and default model come from this archetype when set. */
  archetypeId: string | null;
  instructions: string;
  model: string | null;
  adapterType: AdapterType;
  adapterConfig: Record<string, unknown>;
  heartbeat: HeartbeatPolicy;
  skills: string[];
  /** Knowledge bases whose passages are recalled into this agent's prompts. */
  knowledgeBaseIds?: string[];
  secretNames: string[];
  status: AgentStatus;
  pauseReason: PauseReason | null;
  lastHeartbeatAt: string | null;
  /** Adapter session to resume on the next run (e.g. a Claude Code session id). */
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `member`: a workspace member commenting on a shared company; never the board. */
export type ActorType = "user" | "member" | "agent" | "system";

export interface Activity {
  id: string;
  ownerId: string;
  companyId: string;
  actorType: ActorType;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  createdAt: string;
  /** Orders rows written in the same millisecond. */
  seq: number;
}

// ── Storage ──────────────────────────────────────────────────────────────────

const companies = new PersistentStore<Company>("org_companies");
const agents = new PersistentStore<Agent>("org_agents");
const activity = new PersistentStore<Activity>("org_activity");

/**
 * Stores whose rows belong to a company. Deleting a company purges each one;
 * later org modules add theirs with `registerCompanyScoped`.
 */
const companyScoped: PersistentStore<{ id: string; companyId: string }>[] = [
  agents as unknown as PersistentStore<{ id: string; companyId: string }>,
  activity as unknown as PersistentStore<{ id: string; companyId: string }>,
];

export function registerCompanyScoped<T extends { id: string; companyId: string }>(
  store: PersistentStore<T>,
): void {
  companyScoped.push(store as unknown as PersistentStore<{ id: string; companyId: string }>);
}

let _loaded: Promise<void> | null = null;
const _extraLoaders: (() => Promise<void>)[] = [];

export function onOrgLoad(loader: () => Promise<void>): void {
  _extraLoaders.push(loader);
  _loaded = null;
}

const _bootHooks: (() => void)[] = [];

/** Run once every org store has loaded, for recovery that reads across stores. */
export function onOrgBoot(hook: () => void): void {
  _bootHooks.push(hook);
  _loaded = null;
}

export function loadOrgStore(): Promise<void> {
  if (_loaded) return _loaded;
  _loaded = Promise.all([
    companies.load(),
    agents.load(),
    activity.load(),
    ..._extraLoaders.map((l) => l()),
  ]).then(() => {
    for (const hook of _bootHooks) hook();
    return undefined;
  });
  return _loaded;
}

export const now = () => new Date().toISOString();

let _seqTick = 0;
/** Strictly increasing within a process, and ahead of any earlier process's values. */
export function nextSeq(): number {
  _seqTick = (_seqTick + 1) % 1000;
  return Date.now() * 1000 + _seqTick;
}

function str(v: unknown, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw invalid("Expected a string.");
  return v.trim().slice(0, max);
}

// ── Activity ─────────────────────────────────────────────────────────────────

/** Rows kept per company; the oldest go first. */
const ACTIVITY_CAP = 2000;

/** Actions that are governance, not chatter: they also go to the tamper-evident audit log. */
const AUDITED = /^(approval\.|budget\.|company\.|agent\.(hired|terminated|approved|paused))/;

type AuditSink = (row: Activity) => void;
let auditSink: AuditSink | null = null;
/** Where audited actions are written; the route module injects the hash-chained audit log. */
export function setAuditSink(sink: AuditSink): void {
  auditSink = sink;
}

export function logActivity(
  company: Pick<Company, "id" | "ownerId">,
  entry: Omit<Activity, "id" | "ownerId" | "companyId" | "createdAt" | "details" | "seq"> & {
    details?: Record<string, unknown>;
  },
): Activity {
  const row: Activity = {
    ...entry,
    details: entry.details ?? {},
    id: crypto.randomUUID(),
    ownerId: company.ownerId,
    companyId: company.id,
    createdAt: now(),
    seq: nextSeq(),
  };
  activity.set(row.id, row);
  if (auditSink && AUDITED.test(row.action)) auditSink(row);
  const rows = [...activity.values()].filter((a) => a.companyId === company.id);
  if (rows.length > ACTIVITY_CAP) {
    rows.sort((a, b) => a.seq - b.seq);
    for (const old of rows.slice(0, rows.length - ACTIVITY_CAP)) activity.delete(old.id);
  }
  return row;
}

export function listActivity(ownerId: string, companyId: string, limit = 100): Activity[] {
  getCompany(ownerId, companyId);
  return [...activity.values()]
    .filter((a) => a.ownerId === ownerId && a.companyId === companyId)
    .sort((a, b) => b.seq - a.seq)
    .slice(0, Math.max(1, Math.min(limit, 500)));
}

// ── Companies ────────────────────────────────────────────────────────────────

/** Every company across owners, for jobs that sweep them all. */
export function allCompanies(): Company[] {
  return [...companies.values()];
}

export function listCompanies(ownerId: string): Company[] {
  return [...companies.values()]
    .filter((c) => c.ownerId === ownerId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getCompany(ownerId: string, id: string): Company {
  const c = companies.get(id);
  if (!c || c.ownerId !== ownerId) throw notFound("Company");
  return c;
}

/** The company an org row belongs to, found by the row's own id. */
export function companyOf(id: string): Company | undefined {
  const direct = companies.get(id);
  if (direct) return direct;
  for (const store of companyScoped) {
    const row = store.get(id);
    if (row) return companies.get(row.companyId);
  }
  return undefined;
}

/** Companies other owners share into any of these workspaces. */
export function sharedCompanies(userId: string, workspaceIds: string[]): Company[] {
  return [...companies.values()]
    .filter((c) => c.ownerId !== userId && !!c.workspaceId && workspaceIds.includes(c.workspaceId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Up to four letters from the name, made unique among the owner's companies. */
function derivePrefix(ownerId: string, name: string): string {
  const words = name.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  let base = words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "ORG").slice(0, 4);
  base = base.slice(0, 4) || "ORG";
  const taken = new Set(listCompanies(ownerId).map((c) => c.taskPrefix));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}

export interface CompanyInput {
  name?: unknown;
  mission?: unknown;
  description?: unknown;
  requireHireApproval?: unknown;
  councilReviewsApprovals?: unknown;
  councilGatesDone?: unknown;
  replaysWhilePaused?: unknown;
  autoModel?: unknown;
  workspaceId?: unknown;
}

export function createCompany(ownerId: string, input: CompanyInput): Company {
  const name = str(input.name, 120);
  if (!name) throw invalid("A company needs a name.");
  const company: Company = {
    id: crypto.randomUUID(),
    ownerId,
    name,
    mission: str(input.mission, 2000) ?? "",
    description: str(input.description, 4000) ?? "",
    status: "active",
    pauseReason: null,
    taskPrefix: derivePrefix(ownerId, name),
    taskCounter: 0,
    requireHireApproval: input.requireHireApproval === true,
    councilReviewsApprovals: input.councilReviewsApprovals === true,
    councilGatesDone: input.councilGatesDone === true,
    replaysWhilePaused: input.replaysWhilePaused === true,
    autoModel: input.autoModel === true,
    createdAt: now(),
    updatedAt: now(),
  };
  companies.set(company.id, company);
  logActivity(company, {
    actorType: "user",
    actorId: ownerId,
    action: "company.created",
    entityType: "company",
    entityId: company.id,
    details: { name },
  });
  return company;
}

export function updateCompany(ownerId: string, id: string, input: CompanyInput): Company {
  const existing = getCompany(ownerId, id);
  const next: Company = { ...existing, updatedAt: now() };
  const name = str(input.name, 120);
  if (name !== undefined) {
    if (!name) throw invalid("A company needs a name.");
    next.name = name;
  }
  const mission = str(input.mission, 2000);
  if (mission !== undefined) next.mission = mission;
  const description = str(input.description, 4000);
  if (description !== undefined) next.description = description;
  if (typeof input.requireHireApproval === "boolean")
    next.requireHireApproval = input.requireHireApproval;
  if (typeof input.councilReviewsApprovals === "boolean")
    next.councilReviewsApprovals = input.councilReviewsApprovals;
  if (typeof input.councilGatesDone === "boolean") next.councilGatesDone = input.councilGatesDone;
  if (typeof input.replaysWhilePaused === "boolean")
    next.replaysWhilePaused = input.replaysWhilePaused;
  if (typeof input.autoModel === "boolean") next.autoModel = input.autoModel;
  if (input.workspaceId !== undefined) next.workspaceId = str(input.workspaceId, 64) || null;
  companies.set(id, next);
  logActivity(next, {
    actorType: "user",
    actorId: ownerId,
    action: "company.updated",
    entityType: "company",
    entityId: id,
  });
  return next;
}

/** Pause, resume or archive. A budget pause is lifted only by the budget module. */
export function setCompanyStatus(
  ownerId: string,
  id: string,
  status: CompanyStatus,
  opts: { reason?: PauseReason; actorType?: ActorType; actorId?: string } = {},
): Company {
  const existing = getCompany(ownerId, id);
  if (existing.status === "archived" && status !== "archived")
    throw conflict("An archived company cannot be reopened.");
  const reason = opts.reason ?? "manual";
  if (
    status === "active" &&
    existing.pauseReason === "budget" &&
    reason !== "budget" &&
    opts.actorType !== "system"
  )
    throw conflict("This company is paused by its budget. Raise the budget to resume it.");
  const next: Company = {
    ...existing,
    status,
    pauseReason: status === "paused" ? reason : null,
    updatedAt: now(),
  };
  companies.set(id, next);
  logActivity(next, {
    actorType: opts.actorType ?? "user",
    actorId: opts.actorId ?? ownerId,
    action: `company.${status === "active" ? "resumed" : status}`,
    entityType: "company",
    entityId: id,
    ...(status === "paused" ? { details: { reason } } : {}),
  });
  return next;
}

export function deleteCompany(ownerId: string, id: string): void {
  getCompany(ownerId, id);
  for (const store of companyScoped) {
    for (const row of [...store.values()]) if (row.companyId === id) store.delete(row.id);
  }
  companies.delete(id);
}

/** Next task identifier for the company, e.g. ACME-13. */
export function nextTaskIdentifier(ownerId: string, companyId: string): string {
  const c = getCompany(ownerId, companyId);
  const next = { ...c, taskCounter: c.taskCounter + 1 };
  companies.set(c.id, next);
  return `${c.taskPrefix}-${next.taskCounter}`;
}

// ── Agents ───────────────────────────────────────────────────────────────────

export function listAgents(ownerId: string, companyId: string): Agent[] {
  getCompany(ownerId, companyId);
  return [...agents.values()]
    .filter((a) => a.ownerId === ownerId && a.companyId === companyId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getAgent(ownerId: string, id: string): Agent {
  const a = agents.get(id);
  if (!a || a.ownerId !== ownerId) throw notFound("Agent");
  return a;
}

/** Every agent this owner has, across companies. The scheduler walks this. */
export function allAgents(): Agent[] {
  return [...agents.values()];
}

export interface AgentInput {
  name?: unknown;
  role?: unknown;
  title?: unknown;
  reportsTo?: unknown;
  capabilities?: unknown;
  archetypeId?: unknown;
  instructions?: unknown;
  model?: unknown;
  adapterType?: unknown;
  adapterConfig?: unknown;
  heartbeat?: unknown;
  skills?: unknown;
  knowledgeBaseIds?: unknown;
  secretNames?: unknown;
}

function stringList(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string"))
    throw invalid(`${what} must be a list of names.`);
  return [...new Set((v as string[]).map((s) => s.trim()).filter(Boolean))].slice(0, 50);
}

function parseHeartbeat(v: unknown, base: HeartbeatPolicy): HeartbeatPolicy {
  if (v === undefined) return base;
  if (typeof v !== "object" || v === null) throw invalid("heartbeat must be an object.");
  const h = v as Record<string, unknown>;
  const next = { ...base };
  if (h.enabled !== undefined) next.enabled = h.enabled === true;
  if (h.wakeOnAssign !== undefined) next.wakeOnAssign = h.wakeOnAssign === true;
  if (h.intervalSec !== undefined) {
    const n = Number(h.intervalSec);
    if (!Number.isFinite(n) || n < 60) throw invalid("heartbeat.intervalSec must be at least 60.");
    next.intervalSec = Math.round(n);
  }
  if (h.cron !== undefined) next.cron = h.cron === null || h.cron === "" ? null : String(h.cron);
  return next;
}

/** Throws unless `managerId` can be `agentId`'s manager without a cycle. */
function assertManager(
  ownerId: string,
  companyId: string,
  agentId: string | null,
  managerId: string,
) {
  const manager = agents.get(managerId);
  if (!manager || manager.ownerId !== ownerId || manager.companyId !== companyId)
    throw invalid("reportsTo must be an agent in the same company.");
  if (manager.status === "terminated")
    throw invalid("An agent cannot report to a terminated agent.");
  const seen = new Set<string>();
  for (let cur: Agent | undefined = manager; cur;) {
    if (cur.id === agentId) throw invalid("That reporting line would form a cycle.");
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    cur = cur.reportsTo ? agents.get(cur.reportsTo) : undefined;
  }
}

function applyAgentInput(ownerId: string, agent: Agent, input: AgentInput): Agent {
  const next = { ...agent };
  const name = str(input.name, 80);
  if (name !== undefined) {
    if (!name) throw invalid("An agent needs a name.");
    next.name = name;
  }
  const role = str(input.role, 80);
  if (role !== undefined) next.role = role || "general";
  const title = str(input.title, 120);
  if (title !== undefined) next.title = title;
  const capabilities = str(input.capabilities, 2000);
  if (capabilities !== undefined) next.capabilities = capabilities;
  const instructions = str(input.instructions, 20_000);
  if (instructions !== undefined) next.instructions = instructions;
  if (input.model !== undefined) next.model = str(input.model, 200) || null;
  if (input.reportsTo !== undefined) {
    if (input.reportsTo === null || input.reportsTo === "") next.reportsTo = null;
    else {
      if (typeof input.reportsTo !== "string") throw invalid("reportsTo must be an agent id.");
      assertManager(ownerId, agent.companyId, agent.id, input.reportsTo);
      next.reportsTo = input.reportsTo;
    }
  }
  if (input.archetypeId !== undefined) {
    if (input.archetypeId === null || input.archetypeId === "") next.archetypeId = null;
    else if (
      typeof input.archetypeId !== "string" ||
      !listArchetypes(ownerId).some((a) => a.id === input.archetypeId)
    )
      throw invalid("archetypeId must name one of your archetypes.");
    else next.archetypeId = input.archetypeId;
  }
  if (input.adapterType !== undefined) {
    if (!ADAPTER_TYPES.includes(input.adapterType as AdapterType))
      throw invalid(`adapterType must be one of ${ADAPTER_TYPES.join(", ")}.`);
    next.adapterType = input.adapterType as AdapterType;
  }
  if (input.adapterConfig !== undefined) {
    if (typeof input.adapterConfig !== "object" || input.adapterConfig === null)
      throw invalid("adapterConfig must be an object.");
    if (JSON.stringify(input.adapterConfig).length > 20_000)
      throw invalid("adapterConfig is too large.");
    next.adapterConfig = input.adapterConfig as Record<string, unknown>;
  }
  next.heartbeat = parseHeartbeat(input.heartbeat, next.heartbeat);
  if (input.skills !== undefined) next.skills = stringList(input.skills, "skills");
  if (input.knowledgeBaseIds !== undefined)
    next.knowledgeBaseIds = stringList(input.knowledgeBaseIds, "knowledgeBaseIds");
  if (input.secretNames !== undefined)
    next.secretNames = stringList(input.secretNames, "secretNames");
  return next;
}

const hireListeners: ((agent: Agent, actor: { type: ActorType; id: string }) => void)[] = [];
/** Called after every hire; the approvals module files hire approvals from here. */
export function onAgentHired(
  l: (agent: Agent, actor: { type: ActorType; id: string }) => void,
): void {
  hireListeners.push(l);
}

export function createAgent(
  ownerId: string,
  companyId: string,
  input: AgentInput,
  actor: { type: ActorType; id: string } = { type: "user", id: ownerId },
): Agent {
  const company = getCompany(ownerId, companyId);
  // An agent hiring on its own always waits for the board, whatever the company setting.
  const held = company.requireHireApproval || actor.type === "agent";
  if (company.status === "archived") throw conflict("An archived company cannot hire.");
  const blank: Agent = {
    id: crypto.randomUUID(),
    ownerId,
    companyId,
    name: "",
    role: "general",
    title: "",
    reportsTo: null,
    capabilities: "",
    archetypeId: null,
    instructions: "",
    model: null,
    adapterType: "nexus",
    adapterConfig: {},
    heartbeat: { enabled: false, intervalSec: 3600, cron: null, wakeOnAssign: true },
    skills: [],
    secretNames: [],
    status: held ? "pending_approval" : "idle",
    pauseReason: null,
    lastHeartbeatAt: null,
    sessionId: null,
    createdAt: now(),
    updatedAt: now(),
  };
  const agent = applyAgentInput(ownerId, blank, input);
  if (!agent.name) throw invalid("An agent needs a name.");
  agents.set(agent.id, agent);
  logActivity(company, {
    actorType: actor.type,
    actorId: actor.id,
    action: "agent.hired",
    entityType: "agent",
    entityId: agent.id,
    details: { name: agent.name, role: agent.role, status: agent.status },
  });
  for (const l of hireListeners) l(agent, actor);
  return agent;
}

export function updateAgent(ownerId: string, id: string, input: AgentInput): Agent {
  const existing = getAgent(ownerId, id);
  if (existing.status === "terminated") throw conflict("A terminated agent cannot be edited.");
  const next = { ...applyAgentInput(ownerId, existing, input), updatedAt: now() };
  agents.set(id, next);
  logActivity(getCompany(ownerId, existing.companyId), {
    actorType: "user",
    actorId: ownerId,
    action: "agent.updated",
    entityType: "agent",
    entityId: id,
  });
  return next;
}

/**
 * Allowed transitions, from Paperclip's agent state machine. `terminated` is
 * reachable from everywhere and leaves nowhere.
 */
const TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  idle: ["running", "paused", "terminated"],
  running: ["idle", "error", "paused", "terminated"],
  error: ["idle", "running", "paused", "terminated"],
  paused: ["idle", "terminated"],
  pending_approval: ["idle", "terminated"],
  terminated: [],
};

function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Move an agent to a new status, or throw 409 naming the illegal move. */
export function setAgentStatus(
  ownerId: string,
  id: string,
  to: AgentStatus,
  opts: {
    reason?: PauseReason;
    actorType?: ActorType;
    actorId?: string;
    patch?: Partial<Pick<Agent, "lastHeartbeatAt" | "sessionId">>;
    /** Set only by the approvals module when a hire is approved. */
    viaApproval?: boolean;
  } = {},
): Agent {
  const existing = getAgent(ownerId, id);
  if (existing.status === "pending_approval" && to === "idle" && !opts.viaApproval)
    throw conflict("This hire is waiting for approval.");
  if (existing.status === to && !opts.patch) return existing;
  if (existing.status !== to && !canTransition(existing.status, to))
    throw conflict(`An agent cannot go from ${existing.status} to ${to}.`);
  if (
    existing.status === "paused" &&
    existing.pauseReason === "budget" &&
    opts.actorType !== "system" &&
    to === "idle"
  )
    throw conflict("This agent is paused by its budget. Raise the budget to resume it.");
  const next: Agent = {
    ...existing,
    ...opts.patch,
    status: to,
    pauseReason: to === "paused" ? (opts.reason ?? "manual") : null,
    updatedAt: now(),
  };
  agents.set(id, next);
  if (to === "terminated") {
    // Direct reports move up to the terminated agent's manager so the tree stays whole.
    for (const report of agents.values()) {
      if (report.reportsTo === id)
        agents.set(report.id, { ...report, reportsTo: existing.reportsTo, updatedAt: now() });
    }
  }
  const quiet =
    (existing.status === "idle" && to === "running") ||
    (existing.status === "running" && to === "idle");
  if (!quiet) {
    logActivity(getCompany(ownerId, existing.companyId), {
      actorType: opts.actorType ?? "user",
      actorId: opts.actorId ?? ownerId,
      action: `agent.${to === "idle" ? (existing.status === "pending_approval" ? "approved" : "resumed") : to}`,
      entityType: "agent",
      entityId: id,
      ...(to === "paused" ? { details: { reason: next.pauseReason } } : {}),
    });
  }
  return next;
}

/** Only a terminated agent can be deleted; that keeps run and task history honest. */
export function deleteAgent(ownerId: string, id: string): void {
  const existing = getAgent(ownerId, id);
  if (existing.status !== "terminated") throw conflict("Terminate the agent before deleting it.");
  agents.delete(id);
}

/**
 * Whether the agent may start a run now: it is idle or in error, its company
 * is active, and no manager above it is paused or terminated.
 */
export function invokability(
  ownerId: string,
  agent: Agent,
): { ok: true } | { ok: false; reason: string } {
  if (!["idle", "error"].includes(agent.status))
    return { ok: false, reason: `Agent is ${agent.status.replace("_", " ")}.` };
  const company = companies.get(agent.companyId);
  if (!company || company.ownerId !== ownerId) return { ok: false, reason: "Company not found." };
  if (company.status !== "active") return { ok: false, reason: `Company is ${company.status}.` };
  const seen = new Set<string>();
  for (let m = agent.reportsTo ? agents.get(agent.reportsTo) : undefined; m;) {
    if (seen.has(m.id)) break;
    seen.add(m.id);
    if (m.status === "paused") return { ok: false, reason: `Manager ${m.name} is paused.` };
    m = m.reportsTo ? agents.get(m.reportsTo) : undefined;
  }
  return { ok: true };
}

// ── Org chart ────────────────────────────────────────────────────────────────

interface OrgNode {
  agent: Agent;
  reports: OrgNode[];
}

/** The reporting tree. Agents whose manager is gone surface as roots. */
export function orgChart(ownerId: string, companyId: string): OrgNode[] {
  const list = listAgents(ownerId, companyId).filter((a) => a.status !== "terminated");
  const ids = new Set(list.map((a) => a.id));
  const byManager = new Map<string | null, Agent[]>();
  for (const a of list) {
    const key = a.reportsTo && ids.has(a.reportsTo) ? a.reportsTo : null;
    byManager.set(key, [...(byManager.get(key) ?? []), a]);
  }
  const build = (a: Agent, depth: number): OrgNode => ({
    agent: a,
    reports: depth > 50 ? [] : (byManager.get(a.id) ?? []).map((r) => build(r, depth + 1)),
  });
  return (byManager.get(null) ?? []).map((a) => build(a, 0));
}
