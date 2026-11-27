// SPDX-License-Identifier: Apache-2.0
// design-tokens-allow-file: standalone document — docToHtml() returns a complete HTML file that is opened outside the app, so it must carry its own colours
/**
 * Print and PDF export: the page the user is looking at, on paper.
 *
 * The tempting implementation is a second renderer — build a "report" HTML, POST it somewhere,
 * download a PDF. Two things go wrong with that. The report drifts from the page (a number that
 * is right on screen and wrong on paper), and it needs a server that can typeset. So this module
 * does the cheap, honest thing instead: it takes the **same data the page already holds**, turns
 * it into a flat structure, and lets the browser's own print dialog produce the PDF. That is why
 * every `PrintableDoc` here is built from the exact props the page renders, and why there is no
 * HTML string anywhere in this file — the escaping bugs live in HTML strings.
 *
 * `docToMarkdown` exists for the "copy as Markdown" path and for tests: a document you can diff.
 * `docToHtml` is used only for the print header the browser needs, and it escapes everything.
 */

export interface PrintSection {
  heading: string;
  /** Plain text. Blank lines separate paragraphs; the printer keeps them apart. */
  body: string;
  /** Set for an ordered list, such as a ledger of contributions. */
  items?: string[];
  /** Small print under the section, such as a reason a run stopped. */
  note?: string;
}

export interface PrintableDoc {
  title: string;
  /** One line of context: the question asked, the workflow, the company's mission. */
  subtitle?: string;
  /** ISO timestamp. Callers pass one in so the document is reproducible in a test. */
  generatedAt: string;
  /** `key: value` pairs printed under the title, in order. */
  meta: { label: string; value: string }[];
  sections: PrintSection[];
}

