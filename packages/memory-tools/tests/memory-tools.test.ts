// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  InMemoryToolsStore,
  exportMemory,
  importMemory,
  findDuplicates,
  deduplicateMemory,
  textFingerprint,
  cosineSimilarity,
  isUsableEmbedding,
  MemoryToolsError,
  type MemoryEntry,
  type MemoryExport,
  type MemoryToolsStore,
} from "../src/index.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

let _id = 0;
function entry(text: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: `id-${++_id}`,
    text,
    embedding: [0.1, 0.2, 0.3],
    metadata: {},
    createdAt: 1000 + _id,
    ...overrides,
  };
}

function zeroEntry(text: string): MemoryEntry {
  return entry(text, { embedding: [0, 0, 0] });
}

function store(...entries: MemoryEntry[]): InMemoryToolsStore {
  const s = new InMemoryToolsStore();
  for (const e of entries) {
    s.save(e); // fire-and-forget — sync Map internally
  }
  return s;
}

function makeExport(entries: MemoryEntry[]): MemoryExport {
  return { version: "1", exportedAt: new Date().toISOString(), count: entries.length, entries };
}

beforeEach(() => {
  _id = 0;
});

// ── InMemoryToolsStore ────────────────────────────────────────────────────────

describe("InMemoryToolsStore", () => {
  it("list returns empty array initially", async () => {
    expect(await new InMemoryToolsStore().list()).toEqual([]);
  });

  it("save then list returns the entry", async () => {
    const s = new InMemoryToolsStore();
    const e = entry("hello");
    await s.save(e);
    const all = await s.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.text).toBe("hello");
  });

  it("save overwrites by id", async () => {
    const s = new InMemoryToolsStore();
    const e = entry("original");
    await s.save(e);
    await s.save({ ...e, text: "updated" });
    const all = await s.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.text).toBe("updated");
  });

  it("delete removes the entry", async () => {
    const s = new InMemoryToolsStore();
    const e = entry("to-delete");
    await s.save(e);
    await s.delete(e.id);
    expect(await s.list()).toHaveLength(0);
  });

  it("delete is a no-op for missing id", async () => {
    const s = new InMemoryToolsStore();
    await expect(s.delete("nonexistent")).resolves.toBeUndefined();
  });

  it("size reflects current count", async () => {
    const s = new InMemoryToolsStore();
    await s.save(entry("a"));
    await s.save(entry("b"));
    expect(s.size).toBe(2);
  });
});

// ── textFingerprint ───────────────────────────────────────────────────────────

describe("textFingerprint", () => {
  it("lowercases", () => expect(textFingerprint("HELLO")).toBe("hello"));

  it("collapses whitespace", () => expect(textFingerprint("a  b   c")).toBe("a b c"));

  it("strips punctuation", () => expect(textFingerprint("Hello, World!")).toBe("hello world"));

  it("trims leading/trailing spaces", () => expect(textFingerprint("  hi  ")).toBe("hi"));

  it("returns empty string for punctuation-only input", () =>
    expect(textFingerprint("!!!")).toBe(""));

  it("two differently-punctuated strings produce same fingerprint", () => {
    expect(textFingerprint("Hello, World!")).toBe(textFingerprint("Hello World"));
  });
});

// ── cosineSimilarity ──────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 for zero vector", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched dimensions", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("clamps result to 1 for nearly-identical float vectors", () => {
    const a = [0.1, 0.2, 0.3];
    expect(cosineSimilarity(a, a)).toBeLessThanOrEqual(1);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1);
  });

  it("handles negative components", () => {
    const sim = cosineSimilarity([-1, 0], [1, 0]);
    expect(sim).toBeCloseTo(-1);
  });
});

// ── isUsableEmbedding ─────────────────────────────────────────────────────────

describe("isUsableEmbedding", () => {
  it("returns false for empty array", () => expect(isUsableEmbedding([])).toBe(false));

  it("returns false for all-zero vector", () => expect(isUsableEmbedding([0, 0, 0])).toBe(false));

  it("returns true for non-zero vector", () => expect(isUsableEmbedding([0, 0.1, 0])).toBe(true));
});

// ── MemoryToolsError ──────────────────────────────────────────────────────────

describe("MemoryToolsError", () => {
  it("has correct name and code", () => {
    const e = new MemoryToolsError("msg", "CODE");
    expect(e.name).toBe("MemoryToolsError");
    expect(e.code).toBe("CODE");
  });

  it("is instanceof Error", () => expect(new MemoryToolsError("x", "Y")).toBeInstanceOf(Error));

  it("stores optional context", () => {
    const e = new MemoryToolsError("m", "C", { k: 1 });
    expect(e.context).toEqual({ k: 1 });
  });
});

// ── exportMemory ──────────────────────────────────────────────────────────────

