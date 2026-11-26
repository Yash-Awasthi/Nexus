// SPDX-License-Identifier: Apache-2.0
/**
 * Print/PDF export builds its document from the same state the page renders, so what these
 * tests check is that the mapping is faithful and that nothing a model wrote can become markup.
 *
 * The escaping cases are not hypothetical: a verdict is arbitrary text from a model, and a
 * verdict containing `<script>` printed into an HTML file is a stored-XSS in whatever opens it.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  companyReportDoc,
  deliberationDoc,
  docToHtml,
  docToMarkdown,
  printFileName,
  workflowRunDoc,
} from "../app/lib/printable.ts";

const AT = "2026-03-04T10:00:00.000Z";

const DELIBERATION = {
  topic: "Should we ship on Friday?",
  members: [
    { label: "Ada", model: "openai/gpt-5" },
    { label: "Grace", model: "anthropic/claude-sonnet-4" },
  ],
  ledger: [
    { line: 1, at: AT, author: "Ada", kind: "contribution", text: "Not on a Friday." },
    { line: 2, at: AT, author: "Grace", kind: "contribution", text: "Ship Monday instead." },
    { line: 3, at: AT, author: "supervisor", kind: "digest", text: "Both agree on Monday." },
  ],
  outcome: {
    settled: true,
    reason: "settled",
    contributions: 2,
    totalTokens: 1234,
    markdown: "Ship **Monday**.",
  },
  reasonText: "the supervisor judged the discussion resolved",
  generatedAt: AT,
};

describe("a deliberation", () => {
  it("carries the question, the council, the contributions and the verdict", () => {
    const doc = deliberationDoc(DELIBERATION);
    expect(doc.title).toBe("Council deliberation");
    expect(doc.subtitle).toBe("Should we ship on Friday?");
    expect(doc.generatedAt).toBe(AT);
    expect(doc.meta.map((m) => m.label)).toEqual([
      "Status",
      "Ended because",
      "Contributions",
      "Tokens",
      "Council",
    ]);
    expect(doc.meta.find((m) => m.label === "Council")?.value).toBe("Ada, Grace");
    expect(doc.meta.find((m) => m.label === "Tokens")?.value).toBe("1234");
    expect(doc.sections[0]).toMatchObject({ heading: "Verdict", body: "Ship **Monday**." });
    expect(doc.sections[1]!.items).toEqual([
      "Ada: Not on a Friday.",
      "Grace: Ship Monday instead.",
    ]);
    // The supervisor's record is kept apart from member contributions.
    expect(doc.sections[2]).toMatchObject({ heading: "Supervisor digests" });
  });

  it("says why it stopped, and prints what exists when nothing settled", () => {
    const doc = deliberationDoc({
      topic: "",
      members: [],
      ledger: [],
      outcome: null,
      generatedAt: AT,
    });
    expect(doc.subtitle).toBe("(no topic recorded)");
    expect(doc.meta.find((m) => m.label === "Status")?.value).toBe("unsettled");
    expect(doc.meta.find((m) => m.label === "Ended because")?.value).toBe("still running");
    expect(doc.meta.find((m) => m.label === "Council")?.value).toBe("none seated");
    expect(doc.sections[0]!.body).toBe("No verdict was produced for this discussion.");
    expect(doc.sections[1]!.note).toMatch(/No member contributed/);
  });

  it("keeps a run that hit its cap readable, without inventing a verdict", () => {
    const doc = deliberationDoc({
      ...DELIBERATION,
      outcome: { ...DELIBERATION.outcome, settled: false, digest: "" },
      reasonText: "the contribution limit was reached",
    });
    expect(doc.meta.find((m) => m.label === "Status")?.value).toBe("unsettled");
    expect(doc.meta.find((m) => m.label === "Ended because")?.value).toBe(
      "the contribution limit was reached",
    );
  });
});

describe("a workflow run", () => {
  const doc = workflowRunDoc({
    workflowName: "Weekly digest",
    status: "success",
    result: "42 items, 3 decisions",
    trace: "[started] Gather\n[started] Decisions",
    steps: [
      { name: "Gather", kind: "agent" },
      { name: "Decisions", kind: "agent" },
    ],
    generatedAt: AT,
  });

  it("names the workflow and keeps the result and the trace apart", () => {
    expect(doc.title).toBe("Workflow run: Weekly digest");
    expect(doc.meta.find((m) => m.label === "Steps")?.value).toBe("Gather (agent) → Decisions (agent)");
    expect(doc.sections.map((s) => s.heading)).toEqual(["Result", "Step trace"]);
    expect(doc.sections[0]!.body).toBe("42 items, 3 decisions");
    expect(doc.sections[1]!.body).toContain("[started] Gather");
  });

  it("says so when there was no output, instead of printing an empty page", () => {
    const empty = workflowRunDoc({
      workflowName: "Empty",
      status: "error",
      result: "",
      trace: "",
      steps: [],
      generatedAt: AT,
    });
    expect(empty.sections[0]!.body).toBe("(the run produced no output)");
    expect(empty.sections[1]!.body).toBe("(no steps executed)");
  });
});

describe("a company report", () => {
  const doc = companyReportDoc({
    company: { name: "Northwind", mission: "Answer one question well." },
    agents: [
      { name: "Lead", title: "Engagement lead", role: "manager" },
      { name: "Tech", title: "Technical reviewer", role: "analyst", reportsTo: "Lead" },
      { name: "Gone", title: "Former analyst", role: "analyst", status: "terminated", reportsTo: "Lead" },
    ],
    tasks: [
      { title: "Draft the memo", status: "open", assignee: "Tech" },
      { title: "Ship it", status: "done", assignee: "Lead" },
    ],
    budgets: [{ label: "Monthly", used: "$12.40", limit: "$50.00" }],
    generatedAt: AT,
  });

  it("counts the tree, the open work and the budget", () => {
    expect(doc.title).toBe("Northwind — company report");
    expect(doc.subtitle).toBe("Answer one question well.");
    expect(doc.meta.find((m) => m.label === "Agents")?.value).toBe("3");
    expect(doc.meta.find((m) => m.label === "Open tasks")?.value).toBe("1");
    expect(doc.meta.find((m) => m.label === "Total tasks")?.value).toBe("2");
    const tree = doc.sections[0]!.items!;
    expect(tree[0]).toBe("Lead — Engagement lead (manager), top of the tree");
    expect(tree[1]).toBe("Tech — Technical reviewer (analyst), reports to Lead");
    expect(tree[2]).toContain("terminated");
  });

  it("lists only work that is not done, and says when there is none", () => {
    expect(doc.sections[1]!.items).toEqual(["Draft the memo — Tech (open)"]);
    const quiet = companyReportDoc({
      company: { name: "Empty Co", mission: "" },
      agents: [],
      generatedAt: AT,
    });
    expect(quiet.sections[0]!.note).toMatch(/no agents/i);
    expect(quiet.sections[1]!.note).toMatch(/No open tasks/);
    // No budgets supplied: no budget section at all, rather than an empty heading.
    expect(quiet.sections.map((s) => s.heading)).not.toContain("Budget");
  });
});

describe("the formats", () => {
  const doc = deliberationDoc(DELIBERATION);

  it("render Markdown with the structure an archive or a diff needs", () => {
    const md = docToMarkdown(doc);
    expect(md.startsWith("# Council deliberation\n")).toBe(true);
    expect(md).toContain("> Should we ship on Friday?");
    expect(md).toContain("- **Tokens:** 1234");
    expect(md).toContain("## Verdict");
    expect(md).toContain("- Ada: Not on a Friday.");
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });

  it("escape what a model wrote, so a verdict cannot become markup", () => {
    const hostile = deliberationDoc({
      ...DELIBERATION,
      outcome: {
        ...DELIBERATION.outcome,
        markdown: '<script>alert("x")</script> & "quoted"',
      },
      topic: "<img src=x onerror=alert(1)>",
      generatedAt: AT,
    });
    const html = docToHtml(hostile);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;quoted&quot;");
    expect(html).not.toContain("<img src=x");
    // The markup this module writes itself is still markup.
    expect(html).toContain("<h1>Council deliberation</h1>");
    expect(html).toContain("<h2>Verdict</h2>");
  });

  it("keep paragraphs apart instead of collapsing them into one block", () => {
    const html = docToHtml(
      workflowRunDoc({
        workflowName: "Two paragraphs",
        status: "success",
        result: "First para.\n\nSecond para.",
        trace: "",
        steps: [],
        generatedAt: AT,
      }),
    );
    expect(html).toContain("<p>First para.</p><p>Second para.</p>");
  });

  it("name the file after the document and the date, safely", () => {
    expect(printFileName(doc)).toBe("council-deliberation-2026-03-04");
    expect(printFileName({ ...doc, title: "Re: our / pricing — Q3?" })).toBe(
      "re-our-pricing-q3-2026-03-04",
    );
    // A title of only punctuation still produces a filename.
    expect(printFileName({ ...doc, title: "///" })).toBe("nexus-2026-03-04");
  });
});

describe("the pages", () => {
  it("offer the print control on all three documents", () => {
    const wired: [string, string][] = [
      ["apps/ui/app/routes/discussion.tsx", "deliberationDoc"],
      ["apps/ui/app/routes/workflows.tsx", "workflowRunDoc"],
      ["apps/ui/app/routes/org.tsx", "companyReportDoc"],
    ];
    for (const [file, fn] of wired) {
      const source = fs.readFileSync(path.resolve(__dirname, "../../..", file), "utf8");
      expect(source, `${file} builds no printable document`).toContain(fn);
      expect(source, `${file} has no print button`).toContain("<PrintButton");
    }
  });

  it("hide the app chrome when printing, and keep the app when not", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../app/app.css"), "utf8");
    expect(css).toContain("@media print");
    const block = css.slice(css.indexOf("@media print"));
    // Navigation, dialogs and anything marked print:hidden leave the page.
    for (const selector of ["nav", "aside", "[role=\"dialog\"]", ".print\\:hidden"]) {
      expect(block, selector).toContain(selector);
    }
    // A citation printed without its URL is not a citation.
    expect(block).toContain('a[href^="http"]::after');
    // And the rules do not leak into the screen layout.
    expect(css.slice(0, css.indexOf("@media print"))).not.toContain("[role=\"dialog\"] {\n    display: none");
  });
});