/** The filename a PDF saves as, without the extension. Safe, and never opaque. */
export function printFileName(doc: PrintableDoc): string {
  const slug = `${doc.title} ${doc.generatedAt.slice(0, 10)}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  // A title of only punctuation leaves just the date, which is a file nobody can identify in a
  // downloads folder later.
  if (!slug) return "nexus-document";
  return /[a-z]/.test(slug) ? slug : `nexus-${slug}`;
}

/** A document as Markdown: headings, then the meta table as a list, then the sections. */
export function docToMarkdown(doc: PrintableDoc): string {
  const lines: string[] = [`# ${doc.title}`, ""];
  if (doc.subtitle) lines.push(`> ${doc.subtitle}`, "");
  if (doc.meta.length) {
    for (const { label, value } of doc.meta) lines.push(`- **${label}:** ${value}`);
    lines.push("");
  }
  for (const section of doc.sections) {
    lines.push(`## ${section.heading}`, "");
    if (section.body.trim()) lines.push(section.body.trim(), "");
    if (section.items?.length) {
      for (const item of section.items) lines.push(`- ${item}`);
      lines.push("");
    }
    if (section.note) lines.push(`_${section.note}_`, "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Escape the five characters that make HTML text into HTML markup. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A minimal standalone document, for `window.open` printing or a `.html` download.
 *
 * Everything from the data is escaped; the only markup is the markup written here. A verdict
 * that contains `<script>` prints as those characters, which is the entire point.
 */
export function docToHtml(doc: PrintableDoc): string {
  const meta = doc.meta
    .map((m) => `<li><strong>${escapeHtml(m.label)}:</strong> ${escapeHtml(m.value)}</li>`)
    .join("");
  const sections = doc.sections
    .map((section) => {
      const body = section.body.trim()
        ? section.body
            .trim()
            .split(/\n{2,}/)
            .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
            .join("")
        : "";
      const items = section.items?.length
        ? `<ul>${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
        : "";
      const note = section.note ? `<p class="note">${escapeHtml(section.note)}</p>` : "";
      return `<section><h2>${escapeHtml(section.heading)}</h2>${body}${items}${note}</section>`;
    })
    .join("");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(doc.title)}</title>`,
    "<style>",
    "body{font:14px/1.55 ui-sans-serif,system-ui,sans-serif;margin:32px auto;max-width:44rem;color:#111}",
    "h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px}",
    ".subtitle{color:#555;margin:0 0 12px}ul{padding-left:1.2em}li{margin:2px 0}",
    ".note{color:#555;font-size:12px}.meta{list-style:none;padding:0;font-size:12px;color:#333}",
    "</style></head><body>",
    `<h1>${escapeHtml(doc.title)}</h1>`,
    doc.subtitle ? `<p class="subtitle">${escapeHtml(doc.subtitle)}</p>` : "",
    meta ? `<ul class="meta">${meta}</ul>` : "",
    sections,
    "</body></html>",
  ].join("");
}

/** The browser's print dialog, with the document's title as the suggested PDF name. */
export function printDocument(doc: PrintableDoc): void {
  if (typeof window === "undefined") return;
  const previous = document.title;
  document.title = printFileName(doc);
  const restore = () => {
    document.title = previous;
    window.removeEventListener("afterprint", restore);
  };
  window.addEventListener("afterprint", restore);
  window.print();
}

// ── The three documents the app can print ────────────────────────────────────

export interface DeliberationInput {
  topic: string;
  /** Members seated for this run: a label and the model each used. */
  members: { label: string; model: string }[];
  ledger: { line: number; at: string; author: string; kind: string; text: string }[];
  outcome: {
    settled: boolean;
    reason: string;
    contributions: number;
    totalTokens: number;
    markdown: string;
  } | null;
  /** Why the run ended, in a reader's words. */
  reasonText?: string;
  generatedAt?: string;
}

/** A council discussion: the question, who sat, what each said, and the verdict. */
export function deliberationDoc(input: DeliberationInput): PrintableDoc {
  const contributions = input.ledger.filter((entry) => entry.kind === "contribution");
  const digests = input.ledger.filter((entry) => entry.kind !== "contribution");
  return {
    title: "Council deliberation",
    subtitle: input.topic || "(no topic recorded)",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    meta: [
      { label: "Status", value: input.outcome?.settled ? "settled" : "unsettled" },
      {
        label: "Ended because",
        value: input.reasonText ?? input.outcome?.reason ?? "still running",
      },
      {
        label: "Contributions",
        value: String(input.outcome?.contributions ?? contributions.length),
      },
      { label: "Tokens", value: String(input.outcome?.totalTokens ?? 0) },
      { label: "Council", value: input.members.map((m) => m.label).join(", ") || "none seated" },
    ],
    sections: [
      {
        heading: "Verdict",
        body: input.outcome?.markdown?.trim() || "No verdict was produced for this discussion.",
      },
      {
        heading: "Contributions",
        body: "",
        items: contributions.map((entry) => `${entry.author}: ${entry.text}`),
        ...(contributions.length ? {} : { note: "No member contributed before the run stopped." }),
      },
      ...(digests.length
        ? [
            {
              heading: "Supervisor digests",
              body: "",
              items: digests.map((entry) => `${entry.author || "supervisor"}: ${entry.text}`),
            },
          ]
        : []),
    ],
  };
}

export interface WorkflowRunInput {
  workflowName: string;
  status: string;
  result: string;
  trace: string;
  /** The steps as the canvas had them when Run was pressed. */
  steps: { name: string; kind: string }[];
  generatedAt?: string;
}

/** A workflow run: what it was, what it produced, and the step trace behind it. */
export function workflowRunDoc(input: WorkflowRunInput): PrintableDoc {
  return {
    title: `Workflow run: ${input.workflowName}`,
    subtitle: `${input.steps.length} steps · ${input.status}`,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    meta: [
      { label: "Status", value: input.status },
      {
        label: "Steps",
        value: input.steps.map((step) => `${step.name} (${step.kind})`).join(" → "),
      },
    ],
    sections: [
      { heading: "Result", body: input.result.trim() || "(the run produced no output)" },
      { heading: "Step trace", body: input.trace.trim() || "(no steps executed)" },
    ],
  };
}

export interface CompanyReportInput {
  company: { name: string; mission: string; description?: string };
  agents: {
    name: string;
    title: string;
    role: string;
    status?: string;
    reportsTo?: string | null;
  }[];
  tasks?: { title: string; status: string; assignee?: string }[];
  budgets?: { label: string; used: string; limit: string }[];
  generatedAt?: string;
}

/** A company report: the mission, the reporting tree, the open work and the budget position. */
export function companyReportDoc(input: CompanyReportInput): PrintableDoc {
  const openTasks = (input.tasks ?? []).filter((task) => task.status !== "done");
  const byName = new Map(input.agents.map((agent) => [agent.name, agent]));
  return {
    title: `${input.company.name} — company report`,
    subtitle: input.company.mission || input.company.description || undefined,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    meta: [
      { label: "Agents", value: String(input.agents.length) },
      { label: "Open tasks", value: String(openTasks.length) },
      { label: "Total tasks", value: String((input.tasks ?? []).length) },
    ],
    sections: [
      {
        heading: "Reporting tree",
        body: "",
        items: input.agents.map((agent) => {
          const manager = agent.reportsTo ? byName.get(agent.reportsTo) : undefined;
          return `${agent.name} — ${agent.title} (${agent.role})${
            manager ? `, reports to ${manager.name}` : ", top of the tree"
          }${agent.status ? ` · ${agent.status}` : ""}`;
        }),
        ...(input.agents.length ? {} : { note: "This company has no agents yet." }),
      },
      {
        heading: "Open work",
        body: "",
        items: openTasks.map((task) =>
          task.assignee
            ? `${task.title} — ${task.assignee} (${task.status})`
            : `${task.title} (${task.status})`,
        ),
        ...(openTasks.length ? {} : { note: "No open tasks." }),
      },
      ...(input.budgets?.length
        ? [
            {
              heading: "Budget",
              body: "",
              items: input.budgets.map((b) => `${b.label}: ${b.used} of ${b.limit}`),
            },
          ]
        : []),
    ],
  };
}
