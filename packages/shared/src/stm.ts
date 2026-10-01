// SPDX-License-Identifier: Apache-2.0
/**
 * Semantic Transformation Modules (STM)
 *
 * Modular, pluggable post-processors applied to LLM output text.
 * Each module is a pure function: (input, config?) => string.
 * Modules are opt-in and configurable per-call.
 *
 * Ported and extended from elder-plinius/G0DM0D3 (HF/src/stm/modules.ts).
 *
 * Usage:
 *   import { applySTMs, hedgeReducer, directMode } from "@nexus/shared";
 *   const cleaned = applySTMs(rawOutput, [
 *     { ...hedgeReducer, enabled: true },
 *     { ...directMode, enabled: true },
 *   ]);
 */

// ── Core interface ────────────────────────────────────────────────────────────

export interface STMModule {
  /** Stable machine identifier */
  id: string;
  /** Human-readable label */
  name: string;
  /** What this module does */
  description: string;
  version: string;
  /** Whether this module is active — applySTMs skips disabled modules */
  enabled: boolean;
  /** Optional per-module config passed through to the transformer */
  config?: Record<string, unknown>;
  transformer: (input: string, config?: Record<string, unknown>) => string;
}

// ── applySTMs ─────────────────────────────────────────────────────────────────

/**
 * Run a list of STM modules over `text` in order.
 * Only enabled modules are applied. Returns the accumulated result.
 */
export function applySTMs(text: string, modules: STMModule[]): string {
  let result = text;
  for (const mod of modules) {
    if (mod.enabled) {
      result = mod.transformer(result, mod.config);
    }
  }
  return result;
}

// ── Hedge Reducer ─────────────────────────────────────────────────────────────

/**
 * Strips hedging qualifiers from LLM output.
 * Before: "I think perhaps this might work."
 * After:  "This might work."
 *
 * Removes uncertainty phrases that dilute confidence in agent responses.
 * Leave enabled: false — callers opt in explicitly.
 */
export const hedgeReducer: STMModule = {
  id: "hedge_reducer",
  name: "Hedge Reducer",
  description:
    "Removes hedging qualifiers (I think, perhaps, maybe, probably) for more decisive output",
  version: "1.0.0",
  enabled: false,
  transformer: (input: string): string => {
    const patterns: RegExp[] = [
      /\bI think\s+/gi,
      /\bI believe\s+/gi,
      /\bI feel\s+/gi,
      /\bperhaps\s+/gi,
      /\bmaybe\s+/gi,
      /\bIt seems like\s+/gi,
      /\bIt seems that\s+/gi,
      /\bIt appears that\s+/gi,
      /\bIt appears\s+/gi,
      /\bprobably\s+/gi,
      /\bpossibly\s+/gi,
      /\bI would say\s+/gi,
      /\bIn my opinion,?\s*/gi,
      /\bFrom my perspective,?\s*/gi,
      /\bI suspect\s+/gi,
      /\bI guess\s+/gi,
      /\bOne might\s+/gi,
    ];

    let result = input;
    for (const pattern of patterns) {
      result = result.replace(pattern, "");
    }
    // Re-capitalise first letter of each sentence after removal
    result = result.replace(
      /^(\s*)([a-z])/gm,
      (_, space, letter: string) => space + letter.toUpperCase(),
    );
    return result;
  },
};

// ── Direct Mode ───────────────────────────────────────────────────────────────

/**
 * Strips preamble filler that wastes tokens without adding signal.
 * Before: "Sure! I'd be happy to help. Here's the answer: ..."
 * After:  "Here's the answer: ..."
 */
