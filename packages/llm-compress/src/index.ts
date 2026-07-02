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

// ── Auto-detect tool output → matched lossless filter set ───────────────────────
// Rather than make callers know which filter their text needs, sniff the text for
// cheap structural traits and apply only the lossless filters that can help. Pure
// detection (no /g state) so it never mutates regex lastIndex between calls. Always
// lossless: detection only ever selects from DEFAULT_FILTERS, never lossy steps.

/** Structural traits a chunk of tool output can exhibit. A chunk may have several. */
export type OutputTrait = "ansi" | "trailing-ws" | "blank-runs" | "repeat-runs";

const ANSI_DETECT = /\[[0-9;?]*[ -/]*[@-~]/; // non-global: safe for .test()
const TRAILING_WS_DETECT = /[ \t]+(\r?\n|$)/;
const BLANK_RUNS_DETECT = /(\r?\n)[ \t]*(\r?\n)[ \t]*(\r?\n)/;

/** Sniff which lossless-cleanable traits the text has. Cheap, allocation-free-ish. */
export function detectTraits(input: string): OutputTrait[] {
  const traits: OutputTrait[] = [];
  if (ANSI_DETECT.test(input)) traits.push("ansi");
  if (TRAILING_WS_DETECT.test(input)) traits.push("trailing-ws");
  if (BLANK_RUNS_DETECT.test(input)) traits.push("blank-runs");
  // repeat-runs: any line equal to the line before it.
  const lines = input.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === lines[i - 1] && lines[i] !== "") {
      traits.push("repeat-runs");
      break;
    }
  }
  return traits;
}

const TRAIT_FILTER: Record<OutputTrait, CompressFilter> = {
  ansi: stripAnsi,
  "trailing-ws": trimTrailing,
  "blank-runs": collapseBlankLines,
  "repeat-runs": dedupConsecutive,
};

/**
 * Detect the text's traits and run only the matching lossless filters. Equivalent
 * result to the full lossless pipeline, but `result.applied` reflects what the
 * detector chose, and the returned `traits` let callers log what was found. Use
 * this when the input type is unknown (generic tool/command output).
 */
export function compressAuto(input: string): CompressResult & { traits: OutputTrait[] } {
  const traits = detectTraits(input);
  // Preserve DEFAULT_FILTERS ordering (cheap byte-strips before line folds).
  const filters = DEFAULT_FILTERS.filter((f) =>
    traits.some((t) => TRAIT_FILTER[t].name === f.name),
  );
  return { ...compress(input, filters), traits };
}

// ── Tool-name → filter router ───────────────────────────────────────────────────
// compressAuto picks filters from the text alone. But the SOURCE tool tells us more
// than the bytes do: a `git diff`'s identical context lines must NOT be folded (the
// ×N marker corrupts a patch), while a build log's huge progress-spam middle is the
// one place tail-truncation is safe-ish. This router maps a tool name to a curated
// profile, then still intersects with detected traits so a filter only runs when it
// can actually help. Lossless by default; lossy truncation is opt-in per call.

/** A tool-output shape with known compression characteristics. */
export type ToolProfileName = "diff" | "grep" | "listing" | "build-log" | "generic";

interface ToolCompressProfile {
  /** Lossless filters this tool's output may safely receive (DEFAULT_FILTERS subset). */
  filters: readonly CompressFilter[];
  /** Optional tail-truncation for known-huge outputs — applied only when allowLossy. */
  truncate?: { headLines: number; tailLines: number };
}

const TOOL_PROFILES: Record<ToolProfileName, ToolCompressProfile> = {
  // No dedup: a diff legitimately repeats context lines and folding breaks the patch.
  diff: { filters: [stripAnsi, trimTrailing, collapseBlankLines] },
  // Full lossless set; never truncate — dropping matches would hide search results.
  grep: { filters: DEFAULT_FILTERS },
  // Listings fold well (repeated perms/owners) but have no meaningful blank runs.
  listing: { filters: [stripAnsi, trimTrailing, dedupConsecutive] },
  // Build/test logs: full lossless set, plus opt-in tail-truncation (head=errors/cmd,
  // tail=failures/summary; the middle is progress spam).
  "build-log": { filters: DEFAULT_FILTERS, truncate: { headLines: 80, tailLines: 40 } },
  generic: { filters: DEFAULT_FILTERS },
};

