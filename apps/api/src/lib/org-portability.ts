// SPDX-License-Identifier: Apache-2.0
/**
 * Companies as files: export one to a JSON bundle, import a bundle as a new
 * company, and start from a built-in template.
 *
 * A bundle refers to agents and goals by local refs, never by id, so it moves
 * between accounts and machines. It carries no secrets: header values other
 * than `secret:NAME` references are replaced, working directories (machine
 * specific) are dropped, and routine webhook keys are not exported. Importing
 * goes through the normal create paths, so a company that holds hires for
 * approval holds imported ones too.
 *
 * The export/import shape and secret scrubbing follow Paperclip's company
 * portability — https://github.com/paperclipai/paperclip, MIT License,
 * Copyright (c) 2025 Paperclip AI.
 */

import {
  listPolicies,
  upsertPolicy,
  toUsd,
  type ScopeType,
  type WindowKind,
} from "./org-budget.js";
import { addLesson, listLessons, type LessonKind } from "./org-memory.js";
import { createRoutine, listRoutines } from "./org-scheduler.js";
import {
  OrgError,
  createAgent,
  createCompany,
  getCompany,
  invalid,
  listAgents,
  listCompanies,
  updateAgent,
  type AdapterType,
  type Company,
  type HeartbeatPolicy,
} from "./org-store.js";
import { createGoal, listGoals, type GoalLevel, type GoalStatus } from "./org-work.js";

export const BUNDLE_FORMAT = "nexus-company/1";

export interface CompanyBundle {
  format: typeof BUNDLE_FORMAT;
  company: {
    name: string;
    mission: string;
    description: string;
    requireHireApproval: boolean;
    councilReviewsApprovals: boolean;
    councilGatesDone?: boolean;
    replaysWhilePaused?: boolean;
  };
  agents: {
    ref: string;
    name: string;
    role: string;
    title: string;
    reportsTo: string | null;
    capabilities: string;
    instructions: string;
    model: string | null;
    adapterType: AdapterType;
    adapterConfig: Record<string, unknown>;
    heartbeat: HeartbeatPolicy;
    skills: string[];
    secretNames: string[];
  }[];
  goals: {
    ref: string;
    title: string;
    description: string;
    level: GoalLevel;
    parent: string | null;
    status: GoalStatus;
  }[];
  routines: {
    title: string;
    description: string;
    assignee: string;
    priority: string;
    goal: string | null;
    cron: string | null;
    concurrency: string;
  }[];
  budgets: {
    scopeType: ScopeType;
    scope: string | null;
    windowKind: WindowKind;
    amountUsd: number;
    warnPercent: number;
    hardStop: boolean;
  }[];
  lessons: { kind: LessonKind; text: string }[];
}

/** Adapter config without anything that is a secret or only true on this machine. */
export function scrub(config: Record<string, unknown>): Record<string, unknown> {
  const { cwd: _cwd, ...rest } = config;
  if (rest.headers && typeof rest.headers === "object") {
    rest.headers = Object.fromEntries(
      Object.entries(rest.headers as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === "string" && /^secret:[A-Z][A-Z0-9_]*$/.test(v) ? v : "secret:REPLACE_ME",
      ]),
    );
  }
  return rest;
}

