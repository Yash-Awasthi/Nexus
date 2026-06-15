// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/plugin-modes — Declarative behavioral modes configurable per-request.
 *
 * A mode applies parameter deltas on top of a base AutoTune param set and
 * injects a system-prompt snippet. Multiple modes can be stacked via applyAll().
 *
 * Built-in modes
 * ──────────────
 *   chill    — casual tone, lower temperature
 *   precise  — formal, constrained, low entropy
 *   creative — high entropy, imaginative
 *   debug    — step-by-step reasoning, explicit assumptions
 *   concise  — maximally brief responses
 *   ar       — Arabic language mode (locale: "ar")
 *   bn       — Bengali language mode (locale: "bn")
 *
 * Usage
 * ─────
 * ```ts
 * import { globalModes } from "@nexus/plugin-modes";
 *
 * const { params, systemPromptSnippet } = globalModes.apply(baseParams, "precise");
 * // Stack multiple modes:
 * const result = globalModes.applyAll(baseParams, ["precise", "ar"]);
 * ```
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** Signed deltas added to base AutoTuneParams numeric fields. */
export interface ModeParams {
  temperatureDelta?: number;
  top_pDelta?: number;
  top_kDelta?: number;
  frequency_penaltyDelta?: number;
  presence_penaltyDelta?: number;
}

/** Partial params accepted as input to apply(). All fields optional with sensible defaults. */
export interface BaseAutoTuneParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
}

/** Fully resolved params with all fields present. */
export interface ResolvedParams {
  temperature: number;
  top_p: number;
  top_k: number;
  frequency_penalty: number;
  presence_penalty: number;
  repetition_penalty: number;
}

/** Plugin mode interface definition. */
export interface PluginMode {
  id: string;
  description?: string;
  params: ModeParams;
  /** Appended to system prompt when this mode is active. */
  systemPromptSnippet: string;
  /** BCP-47 language code (e.g. "ar", "bn"). Signals the expected output locale. */
  locale?: string;
}

