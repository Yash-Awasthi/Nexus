// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  TemplateRegistry,
  TemplateError,
  renderTemplate,
  interpolate,
  ADR_TEMPLATE,
  RUNBOOK_TEMPLATE,
  INCIDENT_TEMPLATE,
  PRD_TEMPLATE,
  MEETING_TEMPLATE,
  WEEKLY_TEMPLATE,
  POSTMORTEM_TEMPLATE,
  ALL_BUILTIN_TEMPLATES,
  type DocTemplate,
} from "../src/index.js";

// ── interpolate ───────────────────────────────────────────────────────────────

describe("interpolate", () => {
  it("substitutes a single placeholder", () => {
    expect(interpolate("Hello {{name}}", { name: "Yash" })).toBe("Hello Yash");
  });

  it("substitutes multiple distinct placeholders", () => {
    expect(interpolate("{{a}} + {{b}}", { a: "1", b: "2" })).toBe("1 + 2");
  });

  it("substitutes same placeholder appearing multiple times", () => {
    expect(interpolate("{{x}}-{{x}}", { x: "ok" })).toBe("ok-ok");
  });

  it("leaves unmatched placeholders unchanged", () => {
    expect(interpolate("Hello {{name}}", {})).toBe("Hello {{name}}");
  });

  it("returns text unchanged when no placeholders", () => {
    expect(interpolate("no placeholders", { a: "1" })).toBe("no placeholders");
  });
});

// ── renderTemplate ────────────────────────────────────────────────────────────

describe("renderTemplate", () => {
  const simple: DocTemplate = {
    id: "test",
    type: "prd",
    name: "Test Doc",
    sections: [
      { heading: "Overview", placeholder: "Write overview here." },
      { heading: "Details", level: 3 },
    ],
  };

  it("includes h1 title", () => {
    const md = renderTemplate(simple, {});
    expect(md).toContain("# Test Doc");
  });

  it("uses custom title from variables", () => {
    const md = renderTemplate(simple, { title: "My Custom Doc" });
    expect(md).toContain("# My Custom Doc");
  });

  it("renders section as h2 by default", () => {
    const md = renderTemplate(simple, {});
    expect(md).toContain("## Overview");
  });

  it("renders section at level 3 when specified", () => {
    const md = renderTemplate(simple, {});
    expect(md).toContain("### Details");
  });

  it("includes section placeholder text", () => {
    const md = renderTemplate(simple, {});
    expect(md).toContain("Write overview here.");
  });

  it("interpolates variables in section headings", () => {
    const t: DocTemplate = {
      id: "t",
      type: "meeting",
      name: "Meeting {{date}}",
      sections: [{ heading: "Notes for {{date}}" }],
    };
    const md = renderTemplate(t, { date: "2026-06-14" });
    expect(md).toContain("# Meeting 2026-06-14");
    expect(md).toContain("## Notes for 2026-06-14");
  });

  it("interpolates variables in placeholder text", () => {
    const t: DocTemplate = {
      id: "t",
      type: "adr",
      name: "ADR",
      sections: [{ heading: "Section", placeholder: "Owner: {{owner}}" }],
    };
    const md = renderTemplate(t, { owner: "Yash" });
    expect(md).toContain("Owner: Yash");
  });

  it("renders frontmatter when present", () => {
    const t: DocTemplate = {
      id: "t",
      type: "adr",
      name: "ADR",
      frontmatter: [{ key: "status", default: "proposed" }, { key: "date" }],
      sections: [],
    };
    const md = renderTemplate(t, { date: "2026-06-14" });
    expect(md.startsWith("---")).toBe(true);
    expect(md).toContain("status: proposed");
    expect(md).toContain("date: 2026-06-14");
  });

  it("frontmatter uses variable over default", () => {
    const t: DocTemplate = {
      id: "t",
      type: "adr",
      name: "ADR",
      frontmatter: [{ key: "status", default: "proposed" }],
      sections: [],
    };
    const md = renderTemplate(t, { status: "accepted" });
    expect(md).toContain("status: accepted");
  });

  it("output ends with a single newline", () => {
    const md = renderTemplate(simple, {});
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });

  it("works with empty sections array", () => {
    const t: DocTemplate = { id: "t", type: "meeting", name: "Empty", sections: [] };
    const md = renderTemplate(t, {});
    expect(md).toContain("# Empty");
  });
});

// ── TemplateRegistry ──────────────────────────────────────────────────────────

