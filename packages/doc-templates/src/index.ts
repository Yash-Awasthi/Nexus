// SPDX-License-Identifier: Apache-2.0

// ── Types ─────────────────────────────────────────────────────────────────────

export type TemplateType =
  | "adr"
  | "runbook"
  | "incident"
  | "prd"
  | "meeting"
  | "weekly"
  | "postmortem"
  | (string & {});

/** Template section interface definition. */
export interface TemplateSection {
  heading: string;
  /** Heading depth (default: 2). */
  level?: 2 | 3;
  /** Placeholder text shown as a markdown comment inside the section. */
  placeholder?: string;
  required?: boolean;
}

/** Frontmatter field interface definition. */
export interface FrontmatterField {
  key: string;
  /** Default value used when the variable is not provided. */
  default?: string;
  required?: boolean;
}

/** Doc template interface definition. */
export interface DocTemplate {
  id: string;
  type: TemplateType;
  name: string;
  description?: string;
  frontmatter?: FrontmatterField[];
  sections: TemplateSection[];
  metadata?: Record<string, unknown>;
}

// ── Template rendering ────────────────────────────────────────────────────────

/**
 * Interpolate `{{key}}` placeholders in text using variables.
 * Unmatched placeholders are left as-is.
 */
export function interpolate(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => variables[key] ?? `{{${key}}}`);
}

function renderFrontmatter(fields: FrontmatterField[], variables: Record<string, string>): string {
  if (!fields.length) return "";
  const lines = fields.map((f) => {
    const value = variables[f.key] ?? f.default ?? "";
    return `${f.key}: ${value || (f.required ? `# REQUIRED: ${f.key}` : "")}`;
  });
  return `---\n${lines.join("\n")}\n---\n\n`;
}

function renderSection(section: TemplateSection, variables: Record<string, string>): string {
  const hashes = "#".repeat(section.level ?? 2);
  const heading = interpolate(section.heading, variables);
  const body = section.placeholder ? `\n${interpolate(section.placeholder, variables)}\n` : "";
  return `${hashes} ${heading}\n${body}`;
}

/**
 * Render a DocTemplate into a markdown string.
 * @param template   The template definition.
 * @param variables  Key-value pairs used for `{{key}}` interpolation and frontmatter fields.
 */
export function renderTemplate(
  template: DocTemplate,
  variables: Record<string, string> = {},
): string {
  const parts: string[] = [];

  // Frontmatter
  if (template.frontmatter?.length) {
    parts.push(renderFrontmatter(template.frontmatter, variables));
  }

  // Title
  const title = variables.title ?? template.name;
  parts.push(`# ${interpolate(title, variables)}\n\n`);

  // Sections
  for (const section of template.sections) {
    parts.push(renderSection(section, variables));
    parts.push("\n");
  }

  return parts.join("").trimEnd() + "\n";
}

// ── TemplateRegistry ──────────────────────────────────────────────────────────

export class TemplateRegistry {
  private readonly _templates = new Map<string, DocTemplate>();

  register(template: DocTemplate): void {
    if (!template.id.trim()) throw new TemplateError("Template id must be non-empty", "INVALID_ID");
    this._templates.set(template.id, template);
  }

  unregister(id: string): boolean {
    return this._templates.delete(id);
  }

  get(id: string): DocTemplate | undefined {
    return this._templates.get(id);
  }

  list(type?: TemplateType): DocTemplate[] {
    const all = Array.from(this._templates.values());
    return type ? all.filter((t) => t.type === type) : all;
  }

  render(id: string, variables: Record<string, string> = {}): string {
    const template = this._templates.get(id);
    if (!template) throw new TemplateError(`Template not found: ${id}`, "NOT_FOUND");
    return renderTemplate(template, variables);
  }

  size(): number {
    return this._templates.size;
  }

