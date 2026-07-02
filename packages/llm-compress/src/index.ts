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

// eslint-disable-next-line no-control-regex
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

// ── Heavy lossy mode: LLMLingua-2 semantic compression (opt-in, off by default) ──
// The lossy filter above (smartTruncate) is *structural*: it drops the middle of a
// long output. LLMLingua-2 (@atjsh/llmlingua-2) goes further — a BERT-class model
// scores every token's importance and drops the low-signal ones, a *semantic*
// squeeze that keeps meaning while cutting far more than byte/line filters can.
// That power costs a real ML model at runtime, so it is gated hard:
//
//   • OFF unless the `NEXUS_LLMLINGUA=1` env var is set (or `opts.enabled` in code).
//   • `@atjsh/llmlingua-2` and its peers are OPTIONAL dependencies — NOT installed
//     by default (see package.json `optionalDependencies`).
//   • The package is imported lazily, only when the gate is on. When off,
//     `compressHeavy` returns the input unchanged and NEVER imports it or touches
//     a model — so the default install/hot-path pays nothing.
//   • First enabled run downloads ONNX model weights from Hugging Face: ~57 MB
//     (TinyBERT) up to ~2.2 GB (XLM-RoBERTa) depending on the chosen model. This
//     large one-time download is the whole reason it is opt-in.
//
// To use it: `NEXUS_LLMLINGUA=1` and install the optional peers —
//   pnpm add @atjsh/llmlingua-2 @huggingface/transformers @tensorflow/tfjs js-tiktoken

/** Which bundled LLMLingua-2 model to load. Larger = more accurate but heavier. */
export type HeavyModel = "bert-multilingual" | "xlm-roberta";

/** Default Hugging Face model id per {@link HeavyModel} (download sizes in comments). */
const HEAVY_MODEL_IDS: Record<HeavyModel, string> = {
  "bert-multilingual": "Arcoldd/llmlingua4j-bert-base-onnx", // ~710 MB
  "xlm-roberta": "atjsh/llmlingua-2-js-xlm-roberta-large-meetingbank", // ~2.2 GB
};

/** The single method of the LLMLingua-2 compressor we depend on. */
export interface HeavyPromptCompressor {
  compress_prompt(context: string, opts: { rate?: number }): Promise<string>;
}

/** An LLMLingua-2 factory (e.g. `WithBERTMultilingual`) as we call it. */
type HeavyFactory = (
  modelName: string,
  cfg: unknown,
) => Promise<{ promptCompressor: HeavyPromptCompressor }>;

export interface HeavyCompressOptions {
  /** Force on/off, overriding the `NEXUS_LLMLINGUA` env gate (mainly for tests). */
  enabled?: boolean;
  /** Fraction of tokens to KEEP, 0..1. Lower = more aggressive. Default 0.5. */
  rate?: number;
  /** Which model the default loader loads. Default "bert-multilingual". */
  model?: HeavyModel;
  /** Override the Hugging Face model id (else {@link HEAVY_MODEL_IDS}). */
  modelName?: string;
  /**
   * Seam for tests / custom setups: supply a ready compressor instead of the
   * default lazy `import('@atjsh/llmlingua-2')` + model download. Only consulted
   * when heavy mode is enabled; when omitted, the real (optional) package is
   * imported on demand.
   */
  loadCompressor?: () => Promise<HeavyPromptCompressor>;
}

/** A {@link compressHeavy} result: the base delta plus gate/lossy flags. */
export interface HeavyCompressResult extends CompressResult {
  /** True when LLMLingua-2 actually ran; false when the gate was off (passthrough). */
  enabled: boolean;
  /** LLMLingua-2 drops tokens — always lossy when it runs. */
  lossy: boolean;
}

/** The env gate. Off unless `NEXUS_LLMLINGUA` is exactly "1". Browser-safe. */
function heavyGateOn(): boolean {
  return typeof process !== "undefined" && process.env?.NEXUS_LLMLINGUA === "1";
}

/**
 * Default loader: lazily import the optional `@atjsh/llmlingua-2` package plus a
 * tiktoken tokenizer, build a compressor for `model`, and return it. Only ever
 * reached when heavy mode is enabled, so the import and the model download stay
 * out of the default path entirely. The specifiers are held in variables so `tsc`
 * does not try to resolve these not-installed optional deps at build time.
 */