describe("TemplateRegistry", () => {
  let registry: TemplateRegistry;

  beforeEach(() => { registry = new TemplateRegistry(); });

  it("register + get round-trips", () => {
    registry.register(ADR_TEMPLATE);
    expect(registry.get("builtin:adr")).toBe(ADR_TEMPLATE);
  });

  it("get returns undefined for unknown id", () => {
    expect(registry.get("ghost")).toBeUndefined();
  });

  it("unregister removes template", () => {
    registry.register(ADR_TEMPLATE);
    expect(registry.unregister("builtin:adr")).toBe(true);
    expect(registry.get("builtin:adr")).toBeUndefined();
  });

  it("unregister returns false for unknown id", () => {
    expect(registry.unregister("ghost")).toBe(false);
  });

  it("list returns all templates", () => {
    registry.register(ADR_TEMPLATE);
    registry.register(RUNBOOK_TEMPLATE);
    expect(registry.list()).toHaveLength(2);
  });

  it("list filters by type", () => {
    registry.register(ADR_TEMPLATE);
    registry.register(RUNBOOK_TEMPLATE);
    expect(registry.list("adr")).toHaveLength(1);
    expect(registry.list("adr")[0]!.id).toBe("builtin:adr");
  });

  it("render produces markdown output", () => {
    registry.register(ADR_TEMPLATE);
    const md = registry.render("builtin:adr", { status: "accepted", date: "2026-06-14" });
    expect(md).toContain("# Architecture Decision Record");
    expect(md).toContain("status: accepted");
  });

  it("render throws NOT_FOUND for unknown template", () => {
    expect(() => registry.render("ghost")).toThrow(TemplateError);
    try {
      registry.render("ghost");
    } catch (e) {
      expect((e as TemplateError).code).toBe("NOT_FOUND");
    }
  });

  it("register throws INVALID_ID for empty id", () => {
    const bad: DocTemplate = { id: "  ", type: "adr", name: "bad", sections: [] };
    expect(() => registry.register(bad)).toThrow(TemplateError);
    try {
      registry.register(bad);
    } catch (e) {
      expect((e as TemplateError).code).toBe("INVALID_ID");
    }
  });

  it("size returns correct count", () => {
    registry.register(ADR_TEMPLATE);
    registry.register(PRD_TEMPLATE);
    expect(registry.size()).toBe(2);
  });

  it("withBuiltins loads all 7 built-in templates", () => {
    const r = TemplateRegistry.withBuiltins();
    expect(r.size()).toBe(7);
  });

  it("withBuiltins can render each template type", () => {
    const r = TemplateRegistry.withBuiltins();
    for (const template of ALL_BUILTIN_TEMPLATES) {
      const md = r.render(template.id, {});
      expect(md.length).toBeGreaterThan(50);
    }
  });
});

// ── Built-in templates ────────────────────────────────────────────────────────

describe("Built-in templates", () => {
  it("ALL_BUILTIN_TEMPLATES has 7 entries", () => {
    expect(ALL_BUILTIN_TEMPLATES).toHaveLength(7);
  });

  it("all built-in templates have builtin: prefix", () => {
    ALL_BUILTIN_TEMPLATES.forEach((t) => expect(t.id.startsWith("builtin:")).toBe(true));
  });

  it("ADR has status in frontmatter", () => {
    const rendered = renderTemplate(ADR_TEMPLATE, { date: "2026-06-14" });
    expect(rendered).toContain("status: proposed");
  });

  it("Incident has severity in frontmatter", () => {
    const rendered = renderTemplate(INCIDENT_TEMPLATE, { incident_date: "2026-06-14" });
    expect(rendered).toContain("severity: P2");
  });

  it("Runbook has Steps section", () => {
    const rendered = renderTemplate(RUNBOOK_TEMPLATE, { service: "api" });
    expect(rendered).toContain("## Steps");
  });

  it("PRD has Success Metrics section", () => {
    const rendered = renderTemplate(PRD_TEMPLATE, { feature: "FTS", author: "Yash" });
    expect(rendered).toContain("## Success Metrics");
  });

  it("Meeting has Action Items section", () => {
    const rendered = renderTemplate(MEETING_TEMPLATE, { date: "2026-06-14" });
    expect(rendered).toContain("## Action Items");
  });

  it("Weekly has Blockers section", () => {
    const rendered = renderTemplate(WEEKLY_TEMPLATE, { week_of: "2026-06-09" });
    expect(rendered).toContain("## Blockers");
  });

  it("Postmortem has What Went Well section", () => {
    const rendered = renderTemplate(POSTMORTEM_TEMPLATE, { incident_date: "2026-06-14", author: "Yash" });
    expect(rendered).toContain("## What Went Well");
  });

  it("each template has at least 4 sections", () => {
    ALL_BUILTIN_TEMPLATES.forEach((t) => {
      expect(t.sections.length).toBeGreaterThanOrEqual(4);
    });
  });
});

// ── TemplateError ─────────────────────────────────────────────────────────────

describe("TemplateError", () => {
  it("has correct name, code, and message", () => {
    const e = new TemplateError("not found", "NOT_FOUND");
    expect(e.name).toBe("TemplateError");
    expect(e.code).toBe("NOT_FOUND");
    expect(e instanceof Error).toBe(true);
  });
});
