// SPDX-License-Identifier: Apache-2.0
/**
 * A template is a payload the API will accept, and that is the only thing worth testing about
 * one: a gallery that creates a company the server does not recognise is worse than no gallery.
 *
 * So these tests read the real contracts — the step kinds `apps/api` executes, and the company
 * ids in `apps/api/src/lib/org-portability.ts` — and assert the gallery's payloads fit them. The
 * company half is the interesting one: the UI holds no company definitions at all, it holds a
 * reference to the server's registry, and this file proves the reference is to something real.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  allTemplates,
  companyTemplateFrom,
  filterTemplates,
  presentationFor,
  templateById,
  templateRequest,
  TEMPLATES,
  WORKFLOW_TEMPLATES,
  type ServerTemplate,
} from "../app/lib/templates.ts";
import { readServerTemplates } from "../app/routes/templates.tsx";

const API = path.resolve(__dirname, "../../api/src");

/** The company ids the server ships, read from the registry rather than guessed. */
function serverCompanyIds(): { id: string; name: string; description: string }[] {
  const source = fs.readFileSync(path.join(API, "lib/org-portability.ts"), "utf8");
  const start = source.indexOf("export const TEMPLATES");
  const block = source.slice(start, source.indexOf("\n];", start));
  return [...block.matchAll(/id:\s*"([^"]+)",\s*\n\s*name:\s*"([^"]+)",\s*\n\s*description:\s*\n?\s*"([^"]*)"/g)].map(
    (m) => ({ id: m[1]!, name: m[2]!, description: m[3] ?? "" }),
  );
}

/** What `GET /org/templates` would answer for this checkout. */
const SERVER: ServerTemplate[] = serverCompanyIds().map((row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  agents: ["Someone (Some title)"],
}));

/** The step kinds `POST /api/workflows/:id/run` compiles and the workflow store accepts. */
const STEP_KINDS = new Set(["agent", "fn", "condition", "org_task"]);

describe("the server's company registry", () => {
  it("is readable by this test, so the parity checks below mean something", () => {
    expect(serverCompanyIds().length).toBeGreaterThanOrEqual(3);
  });

  it("has a gallery presentation for every template it ships", () => {
    // A server template with no presentation still lists, but with a generic version and note.
    // That is a real gap in the gallery, so it fails here rather than shipping quietly.
    for (const row of serverCompanyIds()) {
      expect(presentationFor(row.id), `${row.id} has no presentation in lib/templates.ts`).toBeDefined();
    }
  });
});

describe("every workflow template", () => {
  it("has a unique id, a semantic version and a non-empty description", () => {
    const ids = new Set<string>();
    for (const template of WORKFLOW_TEMPLATES) {
      expect(ids.has(template.id), `duplicate id ${template.id}`).toBe(false);
      ids.add(template.id);
      expect(template.version, template.id).toMatch(/^\d+\.\d+\.\d+$/);
      expect(template.summary.trim().length, template.id).toBeGreaterThan(20);
      expect(template.tags.length, template.id).toBeGreaterThan(0);
      // A template that needs no edits pretends to know the user's business.
      expect(template.notes.trim().length, template.id).toBeGreaterThan(40);
    }
    expect(WORKFLOW_TEMPLATES.length).toBeGreaterThanOrEqual(3);
  });

  it.each(WORKFLOW_TEMPLATES.map((t) => [t.name, t] as const))(
    "%s compiles to step kinds the API runs",
    (_name, template) => {
      expect(template.steps.length).toBeGreaterThan(0);
      const stepIds = new Set<string>();
      for (const step of template.steps) {
        expect(STEP_KINDS.has(step.kind), `${template.id}: ${step.kind}`).toBe(true);
        expect(step.id.trim().length).toBeGreaterThan(0);
        expect(stepIds.has(step.id), `${template.id}: duplicate step id ${step.id}`).toBe(false);
        stepIds.add(step.id);
        expect(step.name.trim().length).toBeGreaterThan(0);
        if (step.kind === "agent") expect(step.task.trim().length).toBeGreaterThan(20);
      }
    },
  );

  it.each(WORKFLOW_TEMPLATES.map((t) => [t.name, t] as const))(
    "%s has a schedule the server accepts",
    (_name, template) => {
      if (template.schedule === null) return;
      // The server parses the expression with a cron library; five fields is the shape it takes.
      expect(template.schedule.trim().split(/\s+/)).toHaveLength(5);
    },
  );

  it("posts one request, with the steps it showed the user", () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const request = templateRequest(template);
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/workflows");
      expect(request.body["steps"]).toEqual(template.steps);
      expect(Object.keys(request.body).sort()).toEqual(
        template.schedule ? ["name", "schedule", "steps"] : ["name", "steps"],
      );
    }
  });

  it("lets the caller rename the copy without touching the template", () => {
    const template = WORKFLOW_TEMPLATES[0]!;
    expect(templateRequest(template, "  My brief  ").body["name"]).toBe("My brief");
    expect(templateRequest(template).body["name"]).toBe(template.name);
    // A blank name falls back to the template's own, never to "".
    expect(templateRequest(template, "   ").body["name"]).toBe(template.name);
  });
});