async function defaultLoadCompressor(
  model: HeavyModel,
  modelName: string,
): Promise<HeavyPromptCompressor> {
  const llmlinguaPkg = "@atjsh/llmlingua-2";
  const tiktokenLite = "js-tiktoken/lite";
  const tiktokenRanks = "js-tiktoken/ranks/o200k_base";
  const { LLMLingua2 } = (await import(llmlinguaPkg)) as {
    LLMLingua2: { WithBERTMultilingual: HeavyFactory; WithXLMRoBERTa: HeavyFactory };
  };
  const { Tiktoken } = (await import(tiktokenLite)) as {
    Tiktoken: new (ranks: unknown) => unknown;
  };
  const { default: o200kBase } = (await import(tiktokenRanks)) as { default: unknown };
  const factory =
    model === "xlm-roberta" ? LLMLingua2.WithXLMRoBERTa : LLMLingua2.WithBERTMultilingual;
  const { promptCompressor } = await factory(modelName, {
    transformerJSConfig: { device: "auto", dtype: "fp32" },
    oaiTokenizer: new Tiktoken(o200kBase),
    modelSpecificOptions: { subfolder: "" },
  });
  return promptCompressor;
}

/** A no-op result: input unchanged, zero savings. Used when the gate is off. */
function heavyPassthrough(input: string): CompressResult {
  const tokens = estimateTokens(input);
  return {
    text: input,
    applied: [],
    originalChars: input.length,
    compressedChars: input.length,
    originalTokens: tokens,
    compressedTokens: tokens,
    savedRatio: 0,
  };
}

/**
 * Heavy, *lossy*, semantic compression via LLMLingua-2. OFF by default: unless
 * `NEXUS_LLMLINGUA=1` (or `opts.enabled`) this returns the input unchanged with
 * `enabled:false` and never imports the model. When on, it drops low-importance
 * tokens down to `rate` (default 0.5 — keep half) and reports the token delta.
 *
 * Async because the model runs off the main path and may download on first use;
 * the rest of this module stays synchronous. Always treat the result as lossy.
 */
export async function compressHeavy(
  input: string,
  opts: HeavyCompressOptions = {},
): Promise<HeavyCompressResult> {
  const enabled = opts.enabled ?? heavyGateOn();
  if (!enabled) {
    // DEFAULT PATH — returns before touching the loader, the package, or a model.
    return { ...heavyPassthrough(input), enabled: false, lossy: false };
  }
  const rate = opts.rate ?? 0.5;
  const model = opts.model ?? "bert-multilingual";
  const modelName = opts.modelName ?? HEAVY_MODEL_IDS[model];
  const load = opts.loadCompressor ?? (() => defaultLoadCompressor(model, modelName));
  const compressor = await load();
  const text = await compressor.compress_prompt(input, { rate });
  const originalTokens = estimateTokens(input);
  const compressedTokens = estimateTokens(text);
  return {
    text,
    applied: ["llmlingua-2"],
    originalChars: input.length,
    compressedChars: text.length,
    originalTokens,
    compressedTokens,
    savedRatio: originalTokens === 0 ? 0 : 1 - compressedTokens / originalTokens,
    enabled: true,
    lossy: true,
  };
}

// ── Engine abstraction + stacked pipeline ────────────────────────────────────────
// Ported from OmniRoute's compression architecture (REF/OmniRoute/open-sse/services/
// compression). Each engine is a pure text→text transform with a stack priority, so
// engines compose in a deterministic order. Lossless engines (lite, headroom, ccr)
// run before lossy ones (caveman, ultra). Everything here is pure-Node, no model and
// no per-request API cost — the scalable path for a BYOK gateway. Fail-open: a step
// that throws or fails to help is skipped, never breaking the request.

/** Context passed to engines. All fields optional; each engine reads what it needs. */
export interface EngineContext {
  /** Fraction of tokens to KEEP (ultra/llmlingua). */
  keepRate?: number;
  /** Rule aggressiveness (caveman/rtk). */
  intensity?: "lite" | "full" | "ultra";
  /** Source tool name, for output-aware routing (rtk). */
  toolName?: string;
  /** Auth principal, for per-tenant store scoping (ccr). */
  principalId?: string;
}