/** Apply result interface definition. */
export interface ApplyResult {
  params: ResolvedParams;
  systemPromptSnippet: string;
  locale?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

const DEFAULTS: Required<BaseAutoTuneParams> = {
  temperature: 0.7,
  top_p: 0.9,
  top_k: 50,
  frequency_penalty: 0.1,
  presence_penalty: 0.1,
  repetition_penalty: 1.0,
};

function resolve(base: BaseAutoTuneParams): ResolvedParams {
  return {
    temperature:       base.temperature       ?? DEFAULTS.temperature,
    top_p:             base.top_p             ?? DEFAULTS.top_p,
    top_k:             base.top_k             ?? DEFAULTS.top_k,
    frequency_penalty: base.frequency_penalty ?? DEFAULTS.frequency_penalty,
    presence_penalty:  base.presence_penalty  ?? DEFAULTS.presence_penalty,
    repetition_penalty:base.repetition_penalty?? DEFAULTS.repetition_penalty,
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export class PluginModeRegistry {
  private readonly modes = new Map<string, PluginMode>();

  /** Register a mode. Overwrites any existing definition with the same id. */
  register(mode: PluginMode): void {
    this.modes.set(mode.id, mode);
  }

  get(id: string): PluginMode | undefined {
    return this.modes.get(id);
  }

  has(id: string): boolean {
    return this.modes.has(id);
  }

  list(): PluginMode[] {
    return [...this.modes.values()];
  }

  /**
   * Apply a single mode's param deltas to baseParams.
   * Returns resolved params (all fields present), the mode's system prompt snippet,
   * and the mode's locale (if any).
   * Unknown modeId → returns resolved base params, empty snippet, no locale.
   */
  apply(baseParams: BaseAutoTuneParams, modeId: string): ApplyResult {
    const base = resolve(baseParams);
    const mode = this.modes.get(modeId);
    if (!mode) return { params: base, systemPromptSnippet: "" };

    const d = mode.params;
    const params: ResolvedParams = {
      temperature:       clamp(base.temperature       + (d.temperatureDelta       ?? 0), 0, 2),
      top_p:             clamp(base.top_p             + (d.top_pDelta             ?? 0), 0, 1),
      top_k:             Math.round(clamp(base.top_k  + (d.top_kDelta             ?? 0), 1, 100)),
      frequency_penalty: clamp(base.frequency_penalty + (d.frequency_penaltyDelta ?? 0), -2, 2),
      presence_penalty:  clamp(base.presence_penalty  + (d.presence_penaltyDelta  ?? 0), -2, 2),
      repetition_penalty: base.repetition_penalty,
    };

    return { params, systemPromptSnippet: mode.systemPromptSnippet, locale: mode.locale };
  }

  /**
   * Apply multiple modes in order, accumulating deltas on top of each previous result.
   * System prompt snippets are joined with double newline.
   * First locale encountered wins.
   */
  applyAll(baseParams: BaseAutoTuneParams, modeIds: string[]): ApplyResult {
    let current: BaseAutoTuneParams = baseParams;
    const snippets: string[] = [];
    let locale: string | undefined;

    for (const id of modeIds) {
      const r = this.apply(current, id);
      current = r.params;
      if (r.systemPromptSnippet) snippets.push(r.systemPromptSnippet);
      if (r.locale && !locale) locale = r.locale;
    }

    return {
      params: resolve(current),
      systemPromptSnippet: snippets.join("\n\n"),
      locale,
    };
  }
}

// ── Built-in modes ────────────────────────────────────────────────────────────

export const BUILTIN_MODES: PluginMode[] = [
  {
    id: "chill",
    description: "Relaxed, casual tone with slightly lower temperature",
    params: { temperatureDelta: -0.2, top_pDelta: -0.05, frequency_penaltyDelta: -0.05 },
    systemPromptSnippet:
      "Be casual, friendly, and conversational. Use simple language and feel free to use contractions and informal phrasing.",
  },
  {
    id: "precise",
    description: "Formal, constrained, highly accurate — low entropy",
    params: { temperatureDelta: -0.35, top_pDelta: -0.1, top_kDelta: -20, presence_penaltyDelta: -0.05 },
    systemPromptSnippet:
      "Be precise, formal, and factual. Avoid speculation. Use structured responses with clear headings. Cite limitations and assumptions explicitly.",
  },
  {
    id: "creative",
    description: "High entropy, exploratory, imaginative",
    params: { temperatureDelta: 0.4, top_pDelta: 0.05, top_kDelta: 30, presence_penaltyDelta: 0.3 },
    systemPromptSnippet:
      "Be imaginative, exploratory, and unconventional. Draw unexpected connections. Use vivid language and metaphor freely.",
  },
  {
    id: "debug",
    description: "Explicit step-by-step reasoning with stated assumptions",
    params: { temperatureDelta: -0.2 },
    systemPromptSnippet:
      "Think step by step. Before your final answer, show your reasoning prefixed with 'Reasoning:'. State all assumptions explicitly.",
  },
  {
    id: "concise",
    description: "Maximally brief, dense responses with no fluff",
    params: { temperatureDelta: -0.1, top_kDelta: -10 },
    systemPromptSnippet:
      "Be maximally concise. Omit preamble and filler. Answer directly. Use bullets for lists. Target half the length you would normally produce.",
  },
  {
    id: "ar",
    description: "Arabic language output mode",
    params: {},
    systemPromptSnippet:
      "Respond in Arabic (العربية). Use Modern Standard Arabic (فصحى) unless context indicates a specific dialect.",
    locale: "ar",
  },
  {
    id: "bn",
    description: "Bengali language output mode",
    params: {},
    systemPromptSnippet: "Respond in Bengali (বাংলা). Use standard written Bengali.",
    locale: "bn",
  },
];

/** Default registry pre-seeded with all built-in modes. */
export const globalModes = new PluginModeRegistry();
for (const mode of BUILTIN_MODES) globalModes.register(mode);
