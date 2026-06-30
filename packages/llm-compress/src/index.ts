// SPDX-License-Identifier: Apache-2.0
/**
 * llm-compress — token compression for LLM context windows.
 *
 * Tool/command output is noisy (ANSI codes, repeated log lines, padding) and
 * eats context tokens for zero signal. These filters strip the noise BEFORE the
 * text reaches the model.
 *
 * Two classes of filter:
 *   • LOSSLESS  — remove only non-semantic bytes (color codes, trailing space,
 *                 excess blank lines) or fold provably-identical repeats with an
 *                 explicit count. The meaning is preserved exactly. Safe to apply
 *                 by default.
 *   • LOSSY     — drop content (head/tail truncation). Signal-preserving but NOT
 *                 reversible. Opt-in only; never in the default pipeline.
 *
 * Each filter is a pure `(input: string) => string`, so they compose and test
 * trivially. `compress()` runs a pipeline and reports the token delta.
 */

import { encode as toonEncode } from "@toon-format/toon";

// ── Structured-payload encoding ─────────────────────────────────────────────────
// JSON is verbose: every key is requoted on every array element. TOON (Token-
// Oriented Object Notation) declares keys once per uniform array and drops the
// punctuation, cutting ~30-60% of tokens on tabular data — losslessly (decode
// round-trips). It IS a different wire format though, so the model has to read
// TOON instead of JSON. Opt-in, never the silent default.

export type StructuredFormat = "json" | "toon";

/**
 * Encode a structured value to a string for the model.
 *   • "json" — `JSON.stringify` (default, universally understood).
 *   • "toon" — compact TOON; big win on arrays of uniform objects, lossless.
 * Falls back to JSON if a value isn't TOON-encodable (e.g. cyclic) — encoding
 * tool output must never throw and lose the result.
 */
export function encodeStructured(value: unknown, format: StructuredFormat = "json"): string {
  if (format === "toon") {
    try {
      return toonEncode(value as never);
    } catch {
      // ponytail: fall back to JSON on any TOON encode error. Ceiling: we lose
      // the token win for that one payload; upgrade path is none needed.
    }
  }
  return JSON.stringify(value);
}

// ── Token estimation ────────────────────────────────────────────────────────────
// Same 4-chars/token heuristic used across @nexus/llm-drivers and prompt-cache,
// so savings numbers are comparable across packages.

/** Rough estimate: 1 token ≈ 4 chars. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Filter type ──────────────────────────────────────────────────────────────────

/** A pure text transform. Lossless filters preserve meaning; lossy ones may drop content. */
export interface CompressFilter {
  readonly name: string;
  readonly lossless: boolean;
  apply(input: string): string;
}

// ── Lossless filters ──────────────────────────────────────────────────────────────

// CSI / SGR ANSI escape sequences (colors, cursor moves). Pure terminal noise to an LLM.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;?]*[ -/]*[@-~]/g;

/** Strip ANSI escape codes (color/cursor sequences). Lossless. */
export const stripAnsi: CompressFilter = {
  name: "strip-ansi",
  lossless: true,
  apply: (input) => input.replace(ANSI_RE, ""),
};

/** Remove trailing whitespace on each line. Lossless. */
export const trimTrailing: CompressFilter = {
  name: "trim-trailing",
  lossless: true,
  apply: (input) => input.replace(/[ \t]+(\r?\n)/g, "$1").replace(/[ \t]+$/, ""),
};

/** Collapse 3+ consecutive blank lines down to a single blank line. Lossless. */
export const collapseBlankLines: CompressFilter = {
  name: "collapse-blank-lines",
  lossless: true,
  apply: (input) => input.replace(/(\r?\n)[ \t]*(\r?\n)[ \t]*(\r?\n)+/g, "$1$2"),
};

/**
 * Fold runs of identical consecutive lines into one line plus a count marker.
 * `foo\nfoo\nfoo` → `foo  ⟪×3⟫`. Lossless: the exact repeat count is preserved,
 * so the model can still reason about "how many". Common in build/test/log spam.
 */
export const dedupConsecutive: CompressFilter = {
  name: "dedup-consecutive",
  lossless: true,
  apply: (input) => {
    const lines = input.split("\n");
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      let count = 1;
      while (i + count < lines.length && lines[i + count] === line) count++;
      out.push(count > 1 ? `${line}  ⟪×${count}⟫` : line);
      i += count;
    }
    return out.join("\n");
  },
};

// ── Lossy filter (opt-in) ───────────────────────────────────────────────────────

/**
 * Keep the first `headLines` and last `tailLines`, eliding the middle with a
 * marker that records how many lines were dropped.
 *
 * ponytail: LOSSY by design — the middle is gone, not recoverable. The ceiling
 * is "you lose the middle of huge outputs"; the upgrade path is a semantic
 * summarizer (LLMLingua / a small model) if the middle ever matters. Never put
 * this in the default pipeline; callers opt in explicitly.
 */
export function smartTruncate(
  input: string,
  opts: { headLines?: number; tailLines?: number } = {},
): string {
  const headLines = opts.headLines ?? 40;
  const tailLines = opts.tailLines ?? 20;
  const lines = input.split("\n");
  if (lines.length <= headLines + tailLines + 1) return input;
  const dropped = lines.length - headLines - tailLines;
  return [
    ...lines.slice(0, headLines),
    `⟪… ${dropped} lines elided …⟫`,
    ...lines.slice(lines.length - tailLines),
  ].join("\n");
}

// ── Pipeline ──────────────────────────────────────────────────────────────────────

/** The default lossless pipeline, ordered so cheap byte-strips run before line folds. */
export const DEFAULT_FILTERS: readonly CompressFilter[] = [
  stripAnsi,
  trimTrailing,
  collapseBlankLines,
  dedupConsecutive,
];

/** Named presets. `lossless` is safe-by-default; extend with lossy steps via opts. */
export const PRESETS = {
  /** No-op. */
  off: [] as readonly CompressFilter[],
  /** Lossless tool-output cleanup. Recommended default. */
  lossless: DEFAULT_FILTERS,
} as const;

export type PresetName = keyof typeof PRESETS;

/** Result of a compression pass, with the token delta for telemetry. */
export interface CompressResult {
  text: string;
  applied: string[];
  originalChars: number;
  compressedChars: number;
  originalTokens: number;
  compressedTokens: number;
  /** Fraction of tokens removed, 0..1 (0 = nothing saved). */
  savedRatio: number;
}

/**
 * Run a filter pipeline over `input`. Defaults to the lossless preset.
 * Pass `filters` to override, e.g. `[...DEFAULT_FILTERS]` plus a custom one.
 */
export function compress(
  input: string,
  filters: readonly CompressFilter[] = DEFAULT_FILTERS,
): CompressResult {
  let text = input;
  const applied: string[] = [];
  for (const f of filters) {
    const next = f.apply(text);
    if (next !== text) applied.push(f.name);
    text = next;
  }
  const originalTokens = estimateTokens(input);
  const compressedTokens = estimateTokens(text);
  return {
    text,
    applied,
    originalChars: input.length,
    compressedChars: text.length,
    originalTokens,
    compressedTokens,
    savedRatio: originalTokens === 0 ? 0 : 1 - compressedTokens / originalTokens,
  };
}

/** Convenience: run a named preset. */
export function compressPreset(input: string, preset: PresetName = "lossless"): CompressResult {
  return compress(input, PRESETS[preset]);
}