export const directMode: STMModule = {
  id: "direct_mode",
  name: "Direct Mode",
  description: "Removes preambles and sycophantic filler phrases from the start of responses",
  version: "1.0.0",
  enabled: false,
  transformer: (input: string): string => {
    const preambles: RegExp[] = [
      /^(Sure[!,]?\s*)/i,
      /^(Of course[!,]?\s*)/i,
      /^(Certainly[!,]?\s*)/i,
      /^(Absolutely[!,]?\s*)/i,
      /^(Great question[!,]?\s*)/i,
      /^(That's (an? )?(great|good|excellent|interesting) question[!,]?\s*)/i,
      /^(I'd be (happy|glad|delighted) to help( you)?( with that)?[.!]?\s*)/i,
      /^(Let me help you with that[.!]?\s*)/i,
      /^(I understand[.!]?\s*)/i,
      /^(Thanks for (asking|sharing)[.!]?\s*)/i,
      /^(Happy to help[.!]?\s*)/i,
      /^(Of course! Here('s| is))/i,
    ];

    let result = input;
    for (const pattern of preambles) {
      result = result.replace(pattern, "");
    }
    result = result.replace(/^\s*([a-z])/, (_, letter: string) => letter.toUpperCase());
    return result.trimStart();
  },
};

// ── Casual Mode ───────────────────────────────────────────────────────────────

/**
 * Converts formal/academic vocabulary to plain conversational language.
 * Before: "Utilize the configuration to commence the process."
 * After:  "Use the configuration to start the process."
 */
export const casualMode: STMModule = {
  id: "casual_mode",
  name: "Casual Mode",
  description: "Converts formal vocabulary to plain conversational language",
  version: "1.0.0",
  enabled: false,
  transformer: (input: string): string => {
    return input
      .replace(/\bHowever\b/g, "But")
      .replace(/\bTherefore\b/g, "So")
      .replace(/\bFurthermore\b/g, "Also")
      .replace(/\bAdditionally\b/g, "Plus")
      .replace(/\bNevertheless\b/g, "Still")
      .replace(/\bConsequently\b/g, "So")
      .replace(/\bMoreover\b/g, "Also")
      .replace(/\bUtilize\b/g, "Use")
      .replace(/\butilize\b/g, "use")
      .replace(/\bPurchase\b/g, "Buy")
      .replace(/\bpurchase\b/g, "buy")
      .replace(/\bObtain\b/g, "Get")
      .replace(/\bobtain\b/g, "get")
      .replace(/\bCommence\b/g, "Start")
      .replace(/\bcommence\b/g, "start")
      .replace(/\bTerminate\b/g, "End")
      .replace(/\bterminate\b/g, "end")
      .replace(/\bPrior to\b/gi, "Before")
      .replace(/\bSubsequent to\b/gi, "After")
      .replace(/\bIn order to\b/gi, "To")
      .replace(/\bDue to the fact that\b/gi, "Because")
      .replace(/\bAt this point in time\b/gi, "Now")
      .replace(/\bIn the event that\b/gi, "If")
      .replace(/\bWith regard to\b/gi, "About")
      .replace(/\bWith respect to\b/gi, "About");
  },
};

// ── Directional Optimizer ─────────────────────────────────────────────────────

/**
 * Converts common passive-voice constructions to active voice.
 * Before: "The config is loaded by the runtime."
 * After:  "The runtime loads the config."
 *
 * Uses heuristic pattern matching — works on common passive constructions
 * without a full dependency parser. Complex sentences may not transform.
 */
export const directionalOptimizer: STMModule = {
  id: "directional_optimizer",
  name: "Directional Optimizer",
  description: "Converts passive voice to active voice for more direct, readable output",
  version: "1.0.0",
  enabled: false,
  transformer: (input: string): string => {
    if (input.length > 100_000) return input;
    // Pattern: "<subject> is/are/was/were <past-participle> by <agent>"
    // → "<agent> <verb> <subject>"
    // This covers the most common passive construction.
    const passiveByPattern =
      /(\b\w[\w\s,]+?)\s+(?:is|are|was|were|has been|have been|had been)\s+(\w+ed|\w+en)\s+by\s+([\w\s]+?)([.,;!?]|$)/gi;

    let result = input.replace(
      passiveByPattern,
      (_match, subject: string, participle: string, agent: string, punct: string) => {
        const agentClean = agent.trim();
        const subjectClean = subject.trim();
        // Reconstruct as active: agent + verb-stem + subject
        // Simple heuristic: strip -ed/-en to approximate present tense
        const verbStem = participle.replace(/ed$/, "").replace(/en$/, "");
        return `${agentClean} ${verbStem}s ${subjectClean}${punct}`;
      },
    );

    // Strip common "It is/was X that/which" expletive constructions
    result = result.replace(/\bIt is (important|worth noting|notable) that\s+/gi, "");
    result = result.replace(/\bIt was (found|determined|observed) that\s+/gi, "");
    result = result.replace(/\bThere (is|are|was|were) a need to\s+/gi, "");

    return result;
  },
};

// ── Convenience preset collections ────────────────────────────────────────────

/** All built-in modules, all disabled by default — clone and enable as needed */
export const ALL_STM_MODULES: STMModule[] = [
  hedgeReducer,
  directMode,
  casualMode,
  directionalOptimizer,
];

/**
 * Recommended preset for council deliberation output.
 * Strips hedges and preambles; leaves voice and vocabulary untouched.
 */
export const COUNCIL_STM_PRESET: STMModule[] = [
  { ...hedgeReducer, enabled: true },
  { ...directMode, enabled: true },
];
