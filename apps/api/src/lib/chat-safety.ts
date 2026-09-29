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
    // A digit in the body keeps hyphenated slugs such as "sk-learn-..." out.
    "\\b(?:sk|gsk|nxk|pk|rk)[-_](?=[\\w-]*\\d)[\\w-]{20,}",
    "\\bgh[pousr]_\\w{36,}",
    "\\bgithub_pat_\\w{40,}",
    "\\bAKIA[0-9A-Z]{16}\\b",
    "\\bxox[baprs]-[\\w-]{10,}",
    "\\bAIza[\\w-]{35}",
    "\\beyJ[\\w-]{10,}\\.[\\w-]{10,}\\.[\\w-]{10,}",
  ].join("|"),
  "g",
);

const PII: { type: string; re: RegExp; check?: (m: string) => boolean }[] = [
  { type: "secret", re: SECRET },
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