/** A composable text-compression engine. */
export interface CompressEngine {
  readonly name: string;
  /** Lower runs first in a stacked pipeline. */
  readonly stackPriority: number;
  /** True if the transform provably preserves meaning. */
  readonly lossless: boolean;
  apply(text: string, ctx?: EngineContext): string;
  /** Optional async variant (model-backed engines); the stacked-async runner prefers it. */
  applyAsync?(text: string, ctx?: EngineContext): Promise<string>;
}

/** The engine registry. Engines self-register at module load via {@link registerEngine}. */
export const ENGINES: Record<string, CompressEngine> = {};

/** Register (or replace) an engine by name. */
export function registerEngine(engine: CompressEngine): void {
  ENGINES[engine.name] = engine;
}

// ── Preserved-block protection (shared by lossy prose engines) ───────────────────
// Before a lossy prose rewrite, tombstone structured spans (code, URLs, paths, error
// lines) with private-use sentinels so regex/word rules can't mangle them, then
// restore them verbatim afterwards. Order matters: fenced code first (it may contain
// URLs/paths that must not be extracted twice).

const PB_OPEN = "";
const PB_CLOSE = "";
const PRESERVE_PATTERNS: readonly RegExp[] = [
  /```[\s\S]*?```/g, // fenced code
  /^.*(?:Error|Exception|Traceback)[:].*$/gm, // error/exception lines
  /\bhttps?:\/\/[^\s)]+/g, // URLs
  /`[^`]+`/g, // inline code
  /(?:\.{0,2}\/)[\w./-]+/g, // relative/absolute file paths
];

/** Replace structured spans with sentinels. Returns the masked text + the blocks. */
export function extractPreservedBlocks(text: string): { text: string; blocks: string[] } {
  const blocks: string[] = [];
  let out = text;
  for (const re of PRESERVE_PATTERNS) {
    out = out.replace(re, (m) => {
      const i = blocks.length;
      blocks.push(m);
      return `${PB_OPEN}${i}${PB_CLOSE}`;
    });
  }
  return { text: out, blocks };
}

/** Restore sentinels back to their original spans. Inverse of {@link extractPreservedBlocks}. */
export function restorePreservedBlocks(text: string, blocks: string[]): string {
  return text.replace(
    new RegExp(`${PB_OPEN}(\\d+)${PB_CLOSE}`, "g"),
    (_m, i: string) => blocks[Number(i)] ?? "",
  );
}

// ── lite engine (lossless): the existing default filters, as an engine ───────────

/** Lossless cleanup: ANSI strip → trailing-ws → blank-collapse → line-dedup. */
export const liteEngine: CompressEngine = {
  name: "lite",
  stackPriority: 5,
  lossless: true,
  apply: (text) => DEFAULT_FILTERS.reduce((t, f) => f.apply(t), text),
};
registerEngine(liteEngine);

// ── Stacked runner ────────────────────────────────────────────────────────────────

/** Per-engine record of what a stacked run did. */
export interface EngineBreakdown {
  name: string;
  beforeTokens: number;
  afterTokens: number;
  savedRatio: number;
  /** False when the step was skipped (error / no-op / inflated / below-min-gain). */
  applied: boolean;
  /** Reason a step was skipped, if any. */
  note?: string;
}

/** A {@link compressStacked} result: base delta + per-engine breakdown. */
export interface StackedResult extends CompressResult {
  engines: EngineBreakdown[];
}

export interface StackedOptions {
  /** Passed through to each engine. */
  ctx?: EngineContext;
  /** If > 0, skip a step whose token gain is below this percentage (bail-out). */
  minGainPercent?: number;
}

function resolveEngine(e: string | CompressEngine): CompressEngine {
  if (typeof e !== "string") return e;
  const found = ENGINES[e];
  if (!found) throw new Error(`unknown compress engine: ${e}`);
  return found;
}

/** Decide whether to keep a step's output. Never accept an inflating or no-op step. */
function acceptStep(
  before: string,
  next: string,
  minGainPercent?: number,
): { accept: boolean; note?: string } {
  if (next === before) return { accept: false, note: "no-op" };
  const bt = estimateTokens(before);
  const nt = estimateTokens(next);
  if (nt > bt || next.length > before.length) return { accept: false, note: "inflates" };
  if (minGainPercent && minGainPercent > 0) {
    const gain = bt === 0 ? 0 : (1 - nt / bt) * 100;
    if (gain < minGainPercent) return { accept: false, note: `below-min-gain(${gain.toFixed(1)}%)` };
  }
  return { accept: true };
}

function stackedResult(
  input: string,
  text: string,
  applied: string[],
  engines: EngineBreakdown[],
): StackedResult {
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
    engines,
  };
}

/**
 * Run `engines` (names or objects) over `input`, sorted by stack priority. Each step
 * is fail-open: an engine that throws, no-ops, inflates, or gains less than
 * `minGainPercent` is skipped and the prior text carried forward. A final inflation
 * guard reverts to the original if the net result isn't smaller. Returns the text
 * plus a per-engine breakdown for telemetry.
 */
export function compressStacked(
  input: string,
  engines: readonly (string | CompressEngine)[],
  opts: StackedOptions = {},
): StackedResult {
  const list = engines.map(resolveEngine).slice().sort((a, b) => a.stackPriority - b.stackPriority);
  let current = input;
  const applied: string[] = [];
  const breakdown: EngineBreakdown[] = [];
  for (const e of list) {
    const before = current;
    const beforeTokens = estimateTokens(before);
    let next = before;
    let note: string | undefined;
    try {
      next = e.apply(before, opts.ctx);
    } catch (err) {
      note = `error:${(err as Error).message}`;
      next = before;
    }
    if (!note) {
      const s = acceptStep(before, next, opts.minGainPercent);
      if (!s.accept) {
        note = s.note;
        next = before;
      }
    }
    const accepted = note === undefined;
    if (accepted) applied.push(e.name);
    current = next;
    breakdown.push({
      name: e.name,
      beforeTokens,
      afterTokens: estimateTokens(current),
      savedRatio: beforeTokens === 0 ? 0 : 1 - estimateTokens(current) / beforeTokens,
      applied: accepted,
      note,
    });
  }
  // Global inflation guard: never return something bigger than we started with.
  if (current.length >= input.length) return stackedResult(input, input, [], breakdown);
  return stackedResult(input, current, applied, breakdown);
}

/**
 * Async variant of {@link compressStacked}: prefers each engine's `applyAsync` (e.g.
 * the model-backed `llmlingua` engine) and falls back to `apply`. Same fail-open and
 * inflation-guard semantics.
 */
export async function compressStackedAsync(
  input: string,
  engines: readonly (string | CompressEngine)[],
  opts: StackedOptions = {},
): Promise<StackedResult> {
  const list = engines.map(resolveEngine).slice().sort((a, b) => a.stackPriority - b.stackPriority);
  let current = input;
  const applied: string[] = [];
  const breakdown: EngineBreakdown[] = [];
  for (const e of list) {
    const before = current;
    const beforeTokens = estimateTokens(before);
    let next = before;
    let note: string | undefined;
    try {
      next = e.applyAsync ? await e.applyAsync(before, opts.ctx) : e.apply(before, opts.ctx);
    } catch (err) {
      note = `error:${(err as Error).message}`;
      next = before;
    }
    if (!note) {
      const s = acceptStep(before, next, opts.minGainPercent);
      if (!s.accept) {
        note = s.note;
        next = before;
      }
    }
    const accepted = note === undefined;
    if (accepted) applied.push(e.name);
    current = next;
    breakdown.push({
      name: e.name,
      beforeTokens,
      afterTokens: estimateTokens(current),
      savedRatio: beforeTokens === 0 ? 0 : 1 - estimateTokens(current) / beforeTokens,
      applied: accepted,
      note,
    });
  }
  if (current.length >= input.length) return stackedResult(input, input, [], breakdown);
  return stackedResult(input, current, applied, breakdown);
}

// ── Named modes (mode → engine list), mirroring OmniRoute ────────────────────────
// Engines are resolved lazily by compressStacked, so a mode may reference an engine
// that a later work item registers; using such a mode before then throws a clear
// "unknown compress engine" error rather than failing silently.

export const COMPRESSION_MODES = {
  off: [] as readonly string[],
  lite: ["lite"],
  standard: ["caveman"],
  rtk: ["rtk"],
  ultra: ["ultra"],
  stacked: ["lite", "rtk", "caveman"],
} as const;

export type CompressionModeName = keyof typeof COMPRESSION_MODES;

/** Run a named mode's engine list through the stacked runner. `off` returns input unchanged. */
export function compressMode(
  input: string,
  mode: CompressionModeName = "lite",
  opts: StackedOptions = {},
): StackedResult {
  return compressStacked(input, [...COMPRESSION_MODES[mode]], opts);
}

// ── ultra engine (lossy, heuristic — no model) ───────────────────────────────────
// Ported from OmniRoute's ultra "Tier A" heuristic (ultraHeuristic.ts). Scores each
// whitespace-delimited token by a cheap informativeness heuristic and drops the
// lowest-value ones (stopwords, tiny filler) down to a keep-rate — the no-model,
// zero-cost stand-in for LLMLingua's perplexity pruning. Structured spans (code,
// URLs, paths, errors) are force-preserved, so only prose loses tokens.

/** Common English function words — low information, first to be pruned. */
const ULTRA_STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "am",
  "and", "or", "but", "nor", "so", "yet", "for", "of", "to", "in", "on", "at",
  "by", "with", "from", "into", "onto", "upon", "as", "if", "then", "than",
  "that", "this", "these", "those", "it", "its", "they", "them", "their",
  "we", "our", "you", "your", "i", "me", "my", "he", "she", "his", "her",
  "do", "does", "did", "done", "have", "has", "had", "will", "would", "shall",
  "should", "can", "could", "may", "might", "must", "not", "no", "yes",
  "there", "here", "just", "very", "really", "quite", "some", "any", "all",
  "about", "over", "under", "up", "down", "out", "off", "again", "also",
]);

// A token containing a digit, URL, path separator, code fence, or error marker is
// always kept — these are high-signal and must never be silently dropped.
const ULTRA_FORCE_PRESERVE = /\d|https?:\/\/|[._/\\]|Error:|Exception:|```/i;

