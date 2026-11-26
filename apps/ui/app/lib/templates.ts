// SPDX-License-Identifier: Apache-2.0
/**
 * The built-in template gallery: starting points, not a marketplace.
 *
 * Two kinds, from two owners, and the split is deliberate:
 *
 *  - **Companies** already have a registry on the server (`apps/api/src/lib/org-portability.ts`):
 *    three opinionated setups instantiated by `POST /org/templates/:id`. The gallery lists those
 *    and creates them by id. Copying them into the UI would mean two definitions of a company
 *    that could disagree — the exact duplication this codebase keeps deleting — so the UI holds
 *    only a reference and a `version` for what it shows.
 *  - **Workflows** have no server registry, because a workflow's steps depend on which models
 *    this deployment has. Their templates live here as data: a list of step definitions, the same
 *    shape `POST /api/workflows` accepts, readable before anything is created.
 *
 * Nothing is installed, fetched or version-resolved at run time: a template is either a row in
 * the server's registry or a constant in this file, so "version 1.0.0" names something that
 * exists in the repository you are reading.
 */

/** A workflow step, in the shape `workflows.tsx` compiles and the run endpoint executes. */
export type TemplateStep =
  | { kind: "agent"; id: string; name: string; model?: string; task: string }
  | { kind: "fn"; id: string; name: string; transform: "data" }
  | { kind: "condition"; id: string; name: string; conditionResult: boolean };

interface TemplateBase {
  /** Stable forever: a saved link and a support ticket both point at it. */
  id: string;
  name: string;
  /** Semver of the template *as this UI presents it*. A shape change is a new major. */
  version: string;
  summary: string;
  tags: string[];
  /** What to change once it exists. Never empty — see the doc comment on `notes` in the route. */
  notes: string;
}

export interface WorkflowTemplate extends TemplateBase {
  kind: "workflow";
  steps: TemplateStep[];
  /** Cron expression, or null for a manual workflow. */
  schedule: string | null;
}

/** A company setup this server offers, as `GET /org/templates` describes it. */
export interface CompanyTemplateRef extends TemplateBase {
  kind: "company";
  mission: string;
  /** `"Name (Title)"` strings, straight from the server: shown, never parsed back. */
  agents: string[];
}

export type Template = WorkflowTemplate | CompanyTemplateRef;

/** The version of the server's company registry this file was written against. */
export const COMPANY_REGISTRY_VERSION = "1.0.0";

const RESEARCH_BRIEF: WorkflowTemplate = {
  id: "workflow.research-brief",
  name: "Research brief",
  version: "1.0.0",
  kind: "workflow",
  summary: "Gather, draft and critique a one-page brief on a question. Three model steps, no tools.",
  tags: ["research", "brief", "writing"],
  notes:
    "Set the question in the run input. Swap the second agent for one whose model you trust on your own domain; the critique step is the one that catches a weak draft.",
  schedule: null,
  steps: [
    {
      kind: "agent",
      id: "collect",
      name: "Collect",
      task: "List what a careful analyst would need to know to answer the question. Name the gaps.",
    },
    {
      kind: "agent",
      id: "draft",
      name: "Draft",
      task: "Write a one-page brief from the collected points. Lead with the conclusion, then the evidence, then the open questions.",
    },
    {
      kind: "agent",
      id: "critique",
      name: "Critique",
      task: "Read the draft as a sceptical editor. Name the weakest claim and what would settle it.",
    },
    { kind: "fn", id: "emit", name: "Emit", transform: "data" },
  ],
};

const WEEKLY_DIGEST: WorkflowTemplate = {
  id: "workflow.weekly-digest",
  name: "Weekly digest",
  version: "1.0.0",
  kind: "workflow",
  summary: "A scheduled Monday summary: what changed, what needs a decision, what can wait.",
  tags: ["reporting", "scheduled", "ops"],
  notes:
    "Point the first step at the sources you actually read, and edit the prompt so it says where the week's data comes from. The schedule is Monday 08:00 UTC.",
  schedule: "0 8 * * 1",
  steps: [
    {
      kind: "agent",
      id: "gather",
      name: "Gather",
      task: "Summarise what changed this week in the workflow input. Group by area, keep it factual.",
    },
    {
      kind: "agent",
      id: "decide",
      name: "Decisions",
      task: "From the summary, list only the items that need a human decision, each with the recommendation and the cost of waiting.",
    },
    { kind: "fn", id: "emit", name: "Emit", transform: "data" },
  ],
};

const PR_REVIEW_SWEEP: WorkflowTemplate = {
  id: "workflow.pr-review-sweep",
  name: "Change review sweep",
  version: "1.0.0",
  kind: "workflow",
  summary: "Review a change three ways — correctness, tests, and what it breaks — then gate on a verdict.",
  tags: ["code", "review", "quality"],
  notes:
    "Paste the diff into the run input. The condition step is a literal gate: wire it to a real check before relying on it, or drop it and read the three reviews.",
  schedule: null,
  steps: [
    {
      kind: "agent",
      id: "correctness",
      name: "Correctness",
      task: "Read the change for correctness: off-by-one, null paths, error handling, concurrency. Cite the lines.",
    },
    {
      kind: "agent",
      id: "tests",
      name: "Tests",
      task: "Name the behaviour this change alters and the test that would have caught it being wrong. Say if that test exists.",
    },
    {
      kind: "agent",
      id: "blast",
      name: "Blast radius",
      task: "List what else reads or writes what this change touches, and what would break first in production.",
    },
    { kind: "condition", id: "gate", name: "Gate", conditionResult: true },
    { kind: "fn", id: "emit", name: "Emit", transform: "data" },
  ],
};

