// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/doc-plugins — Document pipeline plugins.
 *
 * Provides a plugin interface for the doc-pipeline plus a built-in
 * date-extraction plugin.  Plugins annotate documents with structured
 * metadata at ingest time.
 *
 * Architecture
 * ────────────
 *   DocPlugin           — interface: { name, process(doc) → AnnotatedDoc }.
 *   AnnotatedDoc        — doc + plugin-specific metadata annotations.
 *   PluginRunner        — chains multiple plugins sequentially.
 *   DateExtractionPlugin— regex-based date parser; extracts ISO/US/EU/
 *                         relative date references into doc.annotations.dates[].
 *   EntityTagPlugin     — lightweight keyword entity tagger (no LLM).
 *   WordCountPlugin     — annotates with word count / reading time.
 *
 * Plugin contract
 * ───────────────
 *   Plugins MUST be pure (no I/O unless injectable) and MUST NOT throw.
 *   If a plugin fails, PluginRunner records the error and continues.
 *
 * Usage
 * ─────
 * ```ts
 * const runner = new PluginRunner([
 *   new DateExtractionPlugin(),
 *   new WordCountPlugin(),
 * ]);
 * const annotated = await runner.run({ content: "Meeting on 2026-03-15...", metadata: {} });
 * console.log(annotated.annotations.dates); // ["2026-03-15"]
 * ```
 */

// ── Core types ────────────────────────────────────────────────────────────────

export interface PluginDoc {
  id?: string;
  content: string;
  metadata: Record<string, unknown>;
  source?: string;
}

export interface DocAnnotation {
  /** ISO 8601 dates found in the document. */
  dates?: string[];
  /** Named entities (people, orgs, locations, etc.). */
  entities?: Array<{ text: string; type: string }>;
  /** Word count. */
  wordCount?: number;
  /** Estimated reading time in seconds. */
  readingTimeSec?: number;
  /** Arbitrary plugin-specific data keyed by plugin name. */
  [key: string]: unknown;
}

export interface AnnotatedDoc {
  doc: PluginDoc;
  annotations: DocAnnotation;
  pluginErrors: Record<string, string>;
}

// ── Plugin interface ──────────────────────────────────────────────────────────

export interface DocPlugin {
  readonly name: string;
  process(doc: PluginDoc, current: DocAnnotation): Promise<Partial<DocAnnotation>>;
}

// ── Plugin runner ─────────────────────────────────────────────────────────────

export class PluginRunner {
  private readonly plugins: DocPlugin[];

  constructor(plugins: DocPlugin[] = []) {
    this.plugins = plugins;
  }

  add(plugin: DocPlugin): void {
    this.plugins.push(plugin);
  }

  async run(doc: PluginDoc): Promise<AnnotatedDoc> {
    const annotations: DocAnnotation = {};
    const pluginErrors: Record<string, string> = {};

    for (const plugin of this.plugins) {
      try {
        const patch = await plugin.process(doc, { ...annotations });
        Object.assign(annotations, patch);
      } catch (err) {
        pluginErrors[plugin.name] = err instanceof Error ? err.message : String(err);
      }
    }

    return { doc, annotations, pluginErrors };
  }

  /** Run a single plugin by name, skipping others. */
  async runOne(pluginName: string, doc: PluginDoc): Promise<Partial<DocAnnotation> | undefined> {
    const plugin = this.plugins.find((p) => p.name === pluginName);
    if (!plugin) return undefined;
    return plugin.process(doc, {});
  }
}

// ── Date extraction plugin ────────────────────────────────────────────────────

/** A detected date with its original text and normalised ISO value. */
export interface DetectedDate {
  /** Raw text as it appeared in the document. */
  raw: string;
  /** ISO 8601 date string (YYYY-MM-DD) if parseable, else the raw string. */
  iso: string;
  /** Approximate character offset in the document. */
  offset: number;
}

const ISO_DATE_RE = /\b(\d{4}[-/]\d{2}[-/]\d{2})\b/g;
const US_DATE_RE = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/g;
const EU_DATE_RE = /\b(\d{1,2}[.\-]\d{1,2}[.\-]\d{2,4})\b/g;
const LONG_DATE_RE = /\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})\b/gi;
const SHORT_MONTH_RE = /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\s.]\s*\d{1,2},?\s+\d{4})\b/gi;

