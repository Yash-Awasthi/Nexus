// SPDX-License-Identifier: Apache-2.0
/**
 * Pattern checks behind the Privacy & Safety and Content Filter settings:
 * personal details and keys in a message, and profanity in messages and answers.
 */

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

// Order matters: the narrower shapes run first so a card or SSN is not
// reported (and redacted) as a phone number.
const SECRET = new RegExp(
  [
    "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----",
    // The shape is loose here on purpose: a slug is excluded by the check below, not by the pattern,
    // because a digit somewhere in the body (a year, a version) is not what separates a key from a
    // package name — the length of the final run is.
    "\\b(?:sk|gsk|nxk|pk|rk)[-_][\\w-]{20,}",
    "\\bgh[pousr]_\\w{36,}",
    "\\bgithub_pat_\\w{40,}",
    "\\bAKIA[0-9A-Z]{16}\\b",
    "\\bxox[baprs]-[\\w-]{10,}",
    "\\bAIza[\\w-]{35}",
    "\\beyJ[\\w-]{10,}\\.[\\w-]{10,}\\.[\\w-]{10,}",
  ].join("|"),
  "g",
);

/**
 * Is this candidate a credential, or a hyphenated name that merely starts with a key prefix?
 *
 * A key ends in one long run — a project key is `sk-proj-` followed by a long random body, and the other
 * families are the same shape after their prefix. A package name ends in a word: `sk-learn-preprocessing-
 * pipeline-helpers`, or `sk-learn-pipelines-2024`. So the final segment must be at least twenty characters,
 * there are at most four segments, and the body must contain a digit. Requiring an uppercase letter instead
 * would have been simpler and would have stopped matching lowercase personal access tokens.
 */
function looksLikeKey(match: string): boolean {
  // The other alternatives in the same pattern (a PEM block, a GitHub token) are not this shape at all.
  if (!/^(?:sk|gsk|nxk|pk|rk)[-_]/.test(match)) return true;
  const body = match.replace(/^(?:sk|gsk|nxk|pk|rk)[-_]/, "");
  const segments = body.split(/[-_]/);
  return segments.length <= 4 && (segments.at(-1) ?? "").length >= 20 && /\d/.test(body);
}

const PII: { type: string; re: RegExp; check?: (m: string) => boolean }[] = [
  { type: "secret", re: SECRET, check: looksLikeKey },
  { type: "email", re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  {
    type: "card number",
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    check: (m) => luhn(m.replace(/\D/g, "")),
  },
  { type: "SSN", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    type: "phone",
    re: /(?<![\w+])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}\b/g,
  },
];

export function findPii(text: string): { type: string; value: string }[] {
  const found: { type: string; value: string }[] = [];
  let rest = text;
  for (const p of PII) {
    rest = rest.replace(p.re, (m) => {
      if (p.check && !p.check(m)) return m;
      found.push({ type: p.type, value: m });
      return " ".repeat(m.length);
    });
  }
  return found;
}

export function redactPii(text: string): string {
  let out = text;
  for (const p of PII) {
    out = out.replace(p.re, (m) =>
      p.check && !p.check(m) ? m : `[${p.type.toUpperCase().replace(" ", "_")}]`,
    );
  }
  return out;
}

const PROFANITY =
  /\b(?:motherfuck\w*|fuck\w*|shit\w*|bullshit|bitch\w*|cunt\w*|asshole\w*|bastard\w*|dickhead\w*|wank\w*|twat\w*)\b/gi;

/** Keeps the first letter so the sentence still reads. */
export function maskProfanity(text: string): string {
  return text.replace(PROFANITY, (w) => w[0] + "*".repeat(w.length - 1));
}
