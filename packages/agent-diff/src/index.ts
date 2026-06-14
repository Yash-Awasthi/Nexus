// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/agent-diff — Agent diff / str-replace execution layer.
 *
 * Provides the execution primitives that code agents use to modify files:
 *   strReplace()     — find-and-replace a unique string, throw if ambiguous/missing
 *   applyPatch()     — apply a unified diff patch (--- / +++ format)
 *   generateDiff()   — produce a unified diff from two strings
 *   applyFileBlock() — parse and apply <<<<<<< / >>>>>>> file blocks
 *   validatePatch()  — check a patch is applicable before mutating
 *
 * Zero external dependencies — pure TypeScript.
 */

// ── Error ─────────────────────────────────────────────────────────────────────

export class DiffError extends Error {
  readonly code: "NOT_FOUND" | "AMBIGUOUS" | "PATCH_FAILED" | "BLOCK_PARSE_ERROR";
  constructor(code: DiffError["code"], message: string) {
    super(message);
    this.name = "DiffError";
    this.code = code;
  }
}

// ── strReplace ────────────────────────────────────────────────────────────────

export interface StrReplaceOptions {
  /** If true, throw DiffError when oldStr appears more than once. Default true. */
  requireUnique?: boolean;
}

/**
 * Replace the first (and by default only) occurrence of `oldStr` with `newStr`.
 * Throws DiffError if oldStr is not found or appears multiple times (when requireUnique).
 */
export function strReplace(content: string, oldStr: string, newStr: string, opts?: StrReplaceOptions): string {
  const { requireUnique = true } = opts ?? {};
  const idx = content.indexOf(oldStr);
  if (idx === -1) throw new DiffError("NOT_FOUND", `str_replace: old string not found:\n${oldStr}`);
  if (requireUnique) {
    const second = content.indexOf(oldStr, idx + 1);
    if (second !== -1) throw new DiffError("AMBIGUOUS", `str_replace: old string appears multiple times — use more context`);
  }
  return content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
}

// ── generateDiff ──────────────────────────────────────────────────────────────

/**
 * Generate a minimal unified diff string between `original` and `modified`.
 * Output format: --- a/<path>\n+++ b/<path>\n@@ ... @@ ... hunks
 */
export function generateDiff(original: string, modified: string, path = "file"): string {
  const origLines = original.split("\n");
  const modLines = modified.split("\n");

  const hunks: string[] = [];
  let i = 0, j = 0;

  while (i < origLines.length || j < modLines.length) {
    if (i < origLines.length && j < modLines.length && origLines[i] === modLines[j]) {
      i++; j++;
      continue;
    }
    // Collect a hunk
    const hunkStart = i;
    const hunkStartNew = j;
    const removed: { line: number; text: string }[] = [];
    const added: { line: number; text: string }[] = [];

    // Scan forward to find differing region (simple LCS-free approach: line-by-line)
    while (i < origLines.length || j < modLines.length) {
      const origLine = origLines[i];
      const modLine = modLines[j];
      if (origLine === modLine && origLine !== undefined) break;
      if (i < origLines.length) removed.push({ line: i, text: origLines[i]! });
      if (j < modLines.length) added.push({ line: j, text: modLines[j]! });
      i++; j++;
    }

    if (removed.length === 0 && added.length === 0) break;

    const header = `@@ -${hunkStart + 1},${removed.length} +${hunkStartNew + 1},${added.length} @@`;
    const lines: string[] = [header];
    for (const r of removed) lines.push(`-${r.text}`);
    for (const a of added) lines.push(`+${a.text}`);
    hunks.push(lines.join("\n"));
  }

  if (hunks.length === 0) return "";
  return `--- a/${path}\n+++ b/${path}\n${hunks.join("\n")}`;
}

// ── applyPatch ────────────────────────────────────────────────────────────────

export interface PatchResult {
  content: string;
  hunksApplied: number;
}

/**
 * Apply a unified diff patch to `original`.
 * Supports standard @@ -L,N +L,N @@ hunks.
 */
export function applyPatch(original: string, patch: string): PatchResult {
  if (!patch.trim()) return { content: original, hunksApplied: 0 };

  const lines = original.split("\n");
  const patchLines = patch.split("\n");

  let hunksApplied = 0;
  let offset = 0; // line number offset from previously applied hunks
  let i = 0;

  while (i < patchLines.length) {
    const line = patchLines[i]!;
    const hunkHeader = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!hunkHeader) { i++; continue; }

    const origStart = parseInt(hunkHeader[1]!) - 1 + offset;
    i++;

    const removals: string[] = [];
    const insertions: string[] = [];

    while (i < patchLines.length && !patchLines[i]!.startsWith("@@") && !patchLines[i]!.startsWith("---") && !patchLines[i]!.startsWith("+++")) {
      const pl = patchLines[i]!;
      if (pl.startsWith("-")) removals.push(pl.slice(1));
      else if (pl.startsWith("+")) insertions.push(pl.slice(1));
      i++;
    }

    // Validate removal lines match original
    for (let r = 0; r < removals.length; r++) {
      const expected = lines[origStart + r];
      if (expected !== removals[r]) {
        throw new DiffError("PATCH_FAILED", `Hunk line mismatch at line ${origStart + r + 1}: expected "${removals[r]}", got "${expected}"`);
      }
    }

    lines.splice(origStart, removals.length, ...insertions);
    offset += insertions.length - removals.length;
    hunksApplied++;
  }

  return { content: lines.join("\n"), hunksApplied };
}

// ── validatePatch ─────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Check whether a patch is applicable to `original` without modifying it. */
export function validatePatch(original: string, patch: string): ValidationResult {
  try {
    applyPatch(original, patch);
    return { valid: true, errors: [] };
  } catch (err) {
    return { valid: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

// ── File block parser ─────────────────────────────────────────────────────────

export interface FileBlock {
  path: string;
  content: string;
}

const BLOCK_RE = /<<<<<<< ([^\n]+)\n([\s\S]*?)>>>>>>>/g;

/**
 * Parse agent-style file blocks:
 * ```
 * <<<<<<< path/to/file.ts
 * ...new content...
 * >>>>>>>
 * ```
 */
export function parseFileBlocks(text: string): FileBlock[] {
  const blocks: FileBlock[] = [];
  let match: RegExpExecArray | null;
  BLOCK_RE.lastIndex = 0;
  while ((match = BLOCK_RE.exec(text)) !== null) {
    blocks.push({ path: match[1]!.trim(), content: match[2]! });
  }
  return blocks;
}
