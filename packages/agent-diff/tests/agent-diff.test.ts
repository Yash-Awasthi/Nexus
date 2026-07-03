// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  strReplace,
  generateDiff,
  applyPatch,
  validatePatch,
  parseFileBlocks,
  DiffError,
} from "../src/index.js";

// ── strReplace ────────────────────────────────────────────────────────────────

describe("strReplace", () => {
  it("replaces unique occurrence", () => {
    const r = strReplace("hello world", "world", "Nexus");
    expect(r).toBe("hello Nexus");
  });

  it("throws NOT_FOUND when oldStr absent", () => {
    expect(() => strReplace("hello", "missing", "x")).toThrow(DiffError);
    try {
      strReplace("hello", "missing", "x");
    } catch (e) {
      expect((e as DiffError).code).toBe("NOT_FOUND");
    }
  });

  it("throws AMBIGUOUS when oldStr appears twice", () => {
    expect(() => strReplace("aa", "a", "b")).toThrow(DiffError);
    try {
      strReplace("aa", "a", "b");
    } catch (e) {
      expect((e as DiffError).code).toBe("AMBIGUOUS");
    }
  });

  it("allows non-unique when requireUnique=false", () => {
    const r = strReplace("aXa", "a", "b", { requireUnique: false });
    expect(r).toBe("bXa");
  });

  it("replaces multiline content", () => {
    const src = "line1\nold line\nline3";
    const r = strReplace(src, "old line", "new line");
    expect(r).toBe("line1\nnew line\nline3");
  });

  it("can delete by replacing with empty string", () => {
    expect(strReplace("hello world", " world", "")).toBe("hello");
  });
});

// ── generateDiff ──────────────────────────────────────────────────────────────

describe("generateDiff", () => {
  it("returns empty string for identical content", () => {
    expect(generateDiff("abc", "abc")).toBe("");
  });

  it("produces unified diff header", () => {
    const d = generateDiff("a\nb\n", "a\nc\n", "test.ts");
    expect(d).toContain("--- a/test.ts");
    expect(d).toContain("+++ b/test.ts");
  });

  it("marks removed lines with -", () => {
    const d = generateDiff("removed\n", "added\n");
    expect(d).toContain("-removed");
    expect(d).toContain("+added");
  });
});

// ── applyPatch ────────────────────────────────────────────────────────────────

describe("applyPatch", () => {
  it("applies empty patch unchanged", () => {
    const r = applyPatch("hello\nworld", "");
    expect(r.content).toBe("hello\nworld");
    expect(r.hunksApplied).toBe(0);
  });

  it("applies a simple substitution patch", () => {
    const original = "line1\nold\nline3";
    const patch = `--- a/f\n+++ b/f\n@@ -2,1 +2,1 @@\n-old\n+new`;
    const r = applyPatch(original, patch);
    expect(r.content).toBe("line1\nnew\nline3");
    expect(r.hunksApplied).toBe(1);
  });

  it("roundtrip: generateDiff then applyPatch", () => {
    const orig = "function add(a, b) {\n  return a + b;\n}\n";
    const mod = "function add(a, b) {\n  return a + b + 0;\n}\n";
    const diff = generateDiff(orig, mod, "math.ts");
    const { content } = applyPatch(orig, diff);
    expect(content).toBe(mod);
  });

  it("throws PATCH_FAILED on line mismatch", () => {
    const original = "line1\nline2\nline3";
    const badPatch = `--- a/f\n+++ b/f\n@@ -2,1 +2,1 @@\n-wrong_content\n+new`;
    expect(() => applyPatch(original, badPatch)).toThrow(DiffError);
  });

  it("applies multiple hunks in sequence", () => {
    const orig = "a\nb\nc\nd\ne\n";
    const patch = `--- a/f\n+++ b/f\n@@ -2,1 +2,1 @@\n-b\n+B\n@@ -4,1 +4,1 @@\n-d\n+D`;
    const { content, hunksApplied } = applyPatch(orig, patch);
    expect(content).toContain("B");
    expect(content).toContain("D");
    expect(hunksApplied).toBe(2);
  });
});

// ── validatePatch ─────────────────────────────────────────────────────────────

describe("validatePatch", () => {
  it("returns valid:true for applicable patch", () => {
    const orig = "line1\nold\nline3";
    const patch = `--- a/f\n+++ b/f\n@@ -2,1 +2,1 @@\n-old\n+new`;
    expect(validatePatch(orig, patch).valid).toBe(true);
  });

  it("returns valid:false for non-applicable patch with errors", () => {
    const orig = "hello";
    const patch = `--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-wrong\n+new`;
    const r = validatePatch(orig, patch);
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

// ── parseFileBlocks ───────────────────────────────────────────────────────────

describe("parseFileBlocks", () => {
  it("parses a single file block", () => {
    const text = `<<<<<<< src/foo.ts\nexport const x = 1;\n>>>>>>>`;
    const blocks = parseFileBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.path).toBe("src/foo.ts");
    expect(blocks[0]!.content).toContain("export const x = 1;");
  });

  it("parses multiple file blocks", () => {
    const text = `<<<<<<< a.ts\nconst a = 1;\n>>>>>>>\n<<<<<<< b.ts\nconst b = 2;\n>>>>>>>`;
    const blocks = parseFileBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.path).toBe("a.ts");
    expect(blocks[1]!.path).toBe("b.ts");
  });

  it("returns empty array when no blocks", () => {
    expect(parseFileBlocks("no blocks here")).toEqual([]);
  });

  it("trims path whitespace", () => {
    const text = `<<<<<<< src/file.ts   \ncontent\n>>>>>>>`;
    expect(parseFileBlocks(text)[0]!.path).toBe("src/file.ts");
  });
});
