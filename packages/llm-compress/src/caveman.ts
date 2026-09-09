// SPDX-License-Identifier: Apache-2.0
/**
 * Caveman compression — "why use many token when few token do trick".
 *
 * Port of the OmniRoute *Standard* mode (itself inspired by Caveman by
 * JuliusBrussee): removes filler words, condenses verbose phrases, and strips
 * polite hedging from natural-language prose — cutting ~30% of tokens on
 * chatty text.
 *
 * Safety contract (mirrors OmniRoute's validateCompression):
 *   • LOSSY — opt-in only; never in the default pipeline.
 *   • Protected content is masked out before any rule runs: fenced code
 *     blocks, inline code, URLs, file paths, JSON, and other brace-balanced
 *     payloads pass through byte-identical.
 *   • A minimum-savings gate: if the rewrite would save fewer than
 *     `minSaveChars` characters, the input is returned UNCHANGED. Compression
 *     never ships a pointless or destructive rewrite.
 */

/** Mask placeholder for protected spans (NUL-delimited index). */
const MASK = "\u0000";
const MASK_RE = /\u0000(\d+)\u0000/g;

/** Spans that must pass through untouched: code, URLs, paths, JSON-ish payloads. */
const PROTECTED_RE =
  /```[\s\S]*?```|`[^`\n]+`|\bhttps?:\/\/[^\s)\]]+|\b[\w./-]+\.(?:ts|tsx|js|jsx|py|json|md|yml|yaml|css|html|go|rs|java|sh|bash|txt|log)\b|\{[^{}\n]{0,400}\}/g;

export interface CavemanOptions {
  /** Minimum chars the rewrite must save, else input is returned unchanged. */
  minSaveChars?: number;
}

/**
 * Filler/phrase rules. Ordered: multi-word phrases first so a removal never
 * eats half of a longer phrase. Each rule is a (regex, replacement) pair.
 * Rules are word-boundary-anchored and case-insensitive, so identifiers like
 * `pleaseWait` or `kindOf` inside code are never touched (and code is masked
 * anyway).
 */
const FILLER_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // polite requests / hedging openers
  [
    /\bwould you mind\b|\bif you could possibly\b|\bif it'?s not too much trouble\b|\bcould you\b|\bcan you please\b/gi,
    "",
  ],
  [
    /\bi (?:would )?like to (?:ask you to|request that|know that)\b|\bif i (?:asked|were to ask) you to\b/gi,
    "",
  ],
  [/\bi wanted to let you know that\b/gi, ""],
  [/\bplease note that\b|\bit is important to note that\b|\bnote that\b/gi, ""],
  // hedges / opinion markers
  [
    /\bi (?:think|believe|feel|guess|reckon|suppose)\b|\bin my (?:opinion|view)\b|\bas far as i'?m concerned\b/gi,
    "",
  ],
  [/\bit (?:seems|appears|looks like|sounds like) that\b/gi, ""],
  [/\bi'?m not sure but\b/gi, ""],
  [/\bin my experience\b|\bneedless to say\b|\btruth be told\b/gi, ""],
  // filler adverbs
  [/\bbasically\b|\bactually\b|\bhonestly\b|\bfrankly\b|\bessentially\b|\bliterally\b/gi, ""],
  [/\bkind of\b|\bsort of\b|\ba bit\b|\ba little bit\b/gi, ""],
  [/\bjust\b/gi, ""],
  // verbose phrases → terse
  [/\bin order to\b/gi, "to"],
  [/\bdue to the fact that\b|\bbecause of the fact that\b|\bas a result of\b/gi, "because"],
  [/\bat this point in time\b|\bat the present time\b/gi, "now"],
  [/\bin the event that\b/gi, "if"],
  [/\ba number of\b/gi, "several"],
  [/\bin spite of\b/gi, "despite"],
  [/\bwith regard to\b|\bin regards to\b|\bwith respect to\b/gi, "about"],
  [/\bwhen it comes to\b|\bin the case of\b/gi, ""],
  [/\bthe fact that\b/gi, ""],
  [/\bat the end of the day\b/gi, ""],
  [
    /\bas you can see\b|\bas we can see\b|\bas previously mentioned\b|\bas mentioned earlier\b/gi,
    "",
  ],
  [/\bhowever\b/gi, "but"],
  [/\bfurthermore\b|\bmoreover\b|\badditionally\b|\bin addition\b/gi, ""],
  [/\bin conclusion\b|\bto summarize\b|\bin summary\b/gi, ""],
  [/\bplease\b/gi, ""],
  // redundant intensifiers
  [/\bvery very\b|\breally really\b/gi, "very"],
  [/\bquite\b|\bdefinitely\b|\bcertainly\b|\babsolutely\b/gi, ""],
];

/** Mask protected spans, run the rules on prose, restore, then gate on savings. */
export function compressCaveman(input: string, opts: CavemanOptions = {}): string {
  const minSaveChars = opts.minSaveChars ?? 24;

  const protectedSpans: string[] = [];
  const masked = input.replace(PROTECTED_RE, (m) => {
    protectedSpans.push(m);
    return `${MASK}${protectedSpans.length - 1}${MASK}`;
  });

  let out = masked;
  for (const [re, sub] of FILLER_RULES) {
    out = out.replace(re, sub);
  }

  // Clean up the debris removal leaves behind: double spaces, space-before-
  // punctuation, empty parentheses, and orphaned connectors.
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  out = out.replace(MASK_RE, (_, i: string) => protectedSpans[Number(i)] ?? "");

  // Validation gate: a rewrite that saves almost nothing is not worth the
  // (lossy) risk — return the input unchanged.
  if (input.length - out.length < minSaveChars) return input;
  return out;
}

/** A CompressFilter adapter so caveman can ride the existing pipeline types. */
export function makeCavemanFilter(opts: CavemanOptions = {}) {
  return {
    name: "caveman",
    lossless: false,
    apply: (input: string) => compressCaveman(input, opts),
  };
}