  /** Create a registry pre-loaded with all built-in templates. */
  static withBuiltins(): TemplateRegistry {
    const r = new TemplateRegistry();
    for (const t of ALL_BUILTIN_TEMPLATES) r.register(t);
    return r;
  }
}

// ── Error ─────────────────────────────────────────────────────────────────────

export class TemplateError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "TemplateError";
    this.code = code;
  }
}

// ── Built-in templates ────────────────────────────────────────────────────────

export const ADR_TEMPLATE: DocTemplate = {
  id: "builtin:adr",
  type: "adr",
  name: "Architecture Decision Record",
  description: "Captures an architectural decision with its context and consequences.",
  frontmatter: [
    { key: "status", default: "proposed", required: true },
    { key: "date", required: true },
    { key: "deciders", default: "" },
  ],
  sections: [
    {
      heading: "Context and Problem Statement",
      placeholder: "<!-- Describe the context and the problem you're facing -->",
    },
    {
      heading: "Decision Drivers",
      placeholder: "<!-- List the factors influencing this decision -->",
    },
    { heading: "Considered Options", placeholder: "<!-- List the options considered -->" },
    { heading: "Decision Outcome", placeholder: "<!-- State the chosen option and why -->" },
    {
      heading: "Consequences",
      placeholder: "<!-- Describe the positive and negative consequences -->",
    },
  ],
};

/** Runbook template. */
export const RUNBOOK_TEMPLATE: DocTemplate = {
  id: "builtin:runbook",
  type: "runbook",
  name: "Runbook",
  description: "Step-by-step operational runbook for a recurring procedure.",
  frontmatter: [
    { key: "service", required: true },
    { key: "owner", default: "" },
    { key: "last_updated", default: "" },
  ],
  sections: [
    { heading: "Overview", placeholder: "<!-- Brief description of what this runbook covers -->" },
    {
      heading: "Prerequisites",
      placeholder: "<!-- List any prerequisites, access requirements, or tools needed -->",
    },
    { heading: "Steps", placeholder: "<!-- Numbered steps to execute the procedure -->" },
    { heading: "Verification", placeholder: "<!-- How to verify the procedure succeeded -->" },
    {
      heading: "Rollback",
      placeholder: "<!-- Steps to undo this procedure if something goes wrong -->",
    },
    { heading: "Escalation", placeholder: "<!-- Who to contact and when to escalate -->" },
  ],
};

/** Incident template. */
export const INCIDENT_TEMPLATE: DocTemplate = {
  id: "builtin:incident",
  type: "incident",
  name: "Incident Report",
  description: "Documents an incident with timeline, impact, root cause, and action items.",
  frontmatter: [
    { key: "severity", default: "P2", required: true },
    { key: "status", default: "investigating" },
    { key: "incident_date", required: true },
    { key: "incident_commander", default: "" },
  ],
  sections: [
    { heading: "Incident Summary", placeholder: "<!-- One-paragraph summary of what happened -->" },
    { heading: "Timeline", placeholder: "<!-- Chronological list of events with timestamps -->" },
    {
      heading: "Impact",
      placeholder: "<!-- Describe impact: users affected, revenue, SLA breach, etc. -->",
    },
    { heading: "Root Cause Analysis", placeholder: "<!-- What caused the incident -->" },
    {
      heading: "Contributing Factors",
      placeholder: "<!-- Other factors that contributed to the incident -->",
    },
    {
      heading: "Action Items",
      placeholder: "<!-- Remediation tasks with owners and due dates -->",
    },
  ],
};