export function exportCompany(
  ownerId: string,
  companyId: string,
  withLessons = true,
): CompanyBundle {
  const c = getCompany(ownerId, companyId);
  const agents = listAgents(ownerId, companyId).filter((a) => a.status !== "terminated");
  const agentRef = new Map(agents.map((a, i) => [a.id, `agent-${i + 1}`]));
  const goals = listGoals(ownerId, companyId);
  const goalRef = new Map(goals.map((g, i) => [g.id, `goal-${i + 1}`]));
  return {
    format: BUNDLE_FORMAT,
    company: {
      name: c.name,
      mission: c.mission,
      description: c.description,
      requireHireApproval: c.requireHireApproval,
      councilReviewsApprovals: c.councilReviewsApprovals === true,
      councilGatesDone: c.councilGatesDone === true,
      replaysWhilePaused: c.replaysWhilePaused === true,
    },
    agents: agents.map((a) => ({
      ref: agentRef.get(a.id)!,
      name: a.name,
      role: a.role,
      title: a.title,
      reportsTo: a.reportsTo ? (agentRef.get(a.reportsTo) ?? null) : null,
      capabilities: a.capabilities,
      instructions: a.instructions,
      model: a.model,
      adapterType: a.adapterType,
      adapterConfig: scrub(a.adapterConfig),
      heartbeat: a.heartbeat,
      skills: a.skills,
      secretNames: a.secretNames,
    })),
    goals: goals.map((g) => ({
      ref: goalRef.get(g.id)!,
      title: g.title,
      description: g.description,
      level: g.level,
      parent: g.parentId ? (goalRef.get(g.parentId) ?? null) : null,
      status: g.status,
    })),
    routines: listRoutines(ownerId, companyId)
      .filter((r) => agentRef.has(r.assigneeAgentId))
      .map((r) => ({
        title: r.title,
        description: r.description,
        assignee: agentRef.get(r.assigneeAgentId)!,
        priority: r.priority,
        goal: r.goalId ? (goalRef.get(r.goalId) ?? null) : null,
        cron: r.cron,
        concurrency: r.concurrency,
      })),
    budgets: listPolicies(ownerId, companyId).flatMap((p) => {
      const scope =
        p.scopeType === "company"
          ? null
          : p.scopeType === "agent"
            ? agentRef.get(p.scopeId)
            : goalRef.get(p.scopeId);
      if (p.scopeType !== "company" && !scope) return [];
      return [
        {
          scopeType: p.scopeType,
          scope: scope ?? null,
          windowKind: p.windowKind,
          amountUsd: toUsd(p.amountMicros),
          warnPercent: p.warnPercent,
          hardStop: p.hardStop,
        },
      ];
    }),
    lessons: withLessons
      ? listLessons(ownerId, companyId)
          .slice(0, 200)
          .map((l) => ({ kind: l.kind, text: l.text }))
      : [],
  };
}

function uniqueName(ownerId: string, wanted: string): string {
  const taken = new Set(listCompanies(ownerId).map((c) => c.name));
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; ; i++) if (!taken.has(`${wanted} (${i})`)) return `${wanted} (${i})`;
}

