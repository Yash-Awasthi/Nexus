// SPDX-License-Identifier: Apache-2.0
/**
 * Baseline prompt-injection guard + model-output sanitizer for apps/api.
 *
 * Two independent, dependency-free primitives:
 *
 *  1. `detectPromptInjection` / `guardPromptInjection` — phrase-level detection
 *     of known prompt-injection / jailbreak patterns on *inbound* user text
 *     ("ignore previous instructions", "reveal your system prompt", DAN, etc.).
 *     Complements `@nexus/redteam`'s whole-word `detectTriggers`, which matches
 *     a keyword list rather than injection phrasing. `makePromptInjectionPreHandler`
 *     turns the guard into a Fastify preHandler that 400s an injection attempt.
 *
 *  2. `sanitizeModelOutput` — defang *outbound* model text before it reaches a
 *     browser/client: strip ANSI + zero-width/bidi control smuggling chars,
 *     redact credential-shaped tokens, and HTML-escape markup so an LLM cannot
 *     emit active content or leak secrets it was tricked into echoing.
 *
 * Detection is heuristic and best-effort — a guard, not a proof. It runs before
 * (never instead of) model-side safety.
 */

export type RiskLevel = "none" | "low" | "medium" | "high";

export interface InjectionMatch {
  /** Stable id of the matched pattern. */
  pattern: string;
  /** The offending substring (truncated) for logging/telemetry — never the whole prompt. */
  snippet: string;
  /** Contribution to the aggregate risk score. */
  weight: number;
}

export interface InjectionAssessment {
  flagged: boolean;
  matches: InjectionMatch[];
  score: number;
  riskLevel: RiskLevel;
}

interface InjectionPattern {
  name: string;
  re: RegExp;
  weight: number;
}

/**
 * Known prompt-injection / jailbreak phrasings. Each is a global-free regex
 * (matched with `.exec` once per call). Weights: 3 = unambiguous override
 * attempt, 2 = strong signal, 1 = weak/contextual.
 */
const INJECTION_PATTERNS: InjectionPattern[] = [
  {
    name: "ignore-previous-instructions",
    re: /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier|preceding|foregoing)\s+(?:instructions?|prompts?|messages?|context|directions?|rules?)/i,
    weight: 3,
  },
  {
    name: "disregard-instructions",
    re: /disregard\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier|system|foregoing)\s+(?:instructions?|prompts?|rules?|guidelines?)/i,
    weight: 3,
  },
  {
    name: "forget-instructions",
    re: /forget\s+(?:everything|all|your|the)\s+(?:previous|prior|above\s+)?(?:instructions?|rules?|training|context)/i,
    weight: 2,
  },
  {
    name: "reveal-system-prompt",
    re: /(?:reveal|show|print|repeat|display|output|leak|tell\s+me)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+|initial\s+|original\s+)?(?:prompt|instructions?|rules?|guidelines?|configuration)/i,
    weight: 3,
  },
  {
    name: "override-directive",
    re: /(?:you\s+are\s+now|from\s+now\s+on,?|new\s+(?:instructions?|rules?|system\s+prompt|persona))\b/i,
    weight: 2,
  },
  {
    name: "role-injection",
    re: /^\s*(?:system|assistant|developer)\s*[:>\]]/im,
    weight: 2,
  },
  {
    name: "jailbreak-marker",
    re: /\b(?:DAN\b|do\s+anything\s+now|developer\s+mode|jailbreak|STAN\b|AIM\b)/i,
    weight: 3,
  },
  {
    name: "bypass-guardrails",
    re: /(?:bypass|disable|turn\s+off|ignore|override|remove)\s+(?:your\s+|all\s+)?(?:safety|guardrails?|filters?|restrictions?|content\s+polic(?:y|ies)|moderation)/i,
    weight: 3,
  },
  {
    name: "pretend-unrestricted",
    re: /(?:pretend|act\s+as\s+if|imagine)\s+(?:you\s+(?:are|were)|to\s+be)\s+(?:an?\s+)?(?:unrestricted|unfiltered|uncensored|amoral|evil|rogue)/i,
    weight: 2,
  },
  {
    name: "prompt-exfiltration",
    re: /(?:repeat|print|echo|output)\s+(?:the\s+)?(?:words?|text|everything)\s+(?:above|before\s+this)\s+(?:starting|verbatim|exactly)?/i,
    weight: 2,
  },
];

const SNIPPET_MAX = 120;

function scoreToRisk(score: number): RiskLevel {
  if (score <= 0) return "none";
  if (score >= 3) return "high";
  if (score >= 2) return "medium";
  return "low";
}

/**
 * Scan `text` for prompt-injection phrasings. `customPatterns` are treated as
 * literal, case-insensitive substrings (weight 3). Never mutates input.
 */
