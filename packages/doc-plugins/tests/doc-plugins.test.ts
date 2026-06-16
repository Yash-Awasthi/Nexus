// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  PluginRunner,
  DateExtractionPlugin,
  WordCountPlugin,
  EntityTagPlugin,
  type PluginDoc,
  type DocPlugin,
  type AnnotatedDoc,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDoc(content: string, overrides: Partial<PluginDoc> = {}): PluginDoc {
  return { content, metadata: {}, ...overrides };
}

// ── PluginRunner ──────────────────────────────────────────────────────────────

describe("PluginRunner", () => {
  it("runs with no plugins and returns empty annotations", async () => {
    const runner = new PluginRunner([]);
    const result = await runner.run(makeDoc("hello world"));
    expect(result.annotations).toEqual({});
    expect(result.pluginErrors).toEqual({});
  });

  it("chains multiple plugins sequentially", async () => {
    const runner = new PluginRunner([new WordCountPlugin(), new DateExtractionPlugin()]);
    const result = await runner.run(makeDoc("Meeting on 2026-06-14. One two three."));
    expect(result.annotations.wordCount).toBeGreaterThan(0);
    expect(result.annotations.dates).toBeDefined();
  });

  it("merges annotations from all plugins", async () => {
    const runner = new PluginRunner([new WordCountPlugin(), new DateExtractionPlugin()]);
    const result = await runner.run(makeDoc("Hello 2026-01-01"));
    expect("wordCount" in result.annotations).toBe(true);
    expect("dates" in result.annotations).toBe(true);
  });

  it("records plugin error without throwing", async () => {
    const broken: DocPlugin = {
      name: "broken",
      process: async () => {
        throw new Error("boom");
      },
    };
    const runner = new PluginRunner([broken, new WordCountPlugin()]);
    const result = await runner.run(makeDoc("Some text"));
    expect(result.pluginErrors["broken"]).toMatch(/boom/);
    expect(result.annotations.wordCount).toBeGreaterThan(0); // other plugin still ran
  });

  it("exposes doc on result", async () => {
    const runner = new PluginRunner([]);
    const doc = makeDoc("test content");
    const result = await runner.run(doc);
    expect(result.doc).toBe(doc);
  });

  it("add() adds a plugin after construction", async () => {
    const runner = new PluginRunner([]);
    runner.add(new WordCountPlugin());
    const result = await runner.run(makeDoc("one two three"));
    expect(result.annotations.wordCount).toBe(3);
  });

  it("runOne() runs only the named plugin", async () => {
    const runner = new PluginRunner([new WordCountPlugin(), new DateExtractionPlugin()]);
    const patch = await runner.runOne("word-count", makeDoc("one two three four"));
    expect(patch?.wordCount).toBe(4);
    expect(patch?.dates).toBeUndefined();
  });

  it("runOne() returns undefined for unknown plugin name", async () => {
    const runner = new PluginRunner([new WordCountPlugin()]);
    const patch = await runner.runOne("no-such-plugin", makeDoc("hello"));
    expect(patch).toBeUndefined();
  });
});

// ── DateExtractionPlugin ──────────────────────────────────────────────────────

describe("DateExtractionPlugin", () => {
  const plugin = new DateExtractionPlugin();
  const doc = (content: string) => makeDoc(content);

  it("has name 'date-extraction'", () => {
    expect(plugin.name).toBe("date-extraction");
  });

  it("extracts ISO 8601 date (YYYY-MM-DD)", async () => {
    const ann = await plugin.process(doc("Meeting on 2026-06-14 to review progress."), {});
    expect(ann.dates).toContain("2026-06-14");
  });

  it("extracts ISO date with slash separator", async () => {
    const ann = await plugin.process(doc("Deadline: 2026/03/15"), {});
    expect(ann.dates?.some((d) => d.includes("2026"))).toBe(true);
  });

  it("extracts US date (MM/DD/YYYY)", async () => {
    const ann = await plugin.process(doc("Event on 06/14/2026"), {});
    expect(ann.dates?.some((d) => d.includes("2026"))).toBe(true);
  });

  it("normalises US date to YYYY-MM-DD", async () => {
    const ann = await plugin.process(doc("Event on 03/15/2026"), {});
    expect(ann.dates).toContain("2026-03-15");
  });

  it("extracts long-form date (January 15, 2026)", async () => {
    const ann = await plugin.process(doc("Scheduled for January 15, 2026"), {});
    expect(ann.dates).toContain("2026-01-15");
  });

  it("extracts abbreviated month date (Jan 15, 2026)", async () => {
    const ann = await plugin.process(doc("Review on Jan 15, 2026"), {});
    expect(ann.dates?.some((d) => d.includes("2026"))).toBe(true);
  });

  it("deduplicates identical dates", async () => {
    const ann = await plugin.process(doc("2026-06-14 and again 2026-06-14"), {});
    const count = (ann.dates ?? []).filter((d) => d === "2026-06-14").length;
    expect(count).toBe(1);
  });

  it("returns empty dates array when no dates found", async () => {
    const ann = await plugin.process(doc("No dates in this text."), {});
    expect(ann.dates).toEqual([]);
  });

  it("extracts multiple distinct dates", async () => {
    const ann = await plugin.process(doc("Start: 2026-01-01, End: 2026-12-31"), {});
    expect(ann.dates?.length).toBeGreaterThanOrEqual(2);
  });

  it("annotates with detectedDates array", async () => {
    const ann = await plugin.process(doc("Review on 2026-06-14"), {});
    const meta = ann["date-extraction"] as { detectedDates: unknown[]; count: number };
    expect(meta.detectedDates).toBeDefined();
    expect(meta.count).toBeGreaterThan(0);
  });

  it("detectedDates have raw and iso fields", async () => {
    const ann = await plugin.process(doc("2026-06-14"), {});
    const meta = ann["date-extraction"] as {
      detectedDates: Array<{ raw: string; iso: string; offset: number }>;
    };
    expect(meta.detectedDates[0]?.raw).toBeTruthy();
    expect(meta.detectedDates[0]?.iso).toBeTruthy();
  });

  it("sorts detected dates by offset", async () => {
    const ann = await plugin.process(doc("First: 2026-01-01 and later: 2026-12-31"), {});
    const meta = ann["date-extraction"] as { detectedDates: Array<{ offset: number }> };
    const offsets = meta.detectedDates.map((d) => d.offset);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]!).toBeGreaterThanOrEqual(offsets[i - 1]!);
    }
  });
});