/** Heuristic informativeness score, 0..1 (higher = keep). See {@link ULTRA_STOPWORDS}. */
export function scoreToken(token: string): number {
  if (ULTRA_FORCE_PRESERVE.test(token)) return 1.0;
  const bare = token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (bare === "") return 0.2; // pure punctuation
  if (ULTRA_STOPWORDS.has(bare)) return 0.1;
  if (bare.length <= 2) return 0.2;
  if (/^[A-Z]/.test(token)) return 0.8; // proper nouns / CONSTANTS
  if (bare.length >= 6) return 0.7; // longer words tend to carry more meaning
  return 0.5;
}

/**
 * Drop the lowest-scoring words until only `keepRate` of them remain, but never a
 * word scoring at/above `minScore`. Whitespace structure is preserved (runs of
 * horizontal space left by removed words are collapsed). Pure heuristic, no model.
 */
export function pruneByScore(text: string, keepRate = 0.5, minScore = 0.3): string {
  const parts = text.split(/(\s+)/); // alternating word / whitespace tokens
  const wordIdx: number[] = [];
  parts.forEach((p, i) => {
    if (p !== "" && !/^\s+$/.test(p)) wordIdx.push(i);
  });
  const wordCount = wordIdx.length;
  if (wordCount === 0) return text;
  const toDrop = wordCount - Math.ceil(wordCount * keepRate);
  if (toDrop <= 0) return text;
  const scored = wordIdx.map((i) => ({ i, score: scoreToken(parts[i] ?? "") }));
  scored.sort((a, b) => a.score - b.score);
  const prune = new Set<number>();
  for (const { i, score } of scored) {
    if (prune.size >= toDrop) break;
    if (score < minScore) prune.add(i);
  }
  const out = parts.map((p, i) => (prune.has(i) ? "" : p)).join("");
  return out.replace(/[ \t]{2,}/g, " ").replace(/ *\n/g, "\n").trim();
}