/** Create a new company from a bundle. Returns it; the bundle is validated as it goes. */
export function importCompany(ownerId: string, raw: unknown, nameOverride?: string): Company {
  const b = raw as Partial<CompanyBundle> | null;
  if (!b || b.format !== BUNDLE_FORMAT || !b.company?.name)
    throw invalid(`Not a ${BUNDLE_FORMAT} bundle.`);
  if (JSON.stringify(b).length > 2_000_000) throw invalid("The bundle is too large.");
  const agents = Array.isArray(b.agents) ? b.agents.slice(0, 200) : [];
  const goals = Array.isArray(b.goals) ? b.goals.slice(0, 500) : [];

  const company = createCompany(ownerId, {
    name: uniqueName(ownerId, (nameOverride?.trim() || b.company.name).slice(0, 120)),
    mission: b.company.mission,
    description: b.company.description,
    requireHireApproval: b.company.requireHireApproval,
    councilReviewsApprovals: b.company.councilReviewsApprovals,
    councilGatesDone: b.company.councilGatesDone === true,
    replaysWhilePaused: b.company.replaysWhilePaused === true,
  });

  // Agents first without managers, then wire reporting lines once every ref exists.
  const agentIds = new Map<string, string>();
  for (const a of agents) {
    const created = createAgent(ownerId, company.id, {
      name: a.name,
      role: a.role,
      title: a.title,
      capabilities: a.capabilities,
      instructions: a.instructions,
      model: a.model,
      adapterType: a.adapterType,
      adapterConfig: a.adapterConfig,
      heartbeat: a.heartbeat,
      skills: a.skills,
      secretNames: a.secretNames,
    });
    agentIds.set(a.ref, created.id);
  }
  for (const a of agents) {
    const manager = a.reportsTo ? agentIds.get(a.reportsTo) : undefined;
    const self = agentIds.get(a.ref);
    if (manager && self) updateAgent(ownerId, self, { reportsTo: manager });
  }

  const goalIds = new Map<string, string>();
  const pending = [...goals];
  // Parents before children, whatever order the bundle lists them in.
  for (let pass = 0; pending.length && pass < 50; pass++) {
    for (let i = 0; i < pending.length;) {
      const g = pending[i]!;
      if (g.parent && !goalIds.has(g.parent)) {
        i++;
        continue;
      }
      const created = createGoal(ownerId, company.id, {
        title: g.title,
        description: g.description,
        level: g.level,
        status: g.status,
        parentId: g.parent ? goalIds.get(g.parent) : null,
      });
      goalIds.set(g.ref, created.id);
      pending.splice(i, 1);
    }
  }

  for (const r of (Array.isArray(b.routines) ? b.routines : []).slice(0, 100)) {
    const assignee = agentIds.get(r.assignee);
    if (!assignee) continue;
    createRoutine(ownerId, company.id, {
      title: r.title,
      description: r.description,
      assigneeAgentId: assignee,
      priority: r.priority,
      goalId: r.goal ? (goalIds.get(r.goal) ?? null) : null,
      cron: r.cron,
      concurrency: r.concurrency,
    });
  }

  for (const p of (Array.isArray(b.budgets) ? b.budgets : []).slice(0, 100)) {
    const scopeId =
      p.scopeType === "company"
        ? company.id
        : p.scopeType === "agent"
          ? agentIds.get(p.scope ?? "")
          : goalIds.get(p.scope ?? "");
    if (!scopeId) continue;
    upsertPolicy(ownerId, company.id, {
      scopeType: p.scopeType,
      scopeId,
      windowKind: p.windowKind,
      amountUsd: p.amountUsd,
      warnPercent: p.warnPercent,
      hardStop: p.hardStop,
    });
  }

  for (const l of (Array.isArray(b.lessons) ? b.lessons : []).slice(0, 200)) {
    if (typeof l.text !== "string" || !l.text.trim()) continue;
    addLesson({
      ownerId,
      companyId: company.id,
      agentId: null,
      kind: ["outcome", "feedback", "decision"].includes(l.kind) ? l.kind : "note",
      text: l.text,
      source: null,
    });
  }
  return getCompany(ownerId, company.id);
}

// ── Templates ────────────────────────────────────────────────────────────────

const hb = (enabled = false, cron: string | null = null): HeartbeatPolicy => ({
  enabled,
  intervalSec: 3600,
  cron,
  wakeOnAssign: true,
});

function agent(
  ref: string,
  name: string,
  role: string,
  title: string,
  reportsTo: string | null,
  capabilities: string,
  instructions = "",
) {
  return {
    ref,
    name,
    role,
    title,
    reportsTo,
    capabilities,
    instructions,
    model: null,
    adapterType: "nexus" as AdapterType,
    adapterConfig: {},
    heartbeat: hb(),
    skills: [],
    secretNames: [],
  };
}

const base = (name: string, mission: string) => ({
  format: BUNDLE_FORMAT as typeof BUNDLE_FORMAT,
  company: {
    name,
    mission,
    description: "",
    requireHireApproval: false,
    councilReviewsApprovals: false,
  },
  lessons: [],
});