describe("exportMemory", () => {
  it("exports all non-expired entries by default", async () => {
    const now = Math.floor(Date.now() / 1000);
    const s = store(
      entry("live", { expiresAt: now + 9999 }),
      entry("expired", { expiresAt: now - 1 }),
      entry("no-expiry"),
    );
    const result = await exportMemory(s);
    expect(result.count).toBe(2);
    expect(result.entries.map((e) => e.text)).not.toContain("expired");
  });

  it("includes expired entries when includeExpired=true", async () => {
    const now = Math.floor(Date.now() / 1000);
    const s = store(entry("expired", { expiresAt: now - 100 }));
    const result = await exportMemory(s, { includeExpired: true });
    expect(result.count).toBe(1);
  });

  it("sets version to '1'", async () => {
    const result = await exportMemory(new InMemoryToolsStore());
    expect(result.version).toBe("1");
  });

  it("exportedAt is a valid ISO string", async () => {
    const result = await exportMemory(new InMemoryToolsStore());
    expect(() => new Date(result.exportedAt)).not.toThrow();
  });

  it("count matches entries.length", async () => {
    const s = store(entry("a"), entry("b"));
    const result = await exportMemory(s);
    expect(result.count).toBe(result.entries.length);
  });

  it("exports empty store", async () => {
    const result = await exportMemory(new InMemoryToolsStore());
    expect(result.entries).toEqual([]);
    expect(result.count).toBe(0);
  });
});

// ── importMemory ──────────────────────────────────────────────────────────────

describe("importMemory", () => {
  it("imports entries into an empty store", async () => {
    const s = new InMemoryToolsStore();
    const data = makeExport([entry("hello"), entry("world")]);
    const result = await importMemory(data, s);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(s.size).toBe(2);
  });

  it("skips conflicting ids by default (onConflict=skip)", async () => {
    const e = entry("original");
    const s = store(e);
    const data = makeExport([{ ...e, text: "replacement" }]);
    const result = await importMemory(data, s);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    const all = await s.list();
    expect(all[0]?.text).toBe("original");
  });

  it("overwrites conflicting ids when onConflict=overwrite", async () => {
    const e = entry("original");
    const s = store(e);
    const data = makeExport([{ ...e, text: "replacement" }]);
    await importMemory(data, s, { onConflict: "overwrite" });
    const all = await s.list();
    expect(all[0]?.text).toBe("replacement");
  });

  it("deduplicates intra-batch duplicates before saving", async () => {
    const a = entry("duplicate text");
    const b = { ...a, id: "id-99", createdAt: 500 }; // older
    const s = new InMemoryToolsStore();
    const data = makeExport([a, b]);
    const result = await importMemory(data, s, { strategy: "exact" });
    expect(s.size).toBe(1);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it("throws MemoryToolsError for unsupported version", async () => {
    const data = { version: "2", exportedAt: "", count: 0, entries: [] } as unknown as MemoryExport;
    await expect(importMemory(data, new InMemoryToolsStore())).rejects.toMatchObject({
      code: "UNSUPPORTED_VERSION",
    });
  });

  it("collects errors from failed saves", async () => {
    const failing: MemoryToolsStore = {
      list: async () => [],
      save: async () => {
        throw new Error("db down");
      },
      delete: async () => {},
    };
    const data = makeExport([entry("x")]);
    const result = await importMemory(data, failing);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain("db down");
  });

  it("ids in result match saved entry ids", async () => {
    const s = new InMemoryToolsStore();
    const e1 = entry("a");
    const e2 = entry("b");
    const data = makeExport([e1, e2]);
    const result = await importMemory(data, s);
    expect(result.ids).toContain(e1.id);
    expect(result.ids).toContain(e2.id);
  });
});

// ── findDuplicates — exact strategy ──────────────────────────────────────────

describe("findDuplicates — exact", () => {
  it("returns [] for fewer than 2 entries", () => {
    expect(findDuplicates([entry("a")], { strategy: "exact" })).toEqual([]);
  });

  it("returns [] when no duplicates", () => {
    const result = findDuplicates([entry("a"), entry("b")], { strategy: "exact" });
    expect(result).toHaveLength(0);
  });

  it("detects exact text duplicates", () => {
    const a = entry("same text", { createdAt: 100 });
    const b = { ...a, id: "id-99", createdAt: 200 };
    const groups = findDuplicates([a, b], { strategy: "exact" });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.canonical.id).toBe(a.id); // older
    expect(groups[0]?.duplicates[0]?.id).toBe(b.id);
  });

  it("is case-insensitive", () => {
    const a = entry("Hello", { createdAt: 100 });
    const b = { ...a, id: "id-99", text: "hello", createdAt: 200 };
    const groups = findDuplicates([a, b], { strategy: "exact" });
    expect(groups).toHaveLength(1);
  });

  it("groups three duplicates correctly", () => {
    const a = entry("dup", { createdAt: 100 });
    const b = { ...a, id: "id-98", createdAt: 200 };
    const c = { ...a, id: "id-97", createdAt: 300 };
    const groups = findDuplicates([a, b, c], { strategy: "exact" });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.canonical.id).toBe(a.id);
    expect(groups[0]?.duplicates).toHaveLength(2);
  });
});

