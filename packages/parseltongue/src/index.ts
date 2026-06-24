// SPDX-License-Identifier: Apache-2.0
// Parseltongue — input perturbation / trigger-word obfuscation engine.

export type Technique = "leetspeak" | "unicode" | "zwj" | "mixedcase" | "phonetic" | "random";
export type Intensity = "light" | "medium" | "heavy";

export interface ParseltongueConfig {
  enabled: boolean;
  technique: Technique;
  intensity: Intensity;
  customTriggers?: string[];
}

export interface Transformation {
  original: string;
  transformed: string;
  position: number;
}

export interface ParseltongueResult {
  originalText: string;
  transformedText: string;
  triggersFound: string[];
  techniqueUsed: Technique;
  transformations: Transformation[];
}

export const DEFAULT_TRIGGERS: readonly string[] = [
  "hack",
  "exploit",
  "malware",
  "virus",
  "ransomware",
  "phishing",
  "bypass",
  "crack",
  "ddos",
  "sql injection",
  "xss",
  "zero day",
  "rootkit",
  "keylogger",
  "botnet",
  "weapon",
  "bomb",
  "explosive",
  "illegal",
  "piracy",
  "counterfeit",
  "fraud",
  "jailbreak",
  "uncensored",
  "unrestricted",
  "ignore instructions",
  "ignore previous",
  "dan",
  "do anything now",
];

const INTENSITY_RATIOS: Record<Intensity, number> = {
  light: 0.3,
  medium: 0.6,
  heavy: 1.0,
};

const LEETSPEAK_MAP: Record<string, string> = {
  a: "4",
  e: "3",
  i: "1",
  o: "0",
  s: "5",
  t: "7",
  l: "|",
  g: "9",
};

const PHONETIC_MAP: Record<string, string> = {
  a: "ay",
  e: "ee",
  i: "eye",
  o: "oh",
  u: "you",
  c: "see",
  k: "kay",
  s: "ess",
  x: "ex",
};

const UNICODE_MAP: Record<string, string> = {
  a: "\u0430",
  e: "\u0435",
  o: "\u043e",
  p: "\u0440",
  c: "\u0441",
  x: "\u0445",
  A: "\u0410",
  B: "\u0412",
  E: "\u0415",
  H: "\u041d",
  K: "\u041a",
  M: "\u041c",
  O: "\u041e",
  P: "\u0420",
  T: "\u0422",
  X: "\u0425",
};

function applyTechnique(word: string, technique: Technique, intensity: Intensity): string {
  const ratio = INTENSITY_RATIOS[intensity];
  const chars = word.split("");
  switch (technique) {
    case "leetspeak":
      return chars
        .map((c, i) =>
          i / chars.length < ratio && LEETSPEAK_MAP[c.toLowerCase()]
            ? LEETSPEAK_MAP[c.toLowerCase()]!
            : c,
        )
        .join("");
    case "unicode":
      return chars
        .map((c, i) => (i / chars.length < ratio && UNICODE_MAP[c] ? UNICODE_MAP[c]! : c))
        .join("");
    case "zwj":
      return chars.map((c, i) => (i > 0 && i / chars.length < ratio ? "\u200d" + c : c)).join("");
    case "mixedcase":
      return chars
        .map((c, i) =>
          i / chars.length < ratio ? (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()) : c,
        )
        .join("");
    case "phonetic":
      return chars
        .map((c, i) =>
          i / chars.length < ratio && PHONETIC_MAP[c.toLowerCase()]
            ? PHONETIC_MAP[c.toLowerCase()]!
            : c,
        )
        .join("");
    case "random": {
      const pool: Technique[] = ["leetspeak", "unicode", "mixedcase"];
      const t = pool[Math.floor(Math.random() * pool.length)]!;
      return applyTechnique(word, t, intensity);
    }
    default:
      return word;
  }
}

export function getDefaultConfig(): ParseltongueConfig {
  return { enabled: true, technique: "unicode", intensity: "medium", customTriggers: [] };
}

export function getTechniqueDescription(technique: string): string {
  const descriptions: Record<string, string> = {
    leetspeak: "Substitutes letters with visually similar numbers and symbols (a→4, e→3, i→1).",
    unicode:
      "Replaces Latin characters with Cyrillic/Greek homoglyphs identical to the eye but distinct in codepoint.",
    zwj: "Inserts Zero-Width Joiner (U+200D) between letters to break token-level pattern detection.",
    mixedcase: "Alternates uppercase and lowercase to defeat case-insensitive pattern matching.",
    phonetic: "Replaces vowels and consonants with phonetic equivalents (a→ay, e→ee, i→eye).",
    random: "Randomly selects between leetspeak, unicode, and mixedcase per word.",
  };
  return descriptions[technique] ?? "Unknown technique.";
}

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

  const allTriggers = [...DEFAULT_TRIGGERS, ...(config.customTriggers ?? [])];
  const triggersFound: string[] = [];
  const transformations: Transformation[] = [];

  const segments = text.split(/(\s+)/);
  const result: string[] = [];
  let pos = 0;

  for (const seg of segments) {
    const lower = seg.toLowerCase().trim();
    const hit = lower.length > 0 ? allTriggers.find((t) => lower.includes(t)) : undefined;

    if (hit) {
      if (!triggersFound.includes(hit)) triggersFound.push(hit);
      const core = seg.trimStart();
      const lead = seg.slice(0, seg.length - core.length);
      const obfuscated = applyTechnique(core, config.technique, config.intensity);
      const full = lead + obfuscated;
      transformations.push({ original: seg, transformed: full, position: pos });
      result.push(full);
    } else {
      result.push(seg);
    }
    pos += seg.length;
  }

  return {
    originalText: text,
    transformedText: result.join(""),
    triggersFound,
    techniqueUsed: config.technique,
    transformations,
  };
}