/** Heuristic, no-model token pruning. Lossy; keep-rate via `ctx.keepRate` (default 0.5). */
export const ultraEngine: CompressEngine = {
  name: "ultra",
  stackPriority: 40,
  lossless: false,
  apply: (text, ctx) => {
    const { text: masked, blocks } = extractPreservedBlocks(text);
    const pruned = pruneByScore(masked, ctx?.keepRate ?? 0.5);
    return restorePreservedBlocks(pruned, blocks);
  },
};
registerEngine(ultraEngine);

// ── caveman engine (lossy, rule-based prose — no model) ──────────────────────────
// Ported from OmniRoute's caveman engine (caveman.ts + cavemanRules.ts): telegraphic
// prose compression by ~2 dozen regex rules across three cumulative intensities
// (lite ⊂ full ⊂ ultra). Filler/pleasantries/hedging go at `lite`; article-drop and
// leader phrases at `full`; ultra abbreviations (database→DB, function→fn, …) at
// `ultra`. Structured spans are masked first (never rewritten), and a validation
// step reverts to the original if a rule corrupted a protected span. English-only
// for now (language-aware rule packs are a future extension).

type CavemanIntensity = "lite" | "full" | "ultra";
const CAVEMAN_RANK: Record<CavemanIntensity, number> = { lite: 0, full: 1, ultra: 2 };

