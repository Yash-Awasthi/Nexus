// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/parseltongue — Input obfuscation engine.
 *
 * Detects trigger words likely to cause model refusals and applies
 * configurable obfuscation so the semantic meaning is preserved while
 * superficial pattern-matching fails.
 *
 * Techniques
 * ──────────
 *   leetspeak   — a→4, e→3, i→1, o→0, etc.
 *   unicode     — a→а (cyrillic homoglyph), e→е, o→о …
 *   zwj         — invisible zero-width characters inserted between letters
 *   mixedcase   — alternating / random capitalisation disruption
 *   phonetic    — ph→f, ck→k, c→k/s phoneme substitution
 *   random      — randomly pick one of the above per word
 *
 * Usage
 * ─────
 * ```ts
 * const result = applyParseltongue("how to bypass the firewall", {
 *   enabled: true, technique: "unicode", intensity: "medium", customTriggers: [],
 * });
 * console.log(result.transformedText); // "how to byp@ss the f1rewall" (approx)
 * ```
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ObfuscationTechnique =
  | "leetspeak"
  | "unicode"
  | "zwj"
  | "mixedcase"
  | "phonetic"
  | "random";

/** Obfuscation intensity type alias. */
export type ObfuscationIntensity = "light" | "medium" | "heavy";

/** Parseltongue config interface definition. */
export interface ParseltongueConfig {
  enabled: boolean;
  technique: ObfuscationTechnique;
  intensity: ObfuscationIntensity;
  customTriggers: string[];
}

/** Parseltongue result interface definition. */
export interface ParseltongueResult {
  originalText: string;
  transformedText: string;
  triggersFound: string[];
  techniqueUsed: ObfuscationTechnique;
  transformations: Array<{
    original: string;
    transformed: string;
    technique: ObfuscationTechnique;
  }>;
}

// ── Default trigger list ──────────────────────────────────────────────────────

export const DEFAULT_TRIGGERS: readonly string[] = [
  // Security
  "hack", "exploit", "bypass", "crack", "attack", "penetrate",
  "inject", "manipulate", "override", "disable", "circumvent", "evade",
  "malware", "virus", "trojan", "payload", "shellcode", "rootkit",
  "keylogger", "backdoor", "vulnerability",
  // Weapons
  "weapon", "bomb", "explosive", "poison",
  // System / privilege
  "jailbreak", "unlock", "sudo", "privilege",
  // Social engineering
  "phishing", "scam", "impersonate", "deceive", "fraud",
  // Content
  "nsfw", "explicit", "uncensored", "unfiltered", "unrestricted",
  // AI meta
  "ignore", "disregard", "forget", "pretend",
];

// ── Character maps ────────────────────────────────────────────────────────────

const LEET_MAP: Record<string, readonly string[]> = {
  a: ["4", "@", "∂", "λ"],
  b: ["8", "|3", "ß"],
  c: ["(", "<", "¢"],
  d: ["|)", "|>", "đ"],
  e: ["3", "€", "£"],
  f: ["|=", "ƒ"],
  g: ["9", "6", "&"],
  h: ["#", "|-|"],
  i: ["1", "!", "|"],
  j: ["_|", "]"],
  k: ["|<", "|{"],
  l: ["1", "|", "£"],
  m: ["|V|", "µ"],
  n: ["|\\|", "η"],
  o: ["0", "()", "°"],
  p: ["|*", "|>"],
  q: ["0_", "ℚ"],
  r: ["|2", "®"],
  s: ["5", "$", "§"],
  t: ["7", "+", "†"],
  u: ["|_|", "µ"],
  v: ["\\/", "√"],
  w: ["\\/\\/", "ω"],
  x: ["><", "×"],
  y: ["`/", "¥"],
  z: ["2", "ℤ"],
};

const UNICODE_MAP: Record<string, readonly string[]> = {
  a: ["а", "ɑ", "α"],
  b: ["Ь", "ḅ"],
  c: ["с", "ϲ"],
  d: ["ԁ", "ⅾ"],
  e: ["е", "ė"],
  f: ["ƒ"],
  g: ["ɡ"],
  h: ["һ", "ḥ"],
  i: ["і", "ι"],
  j: ["ϳ"],
  k: ["κ"],
  l: ["ӏ", "ⅼ"],
  m: ["м"],
  n: ["ո"],
  o: ["о", "ο"],
  p: ["р", "ρ"],
  s: ["ѕ"],
  t: ["τ"],
  u: ["υ"],
  v: ["ν"],
  w: ["ѡ"],
  x: ["х"],
  y: ["у", "γ"],
  z: ["ᴢ"],
};

const ZW_CHARS = ["\u200B", "\u200C", "\u200D", "\uFEFF"];

// ── Per-word obfuscation ──────────────────────────────────────────────────────

function countToTransform(len: number, intensity: ObfuscationIntensity): number {
  if (intensity === "light") return 1;
  if (intensity === "medium") return Math.ceil(len / 2);
  return len;
}

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

function applyLeetspeak(word: string, intensity: ObfuscationIntensity): string {
  const chars = word.split("");
  const n = countToTransform(chars.length, intensity);
  let count = 0;
  for (let i = 0; i < chars.length && count < n; i++) {
    const key = (chars[i] ?? "").toLowerCase();
    const opts = LEET_MAP[key];
    if (opts !== undefined && opts.length > 0) {
      chars[i] = pickRandom(opts);
      count++;
    }
  }
  return chars.join("");
}