// ── findDuplicates — fingerprint strategy ─────────────────────────────────────

describe("findDuplicates — fingerprint", () => {
  it("detects rephrased duplicates", () => {
    const a = entry("Hello, World!", { createdAt: 100 });
    const b = { ...a, id: "id-99", text: "hello world", createdAt: 200 };
    const groups = findDuplicates([a, b], { strategy: "fingerprint" });
    expect(groups).toHaveLength(1);
  });

  it("does not group distinct texts", () => {
    const groups = findDuplicates([entry("foo"), entry("bar")], { strategy: "fingerprint" });
    expect(groups).toHaveLength(0);
  });

  it("strategy field is 'fingerprint'", () => {
    const a = entry("same", { createdAt: 100 });
    const b = { ...a, id: "id-99", createdAt: 200 };
    expect(findDuplicates([a, b], { strategy: "fingerprint" })[0]?.strategy).toBe("fingerprint");
  });
});

// ── findDuplicates — embedding strategy ──────────────────────────────────────

describe("findDuplicates — embedding", () => {
  it("detects high-similarity embedding pairs", () => {
    const a = entry("a", { createdAt: 100, embedding: [1, 0, 0] });
    const b = entry("b", { createdAt: 200, embedding: [0.999, 0.001, 0] });
    const groups = findDuplicates([a, b], { strategy: "embedding", similarityThreshold: 0.99 });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.strategy).toBe("embedding");
  });

  it("does not group low-similarity pairs", () => {
    const a = entry("a", { embedding: [1, 0, 0] });
    const b = entry("b", { embedding: [0, 1, 0] });
    const groups = findDuplicates([a, b], { strategy: "embedding", similarityThreshold: 0.97 });
    expect(groups).toHaveLength(0);
  });

  it("falls back to fingerprint for zero embeddings", () => {
    const a = zeroEntry("same text");
    a.createdAt = 100;
    const b = { ...a, id: "id-99", createdAt: 200 };
    const groups = findDuplicates([a, b], { strategy: "embedding" });
    expect(groups).toHaveLength(1); // found via fingerprint fallback
  });

  it("canonical is the oldest entry", () => {
    const older = entry("x", { createdAt: 100, embedding: [1, 0] });
    const newer = entry("x", { createdAt: 999, embedding: [1, 0] });
    const groups = findDuplicates([newer, older], {
      strategy: "embedding",
      similarityThreshold: 0.99,
    });
    expect(groups[0]?.canonical.id).toBe(older.id);
  });
});

// ── deduplicateMemory ─────────────────────────────────────────────────────────

describe("deduplicateMemory", () => {
  it("removes duplicates from store", async () => {
    const a = entry("same", { createdAt: 100 });
    const b = { ...a, id: "id-99", createdAt: 200 };
    const s = store(a, b);
    const result = await deduplicateMemory(s, { strategy: "exact" });
    expect(result.removed).toBe(1);
    expect(result.kept).toBe(1);
    expect(s.size).toBe(1);
  });

  it("dryRun=true does not delete from store", async () => {
    const a = entry("same", { createdAt: 100 });
    const b = { ...a, id: "id-99", createdAt: 200 };
    const s = store(a, b);
    const result = await deduplicateMemory(s, { strategy: "exact", dryRun: true });
    expect(result.removed).toBe(0);
    expect(result.groups).toHaveLength(1);
    expect(s.size).toBe(2);
  });

  it("returns kept = total when no duplicates", async () => {
    const s = store(entry("a"), entry("b"), entry("c"));
    const result = await deduplicateMemory(s);
    expect(result.kept).toBe(3);
    expect(result.removed).toBe(0);
    expect(result.groups).toHaveLength(0);
  });

  it("groups contain correct canonical and duplicate fields", async () => {
    const a = entry("dup", { createdAt: 100 });
    const b = { ...a, id: "id-99", createdAt: 200 };
    const s = store(a, b);
    const result = await deduplicateMemory(s, { strategy: "exact", dryRun: true });
    expect(result.groups[0]?.canonical.id).toBe(a.id);
    expect(result.groups[0]?.duplicates[0]?.id).toBe(b.id);
  });

  it("works with empty store", async () => {
    const result = await deduplicateMemory(new InMemoryToolsStore());
    expect(result.kept).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.groups).toHaveLength(0);
  });

  it("uses fingerprint strategy by default", async () => {
    const a = entry("hello world", { createdAt: 100 });
    const b = { ...a, id: "id-99", text: "Hello, World!", createdAt: 200 };
    const s = store(a, b);
    const result = await deduplicateMemory(s); // default = fingerprint
    expect(result.removed).toBe(1);
  });
});