/** Prd template. */
export const PRD_TEMPLATE: DocTemplate = {
  id: "builtin:prd",
  type: "prd",
  name: "Product Requirements Document",
  description: "Defines the goals, requirements, and success metrics for a product feature.",
  frontmatter: [
    { key: "feature", required: true },
    { key: "author", required: true },
    { key: "status", default: "draft" },
    { key: "target_date", default: "" },
  ],
  sections: [
    { heading: "Problem Statement", placeholder: "<!-- What problem does this solve? -->" },
    { heading: "Goals", placeholder: "<!-- What outcomes do we want to achieve? -->" },
    { heading: "Non-Goals", placeholder: "<!-- What is explicitly out of scope? -->" },
    { heading: "Requirements", placeholder: "<!-- Functional and non-functional requirements -->" },
    {
      heading: "User Stories",
      placeholder: "<!-- As a [user], I want [goal] so that [reason] -->",
    },
    { heading: "Success Metrics", placeholder: "<!-- How will we know this is successful? -->" },
    { heading: "Open Questions", placeholder: "<!-- Unresolved questions or decisions -->" },
  ],
};

/** Meeting template. */
export const MEETING_TEMPLATE: DocTemplate = {
  id: "builtin:meeting",
  type: "meeting",
  name: "Meeting Notes",
  description: "Structured meeting notes with agenda, decisions, and action items.",
  frontmatter: [
    { key: "date", required: true },
    { key: "attendees", default: "" },
    { key: "facilitator", default: "" },
  ],
  sections: [
    { heading: "Agenda", placeholder: "<!-- List agenda items -->" },
    { heading: "Discussion", placeholder: "<!-- Notes on each agenda item -->" },
    { heading: "Decisions Made", placeholder: "<!-- List decisions made during the meeting -->" },
    { heading: "Action Items", placeholder: "<!-- Owner: Task (Due date) -->" },
    { heading: "Next Meeting", placeholder: "<!-- Date and proposed agenda for next meeting -->" },
  ],
};

/** Weekly template. */
export const WEEKLY_TEMPLATE: DocTemplate = {
  id: "builtin:weekly",
  type: "weekly",
  name: "Weekly Notes",
  description: "Weekly team or personal progress update.",
  frontmatter: [
    { key: "week_of", required: true },
    { key: "team", default: "" },
  ],
  sections: [
    { heading: "Highlights", placeholder: "<!-- Key accomplishments this week -->" },
    { heading: "In Progress", placeholder: "<!-- Work currently ongoing -->" },
    { heading: "Blockers", placeholder: "<!-- What is blocking progress -->" },
    { heading: "Next Week", placeholder: "<!-- Planned work for next week -->" },
    { heading: "Metrics", placeholder: "<!-- Key metrics for this week -->" },
  ],
};

/** Postmortem template. */
export const POSTMORTEM_TEMPLATE: DocTemplate = {
  id: "builtin:postmortem",
  type: "postmortem",
  name: "Postmortem",
  description: "Blameless postmortem to understand and improve after an incident.",
  frontmatter: [
    { key: "incident_date", required: true },
    { key: "severity", default: "P2" },
    { key: "duration", default: "" },
    { key: "author", required: true },
  ],
  sections: [
    { heading: "Executive Summary", placeholder: "<!-- Brief description for leadership -->" },
    { heading: "What Happened", placeholder: "<!-- Narrative of the incident -->" },
    { heading: "Timeline", placeholder: "<!-- Chronological events -->" },
    { heading: "Root Cause", placeholder: "<!-- The fundamental cause(s) -->" },
    { heading: "What Went Well", placeholder: "<!-- Detection, response, communication wins -->" },
    {
      heading: "What Could Be Improved",
      placeholder: "<!-- Process, tooling, or communication gaps -->",
    },
    {
      heading: "Action Items",
      placeholder: "<!-- Concrete follow-up tasks with owners and dates -->",
    },
  ],
};

/** All builtin templates. */
export const ALL_BUILTIN_TEMPLATES: DocTemplate[] = [
  ADR_TEMPLATE,
  RUNBOOK_TEMPLATE,
  INCIDENT_TEMPLATE,
  PRD_TEMPLATE,
  MEETING_TEMPLATE,
  WEEKLY_TEMPLATE,
  POSTMORTEM_TEMPLATE,
];