describe("company templates", () => {
  const companies = allTemplates(SERVER).filter((t) => t.kind === "company");

  it("come from the server, one per registry row", () => {
    expect(companies.map((t) => t.id).sort()).toEqual(SERVER.map((row) => row.id).sort());
  });

  it("instantiate by id, sending only a name", () => {
    for (const template of companies) {
      const request = templateRequest(template);
      expect(request.method).toBe("POST");
      // The server owns the bundle: agents, instructions and routines are not sent from here.
      expect(request.url).toBe(`/api/org/templates/${template.id}`);
      expect(Object.keys(request.body)).toEqual(["name"]);
      expect(templateRequest(template, "My team").body["name"]).toBe("My team");
    }
  });

  it("keep the server's own name and description, so the two cannot drift", () => {
    for (const row of SERVER) {
      const template = companyTemplateFrom(row);
      expect(template.name).toBe(row.name);
      expect(template.summary).toBe(row.description);
      expect(template.kind).toBe("company");
      // Mission lives on the server's bundle; the gallery does not restate it.
      expect(template.mission).toBe("");
    }
  });

  it("present agents as the server spelled them", () => {
    for (const template of companies) expect(template.agents.length).toBeGreaterThan(0);
  });
});

describe("the gallery list", () => {
  it("works before the server answers, with workflows only", () => {
    expect(TEMPLATES.every((t) => t.kind === "workflow")).toBe(true);
  });

  it("adds the company templates after, and finds either kind by id", () => {
    const all = allTemplates(SERVER);
    expect(all.length).toBe(WORKFLOW_TEMPLATES.length + SERVER.length);
    expect(templateById("workflow.research-brief", SERVER)?.kind).toBe("workflow");
    expect(templateById(SERVER[0]!.id, SERVER)?.kind).toBe("company");
    expect(templateById("workflow.does-not-exist", SERVER)).toBeUndefined();
  });

  it("searches by id, name, summary and tag, and filters by kind", () => {
    const all = allTemplates(SERVER);
    expect(filterTemplates(all, "postmortem").map((t) => t.id)).toContain("workflow.incident-postmortem");
    expect(filterTemplates(all, "research-brief").length).toBeGreaterThan(0);
    expect(filterTemplates(all, "", "company").every((t) => t.kind === "company")).toBe(true);
    expect(filterTemplates(all, "  ").length).toBe(all.length);
    expect(filterTemplates(all, "nothing matches this")).toEqual([]);
  });
});

describe("reading the server's answer", () => {
  it("keeps well-formed rows and drops the rest instead of rendering undefined", () => {
    const parsed = readServerTemplates({
      templates: [
        { id: "a", name: "A", description: "d", agents: ["X (Y)"] },
        { id: "b", name: "B" },
        { id: 42, name: "C" },
        null,
        { name: "No id" },
        { id: "d", name: "D", agents: [1, "Z (W)"] },
      ],
    });
    expect(parsed.map((row) => row.id)).toEqual(["a", "b", "d"]);
    expect(parsed[1]!.agents).toEqual([]);
    expect(parsed[2]!.agents).toEqual(["Z (W)"]);
  });

  it("reads a body with no templates as none, not as a crash", () => {
    expect(readServerTemplates({})).toEqual([]);
    expect(readServerTemplates(null)).toEqual([]);
    expect(readServerTemplates({ templates: "nope" })).toEqual([]);
  });
});