/** Map a tool name (any separator/case) to its output profile. Falls back to generic. */
export function resolveToolProfile(toolName: string): ToolProfileName {
  const n = toolName.toLowerCase();
  if (n.includes("diff")) return "diff";
  if (/grep|ripgrep|\brg\b|\bag\b|\back\b|search/.test(n)) return "grep";
  if (/build|compile|\btsc\b|test|vitest|jest|lint|\bnpm\b|pnpm|yarn|\bmake\b|cargo|gradle|webpack|bundle/.test(n))
    return "build-log";
  if (/\bls\b|\bdir\b|find|tree|glob|list|readdir|read_dir/.test(n)) return "listing";
  return "generic";
}

/** A {@link compressForTool} result: the base pass plus what the router chose. */
export interface ToolCompressResult extends CompressResult {
  traits: OutputTrait[];
  tool: ToolProfileName;
  /** True when lossy truncation dropped content (only possible with allowLossy). */
  lossy: boolean;
}

/**
 * Compress `input` using the profile for `toolName`. The profile's filters are
 * intersected with the text's detected traits, so nothing runs that can't help and
 * — crucially — corruption-prone filters (dedup on diffs) are excluded by profile.
 *
 * Lossless unless `opts.allowLossy` is set AND the profile defines a truncation
 * (only `build-log` today); then the cleaned text is tail-truncated and `lossy`
 * is true. Never silently lossy.
 */
export function compressForTool(
  toolName: string,
  input: string,
  opts: { allowLossy?: boolean } = {},
): ToolCompressResult {
  const tool = resolveToolProfile(toolName);
  const profile = TOOL_PROFILES[tool];
  const traits = detectTraits(input);
  const allowed = new Set(profile.filters.map((f) => f.name));
  // Keep a filter only if the profile allows it AND the text exhibits its trait.
  const filters = DEFAULT_FILTERS.filter(
    (f) => allowed.has(f.name) && traits.some((t) => TRAIT_FILTER[t].name === f.name),
  );
  let result = compress(input, filters);
  let lossy = false;

  if (opts.allowLossy && profile.truncate) {
    const truncated = smartTruncate(result.text, profile.truncate);
    if (truncated !== result.text) {
      lossy = true;
      const compressedTokens = estimateTokens(truncated);
      result = {
        ...result,
        text: truncated,
        compressedChars: truncated.length,
        compressedTokens,
        applied: [...result.applied, "smart-truncate"],
        savedRatio: result.originalTokens === 0 ? 0 : 1 - compressedTokens / result.originalTokens,
      };
    }
  }

  return { ...result, traits, tool, lossy };
}

// ── System-prompt injectors (opt-in; NEVER silently alter agent semantics) ──────
// These change how the MODEL behaves, not the text it reads, so they are never in
// any default pipeline. A caller opts in per-agent / per-request and the injected
// block is appended to the system prompt verbatim.

/** A named instruction block appended to a system prompt when opted in. */
export interface SystemPromptInjector {
  readonly name: string;
  readonly text: string;
}

/** Ask for terse, preamble-free output. Cuts output tokens on chatty models. */
export const terseOutput: SystemPromptInjector = {
  name: "terse-output",
  text: "Be terse. Answer directly with no preamble, restatement of the question, or closing summary. Drop filler and hedging. Use the fewest words that fully answer.",
};

/** Ask for the minimal code that solves the task — no speculative scaffolding. */
export const yagniMinimalCode: SystemPromptInjector = {
  name: "yagni-minimal-code",
  text: "Write the minimum code that solves the stated problem. No speculative abstractions, configuration, or features that were not requested. Prefer editing existing code over adding new files.",
};

export const INJECTORS = {
  "terse-output": terseOutput,
  "yagni-minimal-code": yagniMinimalCode,
} as const;

export type InjectorName = keyof typeof INJECTORS;

/**
 * Append the named injector blocks to a base system prompt. Order-preserving and
 * idempotent-safe (an injector whose text is already present is skipped). Returns
 * the base unchanged when no injectors are requested.
 */
export function injectSystemPrompt(base: string, injectors: readonly InjectorName[]): string {
  if (injectors.length === 0) return base;
  const trimmed = base.trimEnd();
  const blocks = injectors
    .map((n) => INJECTORS[n].text)
    .filter((text) => !trimmed.includes(text));
  if (blocks.length === 0) return base;
  return [trimmed, ...blocks].filter(Boolean).join("\n\n");
}
