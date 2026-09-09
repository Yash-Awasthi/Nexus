// SPDX-License-Identifier: Apache-2.0
import type { LlmRole } from "@nexus/llm-drivers";

import { splitSkillCodeImports } from "./skill-imports.js";

/**
 * Skill compression — deterministic structural merge.
 *
 * Merges N skill definitions into one: shared import lines are deduped once,
 * per-skill bodies become sections under a header comment, and the result is
 * returned alongside an honest token estimate (chars/4, the common ~4 chars
 * per token rule of thumb). No LLM call is required for the merge itself; an
 * optional polish pass (LLM) may rewrite the merged body, and its failure
 * falls back to the deterministic result — a merge can never fail outright.
 */

export interface SkillSource {
  id: string;
  name: string;
  description?: string;
  language?: string;
  code: string;
}

/** Rough token estimate — chars / 4 (typical for English + code). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.trim().length / 4);
}

/** Pick the merged skill's language: unanimous → that; else most common; else Python. */
export function pickLanguage(skills: SkillSource[]): string {
  const counts = new Map<string, number>();
  for (const s of skills) {
    const lang = (s.language ?? "").toLowerCase();
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  if (counts.size === 0) return "Python";
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Python";
  const map: Record<string, string> = {
    python: "Python",
    typescript: "TypeScript",
    javascript: "JavaScript",
  };
  return map[top] ?? "Python";
}

/** Comment prefix for a skill's declared language — C-style for JS/TS,
 *  `#` for Python/shell (where `//` is a SyntaxError). */
export function commentPrefix(language: string | undefined): string {
  const lang = (language ?? "").toLowerCase();
  return lang === "typescript" || lang === "javascript" || lang === "js" || lang === "ts"
    ? "//"
    : "#";
}

/** Deterministic merge — dedupes shared imports, sections per source skill. */
export function mergeSkillCodes(skills: SkillSource[]): string {
  if (skills.length === 0) return "# No skills provided";
  if (skills.length === 1) return skills[0]?.code ?? "";
  const prefix = commentPrefix(pickLanguage(skills));

  const seenImports = new Set<string>();
  const imports: string[] = [];
  const sections: string[] = [];

  for (const skill of skills) {
    const code = (skill.code ?? "").trim();
    const body = splitSkillCodeImports(code, imports, seenImports);
    const name = skill.name.trim() || skill.id;
    const desc = skill.description?.trim();
    const header = `${prefix} ── ${name}${desc ? ` — ${desc}` : ""} ──`;
    sections.push([header, ...(body.length > 0 ? body : [`${prefix} (no code)`])].join("\n"));
  }

  const head = [
    `${prefix} Merged skill — combined from multiple source skills.`,
    `${prefix} Shared imports are deduped below; each source skill is preserved as a section.`,
    ...(imports.length > 0 ? [...imports, ""] : []),
  ].join("\n");

  return [head, sections.join("\n\n")].join("\n\n").trimEnd() + "\n";
}

/** Human-readable compression report. */
export function mergeReport(skills: SkillSource[], mergedCode: string) {
  const inputTokens = skills.reduce((acc, s) => acc + estimateTokens(s.code ?? ""), 0);
  const outputTokens = estimateTokens(mergedCode);
  return {
    inputTokens,
    outputTokens,
    estimatedTokensSaved: Math.max(0, inputTokens - outputTokens),
    sources: skills.map((s) => ({ id: s.id, name: s.name, tokens: estimateTokens(s.code ?? "") })),
  };
}

// ── LLM polish pass ──────────────────────────────────────────────────────────

/** Narrow driver surface the polish pass needs (structurally compatible with
 *  the failover driver getDefaultDriver() returns — servedBy is read when the
 *  failover layer records it). LlmRole matches the driver's message shape so
 *  FailoverDriver is assignable without casts. */
export interface PolishDriver {
  complete(opts: {
    model: string;
    messages: { role: LlmRole; content: string }[];
    maxTokens: number;
  }): Promise<{
    content: string;
    usage?: { inputTokens?: number; outputTokens?: number };
    servedBy?: string;
  }>;
}

export interface PolishResult {
  /** Polished code (fences stripped) when the LLM pass succeeded, else "". */
  code: string;
  polished: boolean;
  polishTokens: { inputTokens: number; outputTokens: number };
  servedBy?: string;
  /** Set when the LLM pass failed — the caller keeps the deterministic merge. */
  error?: string;
}

/** Reject `p` if it hasn't settled within `ms` — bounds the polish LLM call. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

const POLISH_SYSTEM_PROMPT =
  "You are a code-merging assistant. Merge the provided skill definitions into ONE " +
  "cohesive skill in a single language. Deduplicate imports and shared helpers, " +
  "rename collisions, keep each capability as a clearly-named function, and add a " +
  "short module docstring. Output ONLY the code — no prose, no markdown fences.";

/**
 * One LLM polish attempt over the source skills. Never throws: a provider
 * error, timeout (opts.timeoutMs, default 60 s), or empty/uncode-like result
 * degrades to `polished: false` + an honest `error` — the caller keeps the
 * deterministic merge. Token accounting prefers the driver's real usage and
 * falls back to chars/4 estimates; the same numbers must be reported and
 * cost-tracked.
 */
export async function polishMergedSkill(
  sources: SkillSource[],
  driver: PolishDriver,
  opts: { model: string; timeoutMs?: number },
): Promise<PolishResult> {
  const input = JSON.stringify(
    sources.map((s) => ({
      name: s.name,
      description: s.description,
      language: s.language,
      code: s.code,
    })),
    null,
    2,
  );
  try {
    const res = await withTimeout(
      driver.complete({
        model: opts.model,
        messages: [
          { role: "system", content: POLISH_SYSTEM_PROMPT },
          { role: "user", content: input },
        ],
        maxTokens: 4096,
      }),
      opts.timeoutMs ?? 60_000,
      "skill-merge polish",
    );
    // Models wrap code in fences despite the prompt — when a fenced block
    // exists, take ONLY it (prose before/after is dropped); otherwise strip
    // any stray fence markers and keep the body.
    const fenced = /```(?:[\w-]*)?\n?([\s\S]*?)```/.exec(res.content);
    const cleaned = fenced
      ? fenced[1]!.trim()
      : res.content.replace(/```(?:[\w-]*)?\n?/g, "").trim();
    if (cleaned.length === 0) {
      return {
        code: "",
        polished: false,
        polishTokens: { inputTokens: 0, outputTokens: 0 },
        servedBy: res.servedBy,
        error: "LLM returned an empty polish result",
      };
    }
    return {
      code: cleaned,
      polished: true,
      polishTokens: {
        inputTokens: res.usage?.inputTokens ?? estimateTokens(input),
        outputTokens: res.usage?.outputTokens ?? estimateTokens(cleaned),
      },
      servedBy: res.servedBy,
    };
  } catch (err) {
    return {
      code: "",
      polished: false,
      polishTokens: { inputTokens: 0, outputTokens: 0 },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