function applyUnicode(word: string, intensity: ObfuscationIntensity): string {
  const chars = word.split("");
  const n = countToTransform(chars.length, intensity);
  let count = 0;
  for (let i = 0; i < chars.length && count < n; i++) {
    const key = (chars[i] ?? "").toLowerCase();
    const opts = UNICODE_MAP[key];
    if (opts !== undefined && opts.length > 0) {
      chars[i] = pickRandom(opts);
      count++;
    }
  }
  return chars.join("");
}

function applyZwj(word: string, intensity: ObfuscationIntensity): string {
  const chars = word.split("");
  const n = countToTransform(chars.length - 1, intensity);
  const result: string[] = [];
  let inserted = 0;
  for (let i = 0; i < chars.length; i++) {
    result.push(chars[i] ?? "");
    if (i < chars.length - 1 && inserted < n) {
      result.push(pickRandom(ZW_CHARS));
      inserted++;
    }
  }
  return result.join("");
}

function applyMixedCase(word: string, intensity: ObfuscationIntensity): string {
  const chars = word.split("");
  if (intensity === "light") {
    const idx = Math.floor(Math.random() * chars.length);
    chars[idx] = (chars[idx] ?? "").toUpperCase();
  } else if (intensity === "medium") {
    for (let i = 0; i < chars.length; i++) {
      chars[i] = i % 2 === 0 ? (chars[i] ?? "").toLowerCase() : (chars[i] ?? "").toUpperCase();
    }
  } else {
    for (let i = 0; i < chars.length; i++) {
      chars[i] =
        Math.random() > 0.5
          ? (chars[i] ?? "").toUpperCase()
          : (chars[i] ?? "").toLowerCase();
    }
  }
  return chars.join("");
}

function applyPhonetic(word: string): string {
  return word
    .replace(/ph/gi, "f")
    .replace(/ck/gi, "k")
    .replace(/qu/gi, "kw")
    .replace(/c(?=[eiy])/gi, "s")
    .replace(/c/g, "k");
}

function obfuscateWord(word: string, technique: ObfuscationTechnique, intensity: ObfuscationIntensity): string {
  switch (technique) {
    case "leetspeak":
      return applyLeetspeak(word, intensity);
    case "unicode":
      return applyUnicode(word, intensity);
    case "zwj":
      return applyZwj(word, intensity);
    case "mixedcase":
      return applyMixedCase(word, intensity);
    case "phonetic":
      return applyPhonetic(word);
    case "random": {
      const techniques: ObfuscationTechnique[] = ["leetspeak", "unicode", "zwj", "mixedcase"];
      return obfuscateWord(word, pickRandom(techniques), intensity);
    }
    default:
      return word;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect trigger words present in the text (whole-word match, case-insensitive).
 */
export function detectTriggers(text: string, customTriggers: readonly string[] = []): string[] {
  const allTriggers = [...DEFAULT_TRIGGERS, ...customTriggers];
  const found = new Set<string>();
  const lower = text.toLowerCase();
  for (const trigger of allTriggers) {
    const re = new RegExp(
      `\\b${trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "gi",
    );
    if (re.test(lower)) found.add(trigger);
  }
  return Array.from(found);
}

/**
 * Apply Parseltongue obfuscation to trigger words in the input text.
 */
export function applyParseltongue(text: string, config: ParseltongueConfig): ParseltongueResult {
  if (!config.enabled) {
    return {
      originalText: text,
      transformedText: text,
      triggersFound: [],
      techniqueUsed: config.technique,
      transformations: [],
    };
  }

  const triggersFound = detectTriggers(text, config.customTriggers);

  if (triggersFound.length === 0) {
    return {
      originalText: text,
      transformedText: text,
      triggersFound: [],
      techniqueUsed: config.technique,
      transformations: [],
    };
  }

  let transformed = text;
  const transformations: ParseltongueResult["transformations"] = [];

  // Sort by length (longest first) to avoid partial-match clobbering
  const sorted = [...triggersFound].sort((a, b) => b.length - a.length);

  for (const trigger of sorted) {
    const re = new RegExp(
      `\\b(${trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\b`,
      "gi",
    );
    transformed = transformed.replace(re, (match) => {
      const result = obfuscateWord(match, config.technique, config.intensity);
      transformations.push({ original: match, transformed: result, technique: config.technique });
      return result;
    });
  }

  return {
    originalText: text,
    transformedText: transformed,
    triggersFound,
    techniqueUsed: config.technique,
    transformations,
  };
}

/** Get default config. */
export function getDefaultConfig(): ParseltongueConfig {
  return { enabled: false, technique: "leetspeak", intensity: "medium", customTriggers: [] };
}

/** Get technique description. */
export function getTechniqueDescription(technique: ObfuscationTechnique): string {
  const map: Record<ObfuscationTechnique, string> = {
    leetspeak: "Classic l33tspeak: a→4, e→3, etc.",
    unicode: "Unicode homoglyphs (cyrillic, greek)",
    zwj: "Invisible zero-width characters",
    mixedcase: "Disrupted casing patterns",
    phonetic: "Phonetic spelling substitutions",
    random: "Random mix of all techniques",
  };
  return map[technique];
}