// ── WordCountPlugin ───────────────────────────────────────────────────────────

describe("WordCountPlugin", () => {
  const plugin = new WordCountPlugin();

  it("has name 'word-count'", () => {
    expect(plugin.name).toBe("word-count");
  });

  it("counts words correctly", async () => {
    const ann = await plugin.process(makeDoc("one two three four five"), {});
    expect(ann.wordCount).toBe(5);
  });

  it("handles leading/trailing whitespace", async () => {
    const ann = await plugin.process(makeDoc("  hello world  "), {});
    expect(ann.wordCount).toBe(2);
  });

  it("returns 0 for empty string", async () => {
    const ann = await plugin.process(makeDoc(""), {});
    expect(ann.wordCount).toBe(0);
  });

  it("returns readingTimeSec as a positive integer", async () => {
    const ann = await plugin.process(makeDoc("word ".repeat(200)), {});
    expect(ann.readingTimeSec).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(ann.readingTimeSec)).toBe(true);
  });

  it("200-word text has ~60 second reading time", async () => {
    const content = "word ".repeat(200).trim();
    const ann = await plugin.process(makeDoc(content), {});
    // 200 words / 200 wpm = 1 minute = 60 seconds
    expect(ann.readingTimeSec).toBe(60);
  });

  it("reading time scales with word count", async () => {
    const short = await plugin.process(makeDoc("word ".repeat(100)), {});
    const long = await plugin.process(makeDoc("word ".repeat(400)), {});
    expect(long.readingTimeSec!).toBeGreaterThan(short.readingTimeSec!);
  });
});

// ── EntityTagPlugin ───────────────────────────────────────────────────────────

describe("EntityTagPlugin", () => {
  const plugin = new EntityTagPlugin();

  it("has name 'entity-tag'", () => {
    expect(plugin.name).toBe("entity-tag");
  });

  it("detects URL entities", async () => {
    const ann = await plugin.process(makeDoc("Visit https://example.com for details"), {});
    const urls = (ann.entities ?? []).filter((e) => e.type === "URL");
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]?.text).toContain("example.com");
  });

  it("detects EMAIL entities", async () => {
    const ann = await plugin.process(makeDoc("Contact alice@example.com for help"), {});
    const emails = (ann.entities ?? []).filter((e) => e.type === "EMAIL");
    expect(emails.length).toBeGreaterThan(0);
  });

  it("detects MONEY entities", async () => {
    const ann = await plugin.process(makeDoc("The deal is worth $1,500.00"), {});
    const money = (ann.entities ?? []).filter((e) => e.type === "MONEY");
    expect(money.length).toBeGreaterThan(0);
  });

  it("detects ORG entities", async () => {
    const ann = await plugin.process(makeDoc("Meeting with Acme Corp tomorrow"), {});
    const orgs = (ann.entities ?? []).filter((e) => e.type === "ORG");
    expect(orgs.length).toBeGreaterThan(0);
  });

  it("deduplicates identical entities", async () => {
    const ann = await plugin.process(
      makeDoc("Email alice@example.com and also alice@example.com again"),
      {},
    );
    const emails = (ann.entities ?? []).filter(
      (e) => e.type === "EMAIL" && e.text === "alice@example.com",
    );
    expect(emails.length).toBe(1);
  });

  it("returns empty entities array when nothing detected", async () => {
    const ann = await plugin.process(makeDoc("simple text with no entities"), {});
    expect(ann.entities ?? []).toHaveLength(0);
  });

  it("each entity has text and type fields", async () => {
    const ann = await plugin.process(makeDoc("Send to bob@test.com via https://app.example"), {});
    for (const e of ann.entities ?? []) {
      expect(e.text).toBeTruthy();
      expect(e.type).toBeTruthy();
    }
  });
});
