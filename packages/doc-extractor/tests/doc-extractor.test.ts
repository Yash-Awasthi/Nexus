// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  extractFields,
  renderTemplate,
  extractTable,
  extractLinks,
  extractEmails,
  extractKeyValues,
  FieldSchema,
} from "../src/index.js";

// ── extractFields ─────────────────────────────────────────────────────────────

describe("extractFields", () => {
  const schema: FieldSchema[] = [
    { name: "name",  type: "string",  pattern: /Name:\s*(.+)/i },
    { name: "age",   type: "number",  pattern: /Age:\s*(\d+)/i },
    { name: "email", type: "email",   pattern: /Email:\s*(\S+)/i },
    { name: "active",type: "boolean", pattern: /Active:\s*(true|false)/i },
  ];

  const doc = "Name: Alice\nAge: 30\nEmail: alice@example.com\nActive: true";

  it("extracts string field", () => {
    const r = extractFields(doc, schema);
    expect(r.fields["name"]).toBe("Alice");
  });

  it("extracts number field", () => {
    const r = extractFields(doc, schema);
    expect(r.fields["age"]).toBe(30);
  });

  it("extracts email field", () => {
    const r = extractFields(doc, schema);
    expect(r.fields["email"]).toBe("alice@example.com");
  });

  it("extracts boolean field", () => {
    const r = extractFields(doc, schema);
    expect(r.fields["active"]).toBe(true);
  });

  it("reports missing required fields", () => {
    const reqSchema: FieldSchema[] = [
      { name: "missing", type: "string", pattern: /NOTHERE:\s*(.+)/, required: true },
    ];
    const r = extractFields(doc, reqSchema);
    expect(r.missing).toContain("missing");
  });

  it("optional missing fields not in missing array", () => {
    const optSchema: FieldSchema[] = [
      { name: "optional", type: "string", pattern: /NOTHERE:\s*(.+)/, required: false },
    ];
    const r = extractFields(doc, optSchema);
    expect(r.missing).toHaveLength(0);
  });

  it("applies custom transform", () => {
    const s: FieldSchema[] = [
      { name: "name", type: "string", pattern: /Name:\s*(.+)/i, transform: (v) => v.toUpperCase() },
    ];
    const r = extractFields(doc, s);
    expect(r.fields["name"]).toBe("ALICE");
  });

  it("returns durationMs", () => {
    const r = extractFields(doc, schema);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── renderTemplate ─────────────────────────────────────────────────────────────

describe("renderTemplate", () => {
  it("replaces simple placeholders", () => {
    const tmpl = "Hello, {{name}}! You are {{age}} years old.";
    expect(renderTemplate(tmpl, { name: "Alice", age: 30 })).toBe(
      "Hello, Alice! You are 30 years old.",
    );
  });

  it("handles spaces around key", () => {
    expect(renderTemplate("{{ name }}", { name: "Bob" })).toBe("Bob");
  });

  it("replaces unknown keys with empty string", () => {
    expect(renderTemplate("{{unknown}}", {})).toBe("");
  });

  it("supports nested keys with dot notation", () => {
    expect(renderTemplate("{{user.email}}", { user: { email: "a@b.com" } })).toBe("a@b.com");
  });

  it("leaves non-template content unchanged", () => {
    const tmpl = "No placeholders here.";
    expect(renderTemplate(tmpl, {})).toBe(tmpl);
  });

  it("multiple substitutions", () => {
    const r = renderTemplate("{{a}}-{{b}}-{{a}}", { a: "X", b: "Y" });
    expect(r).toBe("X-Y-X");
  });
});

// ── extractTable ──────────────────────────────────────────────────────────────

describe("extractTable", () => {
  const md = `
| Name  | Age | City    |
|-------|-----|---------|
| Alice | 30  | NYC     |
| Bob   | 25  | London  |
`.trim();

  it("parses headers and rows", () => {
    const rows = extractTable(md);
    expect(rows).toHaveLength(2);
    expect(rows[0]!["Name"]).toBe("Alice");
    expect(rows[1]!["City"]).toBe("London");
  });

  it("skips separator rows", () => {
    const rows = extractTable(md);
    for (const r of rows) {
      expect(Object.values(r).some((v) => /^-+$/.test(v))).toBe(false);
    }
  });

  it("returns empty for non-table text", () => {
    expect(extractTable("no table here")).toHaveLength(0);
  });

  it("handles single data row", () => {
    const single = "| A | B |\n|---|---|\n| 1 | 2 |";
    const rows = extractTable(single);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["A"]).toBe("1");
  });
});

// ── extractLinks ──────────────────────────────────────────────────────────────

describe("extractLinks", () => {
  it("extracts HTTP and HTTPS URLs", () => {
    const text = "Visit https://nexus.dev and http://example.com for more.";
    const links = extractLinks(text);
    expect(links).toContain("https://nexus.dev");
    expect(links).toContain("http://example.com");
  });

  it("deduplicates URLs", () => {
    const text = "https://nexus.dev https://nexus.dev";
    expect(extractLinks(text)).toHaveLength(1);
  });

  it("returns empty array when no links", () => {
    expect(extractLinks("no links here")).toHaveLength(0);
  });
});

// ── extractEmails ─────────────────────────────────────────────────────────────

describe("extractEmails", () => {
  it("extracts email addresses", () => {
    const text = "Contact alice@example.com or bob@nexus.dev";
    const emails = extractEmails(text);
    expect(emails).toContain("alice@example.com");
    expect(emails).toContain("bob@nexus.dev");
  });

  it("deduplicates emails", () => {
    const text = "alice@x.com alice@x.com";
    expect(extractEmails(text)).toHaveLength(1);
  });

  it("returns empty array when no emails", () => {
    expect(extractEmails("no emails")).toHaveLength(0);
  });
});

// ── extractKeyValues ──────────────────────────────────────────────────────────

describe("extractKeyValues", () => {
  it("extracts key-value pairs", () => {
    const text = "Name: Alice\nAge: 30\nCity: NYC";
    const kv = extractKeyValues(text);
    expect(kv["Name"]).toBe("Alice");
    expect(kv["Age"]).toBe("30");
    expect(kv["City"]).toBe("NYC");
  });

  it("handles multiword keys", () => {
    const text = "First Name: Alice";
    const kv = extractKeyValues(text);
    expect(kv["First Name"]).toBe("Alice");
  });

  it("returns empty object for no matches", () => {
    expect(extractKeyValues("no kv here!")).toEqual({});
  });
});