const INCIDENT_POSTMORTEM: WorkflowTemplate = {
  id: "workflow.incident-postmortem",
  name: "Incident postmortem",
  version: "1.0.0",
  kind: "workflow",
  summary: "Timeline, cause, and the change that would have prevented it — from an incident log.",
  tags: ["ops", "incident", "review"],
  notes:
    "Paste the incident timeline into the run input, timestamps included. The last step deliberately asks for one prevention, not five: a postmortem with five actions has none.",
  schedule: null,
  steps: [
    {
      kind: "agent",
      id: "timeline",
      name: "Timeline",
      task: "Turn the incident log into a timeline of what happened and when. Mark the detection point and the recovery point.",
    },
    {
      kind: "agent",
      id: "cause",
      name: "Cause",
      task: "Name the cause, then the cause of the cause, until you reach something a person can change. Do not stop at 'human error'.",
    },
    {
      kind: "agent",
      id: "prevent",
      name: "Prevention",
      task: "Propose the single change that would have prevented this. Say what it costs and what it would still not catch.",
    },
    { kind: "fn", id: "emit", name: "Emit", transform: "data" },
  ],
};

/** The workflow templates, in the order the gallery shows them. */
export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  RESEARCH_BRIEF,
  WEEKLY_DIGEST,
  PR_REVIEW_SWEEP,
  INCIDENT_POSTMORTEM,
];

/**
 * How each server company template is presented here. The server owns the company — its agents,
 * instructions and routines — so this map carries only what the server's list endpoint does not:
 * a version and the sentence about what to edit afterwards. A server template with no entry here
 * is still listed; it simply has no notes.
 */
const COMPANY_PRESENTATION: Record<string, { version: string; tags: string[]; notes: string }> = {
  "content-studio": {
    version: "1.0.0",
    tags: ["writing", "editorial", "team"],
    notes:
      "The fact-checker reviews against the source you give it, so put the source in the task. Change the editor's cadence before the first week; weekly is the default and not always right.",
  },
  "software-team": {
    version: "1.0.0",
    tags: ["engineering", "team", "review"],
    notes:
      "Decide who may merge before the first task, or the reviewer agent will approve its own work. The routines assume a daily standup the team does not have yet.",
  },
  "research-desk": {
    version: "1.0.0",
    tags: ["research", "analysis", "team"],
    notes:
      "Attach the knowledge bases the desk should work from; without them it answers from memory. The desk's instructions reward saying “I could not find out”, which is the point.",
  },
};

/** What `GET /org/templates` returns, as far as the gallery cares. */
export interface ServerTemplate {
  id: string;
  name: string;
  description: string;
  agents: string[];
}

/** Turn the server's list into gallery entries, keeping this file's presentation. */
export function companyTemplateFrom(server: ServerTemplate): CompanyTemplateRef {
  const presentation = COMPANY_PRESENTATION[server.id];
  return {
    kind: "company",
    id: server.id,
    name: server.name,
    version: presentation?.version ?? COMPANY_REGISTRY_VERSION,
    summary: server.description,
    tags: presentation?.tags ?? ["company"],
    notes:
      presentation?.notes ??
      "This server offers it; edit the agents' instructions to your own situation before the first task.",
    mission: "",
    agents: server.agents,
  };
}

/** True when this repository ships a presentation for every server template the test knows. */
export function presentationFor(id: string): { version: string; tags: string[]; notes: string } | undefined {
  return COMPANY_PRESENTATION[id];
}

/** Everything the gallery can show before it talks to the server. */
export const TEMPLATES: Template[] = [...WORKFLOW_TEMPLATES];

/** The full list once the server has answered: workflow templates plus its company setups. */
export function allTemplates(server: ServerTemplate[]): Template[] {
  const companies = server.map(companyTemplateFrom);
  // Workflows first: they are what most people come for, and they need no setup.
  return [...WORKFLOW_TEMPLATES, ...companies];
}

/** Look one up by id. */
export function templateById(id: string, server: ServerTemplate[] = []): Template | undefined {
  return allTemplates(server).find((t) => t.id === id);
}

/**
 * Case-insensitive search over id, name, summary and tags, plus an optional kind filter.
 *
 * The id is searched because that is what a support ticket, a saved link and the API all use —
 * `workflow.incident-postmortem` should find the postmortem template. Hyphens and spaces are
 * treated as the same character, so `research-brief` and `research brief` both match.
 */
export function filterTemplates(
  templates: Template[],
  query: string,
  kind: Template["kind"] | "all" = "all",
): Template[] {
  const normalise = (text: string) => text.toLowerCase().replace(/[-_.]+/g, " ").trim();
  const q = normalise(query);
  return templates.filter((t) => {
    if (kind !== "all" && t.kind !== kind) return false;
    if (!q) return true;
    return (
      normalise(t.id).includes(q) ||
      normalise(t.name).includes(q) ||
      normalise(t.summary).includes(q) ||
      t.tags.some((tag) => normalise(tag).includes(q))
    );
  });
}

export interface TemplateRequest {
  method: "POST";
  url: string;
  body: Record<string, unknown>;
}

/**
 * The one API call "Use template" makes.
 *
 * A workflow is posted with its steps; a company is instantiated by the server from its own
 * bundle, so the UI sends a name and nothing else. One request either way — which is why this
 * returns a single request and not a plan: there is no ordering to get wrong any more.
 */
export function templateRequest(template: Template, name?: string): TemplateRequest {
  const chosen = name?.trim() || template.name;
  if (template.kind === "workflow") {
    return {
      method: "POST",
      url: "/api/workflows",
      body: {
        name: chosen,
        steps: template.steps,
        ...(template.schedule ? { schedule: template.schedule } : {}),
      },
    };
  }
  return {
    method: "POST",
    url: `/api/org/templates/${encodeURIComponent(template.id)}`,
    body: { name: chosen },
  };
}