export function detectPromptInjection(
  text: string,
  customPatterns: readonly string[] = [],
): InjectionAssessment {
  const matches: InjectionMatch[] = [];
  if (typeof text === "string" && text.length > 0) {
    for (const p of INJECTION_PATTERNS) {
      const m = p.re.exec(text);
      if (m)
        matches.push({ pattern: p.name, snippet: m[0].slice(0, SNIPPET_MAX), weight: p.weight });
    }
    for (const raw of customPatterns) {
      if (!raw) continue;
      const idx = text.toLowerCase().indexOf(raw.toLowerCase());
      if (idx >= 0) {
        matches.push({
          pattern: `custom:${raw.slice(0, 40)}`,
          snippet: text.slice(idx, idx + SNIPPET_MAX),
          weight: 3,
        });
      }
    }
  }
  const score = matches.reduce((s, m) => s + m.weight, 0);
  return { flagged: matches.length > 0, matches, score, riskLevel: scoreToRisk(score) };
}

/** Ordered risk levels for threshold comparisons. */
const RISK_ORDER: RiskLevel[] = ["none", "low", "medium", "high"];

/** Thrown by `guardPromptInjection`. Carries a 400 statusCode for Fastify. */
export class PromptInjectionError extends Error {
  readonly statusCode = 400;
  readonly assessment: InjectionAssessment;
  constructor(assessment: InjectionAssessment) {
    super("prompt_injection_detected");
    this.name = "PromptInjectionError";
    this.assessment = assessment;
  }
}

export interface GuardOptions {
  /** Minimum risk level that trips the guard. Default: "high". */
  minRisk?: Exclude<RiskLevel, "none">;
  /** Extra literal substrings to treat as injections. */
  customPatterns?: readonly string[];
}

/**
 * Assess `text` and throw {@link PromptInjectionError} when its risk meets or
 * exceeds `minRisk`. Returns the assessment when it passes (for logging).
 */
export function guardPromptInjection(text: string, opts: GuardOptions = {}): InjectionAssessment {
  const minRisk = opts.minRisk ?? "high";
  const assessment = detectPromptInjection(text, opts.customPatterns);
  if (RISK_ORDER.indexOf(assessment.riskLevel) >= RISK_ORDER.indexOf(minRisk)) {
    throw new PromptInjectionError(assessment);
  }
  return assessment;
}

// ── Output sanitization ─────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// Zero-width + bidi-override control chars used to smuggle hidden instructions:
// U+200B–200F (ZWSP/ZWNJ/ZWJ/LRM/RLM), U+202A–202E (bidi embed/override),
// U+2060–2064 (word joiner + invisible ops), U+FEFF (BOM / ZW no-break space).
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

const HTML_ESCAPE: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Credential-shaped tokens redacted from outbound model text. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style
  /\bnxk_[A-Za-z0-9_-]{16,}\b/g, // Nexus API keys
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{20,}\b/g, // Google API key
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi, // Bearer tokens
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
];

export interface SanitizeOptions {
  /** HTML-escape markup so the text can't render active content. Default: true. */
  escapeHtml?: boolean;
  /** Redact credential-shaped tokens. Default: true. */
  redactSecrets?: boolean;
}

/**
 * Defang model output before returning it to a client. Strips ANSI + invisible
 * control chars, redacts credential-shaped tokens, then (optionally) HTML-escapes.
 * Order matters: strip/redact operate on raw chars before escaping rewrites them.
 */
export function sanitizeModelOutput(text: string, opts: SanitizeOptions = {}): string {
  if (typeof text !== "string" || text.length === 0) return "";
  const escapeHtml = opts.escapeHtml ?? true;
  const redactSecrets = opts.redactSecrets ?? true;

  let out = text.replace(ANSI_ESCAPE, "").replace(INVISIBLE_CHARS, "");
  if (redactSecrets) {
    for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  }
  if (escapeHtml) {
    out = out.replace(/[<>&"']/g, (c) => HTML_ESCAPE[c] ?? c);
  }
  return out;
}

// ── Fastify integration ─────────────────────────────────────────────────────

// Structural Fastify request/reply typing kept local so this module has no
// framework import (and stays trivially unit-testable).
interface GuardRequest {
  body?: unknown;
}
interface GuardReply {
  code(status: number): GuardReply;
  send(payload: unknown): unknown;
}

/**
 * Build a Fastify preHandler that extracts text from the request via `extract`
 * and replies 400 when it looks like a prompt-injection attempt. A missing/empty
 * extraction is treated as clean (nothing to guard).
 */
export function makePromptInjectionPreHandler(
  extract: (req: GuardRequest) => string | undefined,
  opts: GuardOptions = {},
) {
  return async (request: GuardRequest, reply: GuardReply): Promise<void> => {
    const text = extract(request);
    if (!text) return;
    const assessment = detectPromptInjection(text, opts.customPatterns);
    const minRisk = opts.minRisk ?? "high";
    if (RISK_ORDER.indexOf(assessment.riskLevel) >= RISK_ORDER.indexOf(minRisk)) {
      reply.code(400).send({
        error: "prompt_injection_detected",
        riskLevel: assessment.riskLevel,
        patterns: assessment.matches.map((m) => m.pattern),
      });
    }
  };
}
