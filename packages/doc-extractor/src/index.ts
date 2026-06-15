// SPDX-License-Identifier: Apache-2.0
/**
 * doc-extractor — Document templating and structured field extraction.
 *
 * Provides:
 *   • FieldSchema   — define expected fields with types and regex patterns
 *   • extractFields — extract structured data from raw text using regex rules
 *   • renderTemplate — fill a Mustache-style template with extracted fields
 *   • extractTable  — parse a markdown table into row objects
 *   • extractLinks  — pull all URLs from text
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type FieldType = "string" | "number" | "boolean" | "date" | "email" | "url";

/** Field schema interface definition. */
export interface FieldSchema {
  name: string;
  type: FieldType;
  /** Regex with one capturing group. First match is used. */
  pattern: RegExp;
  /** Transform the captured string before returning. */
  transform?: (raw: string) => unknown;
  required?: boolean;
}

/** Extraction result interface definition. */
export interface ExtractionResult {
  fields: Record<string, unknown>;
  missing: string[];
  durationMs: number;
}

/** Table row interface definition. */
export interface TableRow {
  [column: string]: string;
}

// ── Field extraction ───────────────────────────────────────────────────────────

/**
 * Extract structured fields from `text` using a list of `FieldSchema` definitions.
 */
export function extractFields(
  text: string,
  schema: FieldSchema[],
): ExtractionResult {
  const t0 = Date.now();
  const fields: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const field of schema) {
    const match = field.pattern.exec(text);
    if (!match || match[1] === undefined) {
      if (field.required) missing.push(field.name);
      continue;
    }
    const raw = match[1].trim();
    if (field.transform) {
      fields[field.name] = field.transform(raw);
    } else {
      fields[field.name] = coerce(raw, field.type);
    }
  }

  return { fields, missing, durationMs: Date.now() - t0 };
}

function coerce(raw: string, type: FieldType): unknown {
  switch (type) {
    case "number":  return Number(raw);
    case "boolean": return raw.toLowerCase() === "true" || raw === "1";
    case "date":    return new Date(raw).toISOString();
    case "email":
    case "url":
    case "string":
    default:        return raw;
  }
}

// ── Template rendering ─────────────────────────────────────────────────────────

/**
 * Minimal Mustache-style template renderer.
 * Replaces `{{key}}` and `{{ key }}` with values from `vars`.
 * Unknown keys are replaced with empty string.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const val = getNestedValue(vars, key);
    return val !== undefined ? String(val) : "";
  });
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// ── Markdown table extraction ──────────────────────────────────────────────────

/**
 * Parse a markdown pipe-table into an array of row objects.
 *
 * Input example:
 * ```
 * | Name  | Age |
 * |-------|-----|
 * | Alice | 30  |
 * ```
 */
export function extractTable(markdown: string): TableRow[] {
  const lines = markdown
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"));

  if (lines.length < 2) return [];

  const parseRow = (line: string): string[] =>
    line
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());

  const headers = parseRow(lines[0]!);
  const rows: TableRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    // Skip separator rows like |---|---|
    if (/^\|[-| :]+\|$/.test(line)) continue;
    const cells = parseRow(line);
    const row: TableRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = cells[j] ?? "";
    }
    rows.push(row);
  }

  return rows;
}

// ── Link extraction ────────────────────────────────────────────────────────────

/** Extract all HTTP/HTTPS URLs from text. */
export function extractLinks(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s"'<>)\]]+/g;
  return [...new Set(text.match(urlRegex) ?? [])];
}

// ── Email extraction ───────────────────────────────────────────────────────────

/** Extract all email addresses from text. */
export function extractEmails(text: string): string[] {
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  return [...new Set(text.match(emailRegex) ?? [])];
}

// ── Key-value block extraction ─────────────────────────────────────────────────

/**
 * Extract simple `Key: Value` pairs from text blocks.
 * e.g. "Name: Alice\nAge: 30"
 */
export function extractKeyValues(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lineRegex = /^([A-Za-z][\w\s]*?)\s*:\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(text)) !== null) {
    const key = match[1]!.trim();
    const value = match[2]!.trim();
    result[key] = value;
  }
  return result;
}