interface CavemanRule {
  readonly name: string;
  readonly minIntensity: CavemanIntensity;
  /** Cheap pre-filter: skip the rule if this doesn't match (avoids needless work). */
  readonly keyword: RegExp | null;
  apply(text: string): string;
}

/** Long word → short form. Applied only at `ultra` intensity. */
const CAVEMAN_ABBREV: Record<string, string> = {
  database: "DB",
  configuration: "config",
  function: "fn",
  request: "req",
  response: "res",
  authentication: "auth",
  authorization: "authz",
  dependency: "dep",
  repository: "repo",
  application: "app",
  environment: "env",
  development: "dev",
  production: "prod",
  message: "msg",
  parameter: "param",
  argument: "arg",
  variable: "var",
  directory: "dir",
  document: "doc",
  information: "info",
};
const CAVEMAN_ABBREV_RE = new RegExp(`\\b(${Object.keys(CAVEMAN_ABBREV).join("|")})\\b`, "gi");
// Non-global twin for the .test() pre-filter (a /g regex's lastIndex is stateful).
const CAVEMAN_ABBREV_KEYWORD = new RegExp(`\\b(${Object.keys(CAVEMAN_ABBREV).join("|")})\\b`, "i");

const CAVEMAN_RULES: readonly CavemanRule[] = [
  // ── lite: filler / pleasantries / hedging / verbose framing ──
  {
    name: "pleasantries",
    minIntensity: "lite",
    keyword: /please|kindly|thank|no problem|of course|feel free/i,
    apply: (t) =>
      t.replace(
        /\b(?:please|kindly|thanks?(?: you)?|thank you|no problem|of course|feel free to)\b/gi,
        "",
      ),
  },
  {
    name: "filler_adverbs",
    minIntensity: "lite",
    keyword: /basically|essentially|actually|really|very|quite|just|simply|literally|honestly|obviously|clearly|certainly|definitely/i,
    apply: (t) =>
      t.replace(
        /\b(?:basically|essentially|actually|really|very|quite|just|simply|literally|honestly|obviously|clearly|certainly|definitely)\b/gi,
        "",
      ),
  },
  {
    name: "hedging",
    minIntensity: "lite",
    keyword: /I think|I believe|I guess|it seems|it appears|in my opinion|sort of|kind of|probably|possibly|perhaps|maybe/i,
    apply: (t) =>
      t.replace(
        /\b(?:I think|I believe|I guess|it seems that|it seems|it appears that|it appears|in my opinion|sort of|kind of|probably|possibly|perhaps|maybe)\b/gi,
        "",
      ),
  },
  {
    name: "explanatory_prefix",
    minIntensity: "lite",
    keyword: /note that|keep in mind|bear in mind|important to note/i,
    apply: (t) =>
      t.replace(
        /\b(?:it is important to note that|please note that|note that|keep in mind that|bear in mind that)\b/gi,
        "",
      ),
  },
  {
    name: "context_setup",
    minIntensity: "lite",
    keyword: /here is|here's|the following is/i,
    apply: (t) => t.replace(/\b(?:here is|here's|the following is)\b/gi, ""),
  },
  {
    name: "polite_framing",
    minIntensity: "lite",
    keyword: /could you|would you|can you|I would like you to|I'd like you to|I want you to/i,
    apply: (t) =>
      t
        .replace(/\b(?:could|would|can)\s+you(?:\s+please)?\s+/gi, "")
        .replace(/\bI(?:'d| would) like you to\s+/gi, "")
        .replace(/\bI want you to\s+/gi, ""),
  },
  {
    name: "purpose_phrases",
    minIntensity: "lite",
    keyword: /in order to|due to the fact that|for the purpose of/i,
    apply: (t) =>
      t
        .replace(/\bin order to\b/gi, "to")
        .replace(/\bdue to the fact that\b/gi, "because")
        .replace(/\bfor the purpose of\b/gi, "for"),
  },
  {
    name: "verbose_connectors",
    minIntensity: "lite",
    keyword: /furthermore|moreover|additionally|in addition|however|nevertheless|nonetheless|therefore|consequently|as a result/i,
    apply: (t) =>
      t
        .replace(/\b(?:furthermore|moreover|additionally|in addition)\b/gi, "also")
        .replace(/\b(?:however|nevertheless|nonetheless)\b/gi, "but")
        .replace(/\b(?:therefore|consequently|as a result)\b/gi, "so"),
  },
  // ── full: article drop + leader phrases (more aggressive) ──
  {
    name: "leader_phrases",
    minIntensity: "full",
    keyword: /I'll|I will|I can|I could|let me|allow me to/i,
    apply: (t) => t.replace(/\b(?:I'll|I will|I can|I could|let me|allow me to)\b/gi, ""),
  },
  {
    name: "articles",
    minIntensity: "full",
    keyword: /\b(?:a|an|the)\b/i,
    apply: (t) => t.replace(/\b(?:an|a|the)\s+(?=[A-Za-z])/gi, ""),
  },
  // ── ultra: aggressive abbreviations ──
  {
    name: "ultra_abbreviations",
    minIntensity: "ultra",
    keyword: CAVEMAN_ABBREV_KEYWORD,
    apply: (t) =>
      t.replace(CAVEMAN_ABBREV_RE, (m) => CAVEMAN_ABBREV[m.toLowerCase()] ?? m),
  },
];

/** Cheap post-pass: fix spacing/punctuation artifacts left by rule deletions. */
function cavemanCleanup(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Re-capitalize sentence starts after deletions removed leading words. */
function cavemanRecapitalize(text: string): string {
  return text.replace(/(^|[.!?]\s+)([a-z])/g, (_m, lead: string, ch: string) => lead + ch.toUpperCase());
}

/** Count how many preserved-block sentinels remain in `text`. */
function countSentinels(text: string): number {
  const m = text.match(new RegExp(`${PB_OPEN}\\d+${PB_CLOSE}`, "g"));
  return m ? m.length : 0;
}

/**
 * Rule-based prose compression at `intensity` (default "full"). Masks structured
 * spans, applies every rule at or below the intensity, cleans up, recapitalizes,
 * then restores. Reverts to the original if a rule dropped a protected span
 * (sentinel count changed) — never corrupts code/URLs/errors.
 */
export function cavemanCompress(text: string, intensity: CavemanIntensity = "full"): string {
  const { text: masked, blocks } = extractPreservedBlocks(text);
  const max = CAVEMAN_RANK[intensity];
  let out = masked;
  for (const rule of CAVEMAN_RULES) {
    if (CAVEMAN_RANK[rule.minIntensity] > max) continue;
    if (rule.keyword && !rule.keyword.test(out)) continue;
    out = rule.apply(out);
  }
  out = cavemanRecapitalize(cavemanCleanup(out));
  if (countSentinels(out) !== blocks.length) return text; // validation: revert on corruption
  return restorePreservedBlocks(out, blocks);
}

/** Rule-based prose reduction. Lossy; intensity via `ctx.intensity` (default "full"). */
export const cavemanEngine: CompressEngine = {
  name: "caveman",
  stackPriority: 20,
  lossless: false,
  apply: (text, ctx) => cavemanCompress(text, ctx?.intensity ?? "full"),
};
registerEngine(cavemanEngine);

// ── rtk engine (lossy, command/tool-output line filter) ──────────────────────────
// Ported from OmniRoute's rtk engine (engines/rtk/): the biggest single win on
// agent transcripts is throwing away the non-essential lines of command output —
// build progress, install trees, blank runs — while ALWAYS keeping errors, warnings
// and summaries. Each ruleset has `keep` patterns (take precedence — never dropped)
// and `drop` patterns; a source-tool name (`ctx.toolName`) selects the ruleset, else
// a generic one. Then consecutive-dedup + head/tail truncation cap the size.

interface RtkRuleset {
  readonly id: string;
  /** Tool-name patterns that select this ruleset. */
  readonly commands: readonly RegExp[];
  /** Lines matching any of these are ALWAYS kept (errors/summaries). */
  readonly keep: readonly RegExp[];
  /** Lines matching any of these are dropped (unless also matched by `keep`). */
  readonly drop: readonly RegExp[];
}

const RTK_RULESETS: readonly RtkRuleset[] = [
  {
    id: "typescript-build",
    commands: [/tsc|typecheck|vue-tsc/i],
    keep: [/error TS\d+/i, /\bTS\d{4}\b/, /\berror\b/i, /\bwarning\b/i, /found \d+ error/i],
    drop: [/^\s*$/, /^\s*\d+ files? (?:checked|compiled)/i, /^\s*Compiling/i],
  },
  {
    id: "eslint",
    commands: [/eslint|\blint\b/i],
    keep: [/error|warning|problem/i, /\d+ problems?/i, /[\\/][^\s]*\.[cm]?[jt]sx?/],
    drop: [/^\s*$/],
  },
  {
    id: "npm-install",
    commands: [/npm (?:i\b|install|ci)|pnpm (?:i\b|install|add)|yarn/i],
    // Keep errors + summary lines. Deliberately NOT a bare `warn` — deprecation
    // warnings are the noise we want dropped (they'd otherwise beat the drop rule).
    keep: [/\berror\b|added \d+|removed \d+|changed \d+|audited \d+|packages? in/i],
    drop: [/^\s*$/, /^npm warn deprecated/i, /^\s*[│├└]/, /idealTree|reify:|timing /i, /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/],
  },
  {
    id: "git",
    commands: [/\bgit\b/i],
    keep: [/^(?:commit|Author|Date|diff|@@|[+-])/, /\d+ files? changed/i, /insertion|deletion/i],
    drop: [/^\s*$/],
  },
];

const RTK_GENERIC: RtkRuleset = {
  id: "generic",
  commands: [],
  keep: [/error|exception|fail(?:ed|ure)?|warning|traceback/i],
  drop: [/^\s*$/],
};

/** Pick a ruleset by tool name; fall back to the generic one. */
function pickRtkRuleset(toolName?: string): RtkRuleset {
  if (toolName) {
    for (const rs of RTK_RULESETS) if (rs.commands.some((r) => r.test(toolName))) return rs;
  }
  return RTK_GENERIC;
}

function rtkFilterLines(text: string, ruleset: RtkRuleset): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (ruleset.keep.some((r) => r.test(line))) {
      out.push(line);
      continue;
    }
    if (ruleset.drop.some((r) => r.test(line))) continue;
    out.push(line);
  }
  return out.join("\n");
}

export interface RtkOptions {
  /** Source tool name, selects the ruleset (e.g. "tsc", "npm install", "git diff"). */
  toolName?: string;
  /** Cap on output lines before head/tail truncation kicks in. Default 200. */
  maxLines?: number;
  /** Hard character cap. Default 12000. */
  maxChars?: number;
}

/**
 * Filter command/tool output: drop noise lines (keeping errors/warnings/summaries),
 * fold consecutive duplicates, then head/tail-truncate to `maxLines`/`maxChars`.
 * Lossy but signal-preserving. Pure string work.
 */
export function rtkCompress(text: string, opts: RtkOptions = {}): string {
  const ruleset = pickRtkRuleset(opts.toolName);
  let out = dedupConsecutive.apply(rtkFilterLines(text, ruleset));
  const maxLines = opts.maxLines ?? 200;
  if (out.split("\n").length > maxLines) {
    out = smartTruncate(out, {
      headLines: Math.ceil(maxLines * 0.7),
      tailLines: Math.floor(maxLines * 0.3),
    });
  }
  const maxChars = opts.maxChars ?? 12000;
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n...[truncated]`;
  return out;
}

/** Command/tool-output line filter. Lossy; tool via `ctx.toolName`. */
export const rtkEngine: CompressEngine = {
  name: "rtk",
  stackPriority: 10,
  lossless: false,
  apply: (text, ctx) => rtkCompress(text, { toolName: ctx?.toolName }),
};
registerEngine(rtkEngine);