const MONTH_MAP: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
  jan: "01", feb: "02", mar: "03", apr: "04",
  jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function normaliseIso(raw: string): string {
  // Already ISO with separator
  const iso = raw.replace(/\//g, "-");
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  return raw;
}

function normaliseUsDate(raw: string): string {
  const parts = raw.split("/");
  if (parts.length !== 3) return raw;
  const [m, d, y] = parts;
  const year = (y ?? "").length === 2 ? `20${y}` : (y ?? "");
  return `${year}-${(m ?? "").padStart(2, "0")}-${(d ?? "").padStart(2, "0")}`;
}

function normaliseEuDate(raw: string): string {
  const sep = raw.includes(".") ? "." : "-";
  const parts = raw.split(sep);
  if (parts.length !== 3) return raw;
  const [d, m, y] = parts;
  const year = (y ?? "").length === 2 ? `20${y}` : (y ?? "");
  return `${year}-${(m ?? "").padStart(2, "0")}-${(d ?? "").padStart(2, "0")}`;
}

function normaliseLongDate(raw: string): string {
  const m = /(\w+)\s+(\d{1,2}),?\s+(\d{4})/.exec(raw);
  if (!m) return raw;
  const month = MONTH_MAP[m[1]?.toLowerCase() ?? ""];
  if (!month) return raw;
  return `${m[3]}-${month}-${(m[2] ?? "").padStart(2, "0")}`;
}

function extractDates(content: string): DetectedDate[] {
  const found: DetectedDate[] = [];
  const seen = new Set<string>();

  function add(raw: string, offset: number, normalise: (s: string) => string): void {
    if (seen.has(raw)) return;
    seen.add(raw);
    found.push({ raw, iso: normalise(raw), offset });
  }

  let m: RegExpExecArray | null;

  ISO_DATE_RE.lastIndex = 0;
  while ((m = ISO_DATE_RE.exec(content)) !== null) {
    add(m[1] ?? m[0], m.index, normaliseIso);
  }

  LONG_DATE_RE.lastIndex = 0;
  while ((m = LONG_DATE_RE.exec(content)) !== null) {
    add(m[1] ?? m[0], m.index, normaliseLongDate);
  }

  SHORT_MONTH_RE.lastIndex = 0;
  while ((m = SHORT_MONTH_RE.exec(content)) !== null) {
    add(m[1] ?? m[0], m.index, normaliseLongDate);
  }

  US_DATE_RE.lastIndex = 0;
  while ((m = US_DATE_RE.exec(content)) !== null) {
    add(m[1] ?? m[0], m.index, normaliseUsDate);
  }

  EU_DATE_RE.lastIndex = 0;
  while ((m = EU_DATE_RE.exec(content)) !== null) {
    add(m[1] ?? m[0], m.index, normaliseEuDate);
  }

  return found.sort((a, b) => a.offset - b.offset);
}

export class DateExtractionPlugin implements DocPlugin {
  readonly name = "date-extraction";

  async process(doc: PluginDoc): Promise<Partial<DocAnnotation>> {
    const dates = extractDates(doc.content);
    return {
      dates: dates.map((d) => d.iso),
      "date-extraction": {
        detectedDates: dates,
        count: dates.length,
      },
    };
  }
}

// ── Word count plugin ─────────────────────────────────────────────────────────

const WORDS_PER_MIN = 200; // average adult reading speed

export class WordCountPlugin implements DocPlugin {
  readonly name = "word-count";

  async process(doc: PluginDoc): Promise<Partial<DocAnnotation>> {
    const wordCount = doc.content.trim().split(/\s+/).filter(Boolean).length;
    const readingTimeSec = Math.ceil((wordCount / WORDS_PER_MIN) * 60);
    return { wordCount, readingTimeSec };
  }
}

// ── Entity tag plugin (keyword-based, no LLM) ─────────────────────────────────

const ENTITY_PATTERNS: Array<{ re: RegExp; type: string }> = [
  { re: /\b(?:Mr|Mrs|Ms|Dr|Prof)\.?\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b/g, type: "PERSON" },
  { re: /\b[A-Z][a-z]+\s+(?:Inc|Corp|LLC|Ltd|GmbH|SA|SAS|BV|AG)\.?\b/g, type: "ORG" },
  { re: /\b[A-Z][a-z]+,\s+[A-Z]{2}\b/g, type: "LOCATION" },
  { re: /\bhttps?:\/\/[^\s]+/g, type: "URL" },
  { re: /\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b/gi, type: "EMAIL" },
  { re: /\$[\d,]+(?:\.\d{2})?\b|\b[\d,]+(?:\.\d{2})?\s*(?:USD|EUR|GBP|JPY)\b/g, type: "MONEY" },
];

export class EntityTagPlugin implements DocPlugin {
  readonly name = "entity-tag";

  async process(doc: PluginDoc): Promise<Partial<DocAnnotation>> {
    const entities: Array<{ text: string; type: string }> = [];
    const seen = new Set<string>();

    for (const { re, type } of ENTITY_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(doc.content)) !== null) {
        const text = m[0];
        const key = `${type}:${text}`;
        if (!seen.has(key)) {
          seen.add(key);
          entities.push({ text, type });
        }
      }
    }

    return { entities };
  }
}