export const TEMPLATES: { id: string; name: string; description: string; bundle: CompanyBundle }[] =
  [
    {
      id: "content-studio",
      name: "Content studio",
      description:
        "An editor who plans and delegates, a researcher and a writer, and a weekly newsletter routine.",
      bundle: {
        ...base("Content studio", "Publish one genuinely useful article every week."),
        agents: [
          agent(
            "editor",
            "Maya",
            "editor",
            "Editor-in-chief",
            null,
            "Plans issues, splits them into research and writing, reviews drafts.",
            "Delegate research and drafting to your team; review before calling anything done.",
          ),
          agent(
            "researcher",
            "Ravi",
            "researcher",
            "Researcher",
            "editor",
            "Finds sources and facts, summarises them with links.",
          ),
          agent(
            "writer",
            "Wen",
            "writer",
            "Staff writer",
            "editor",
            "Turns research into clear, friendly prose.",
          ),
        ],
        goals: [
          {
            ref: "g1",
            title: "Grow to 1,000 newsletter readers",
            description: "",
            level: "company",
            parent: null,
            status: "active",
          },
        ],
        routines: [
          {
            title: "Plan this week's article",
            description: "Pick a topic our readers need, then delegate research and writing.",
            assignee: "editor",
            priority: "high",
            goal: "g1",
            cron: "0 9 * * 1",
            concurrency: "skip_if_active",
          },
        ],
        budgets: [
          {
            scopeType: "company",
            scope: null,
            windowKind: "month",
            amountUsd: 5,
            warnPercent: 80,
            hardStop: true,
          },
        ],
      },
    },
    {
      id: "software-team",
      name: "Software team",
      description:
        "A tech lead who plans and reviews, an engineer and a tester. Swap the engineer to Claude Code or Codex to write real code.",
      bundle: {
        ...base("Software team", "Ship small, well-tested improvements every day."),
        agents: [
          agent(
            "lead",
            "Tara",
            "cto",
            "Tech lead",
            null,
            "Breaks features into tasks, reviews plans, keeps quality high.",
            "Plan before building. Give every engineering task clear acceptance criteria.",
          ),
          agent(
            "engineer",
            "Eli",
            "engineer",
            "Software engineer",
            "lead",
            "Implements tasks with tests.",
          ),
          agent(
            "tester",
            "Quinn",
            "qa",
            "QA engineer",
            "lead",
            "Writes test plans and finds edge cases.",
          ),
        ],
        goals: [
          {
            ref: "g1",
            title: "Reach a stable 1.0",
            description: "",
            level: "company",
            parent: null,
            status: "active",
          },
        ],
        routines: [],
        budgets: [
          {
            scopeType: "company",
            scope: null,
            windowKind: "day",
            amountUsd: 2,
            warnPercent: 80,
            hardStop: true,
          },
        ],
      },
    },
    {
      id: "research-desk",
      name: "Research desk",
      description:
        "A lead analyst and two analysts that answer questions with sources; every task defaults to answer-only.",
      bundle: {
        ...base(
          "Research desk",
          "Answer the board's questions quickly, with sources and a confidence level.",
        ),
        agents: [
          agent(
            "lead",
            "Ana",
            "lead-analyst",
            "Lead analyst",
            null,
            "Frames questions and assigns them.",
            "State a confidence level with every answer.",
          ),
          agent("a1", "Sol", "analyst", "Market analyst", "lead", "Markets, competitors, pricing."),
          agent(
            "a2",
            "Kit",
            "analyst",
            "Technical analyst",
            "lead",
            "Technology, standards, feasibility.",
          ),
        ],
        goals: [],
        routines: [],
        budgets: [
          {
            scopeType: "company",
            scope: null,
            windowKind: "month",
            amountUsd: 3,
            warnPercent: 80,
            hardStop: true,
          },
        ],
      },
    },
  ];

export function instantiateTemplate(ownerId: string, id: string, name?: string): Company {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new OrgError(404, "not_found", "Template not found.");
  return importCompany(ownerId, t.bundle, name);
}
