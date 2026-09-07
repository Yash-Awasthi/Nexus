// SPDX-License-Identifier: Apache-2.0
/**
 * Skill task-compression — dynamic composite skills (mission pillar 2:
 * "generate one temporary composite skill containing only the relevant
 * capabilities, optimized for context-token reduction").
 *
 * Given a TASK and N skill records, this deterministically produces ONE
 * composite skill whose code contains only the sections whose capabilities
 * are relevant to the task. Relevance is scored two ways:
 *
 *   • SEMANTIC (preferred) — embeddings of task and skill (local Ollama
 *     nomic-embed-text via lib/skill-embed.ts), hybridized with the keyword
 *     score. Catches "build a landing page" → CSS skills without word overlap.
 *   • KEYWORD (fallback, zero-token) — word-overlap scoring; also the
 *     synchronous entry point for callers that cannot await.
 *
 * Token accounting (chars/4, same heuristic as skill-merge) reports the
 * before/after so the caller can show exactly what the composite saves. Zero
 * LLM tokens in the default path; an optional polish pass can rewrite the
 * composite (same fail-safe as merge).
 */

import { semanticScores } from "./skill-embed.js";
import { splitSkillCodeImports } from "./skill-imports.js";
import {
  commentPrefix,
  estimateTokens,
  pickLanguage,
  polishMergedSkill,
  type PolishDriver,
  type SkillSource,
} from "./skill-merge.js";

/** Words that carry no capability signal — never used for relevance scoring. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "with", "as",
  "by", "is", "are", "was", "were", "be", "been", "it", "its", "this", "that",
  "these", "those", "skill", "skills", "code", "task", "goal", "want", "need",
  "make", "create", "write", "get", "from", "at", "do", "does", "did", "can",
  "could", "would", "should", "will", "you", "your", "we", "our", "i", "me",
  "my", "they", "them", "he", "she", "how", "what", "when", "which", "who",
  "where", "why", "if", "then", "than", "also", "not", "no", "yes", "but",
  "so", "just", "very", "about", "into", "over", "after", "before", "while",
  "use", "using", "used", "run", "running", "output", "result", "results",
  "please", "thanks", "thank", "etc", "e.g", "i.e", "like", "way", "one",
]);

/** Tokenize a string into meaningful capability words (lowercased, ≥3 chars). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Relevance score of a skill against a task: how many task words appear in
 * the skill's name (×2 weight), description, or code head. 0 = no overlap.
 */
export function scoreSkillForTask(skill: SkillSource, taskTokens: string[]): number {
  if (taskTokens.length === 0) return 1; // no task signal → never drop
  const hay = new Set(
    tokenize(
      `${skill.name} ${skill.name} ${skill.description ?? ""} ${(skill.code ?? "").slice(0, 4000)}`,
    ),
  );
  let score = 0;
  for (const t of taskTokens) if (hay.has(t)) score += 1;
  return score;
}

/** Human-readable slug for composite names (e.g. "frontend-landing-grid").
 *  Reuses tokenize so stopwords never pollute composite names. */
export function slugify(text: string, max = 40): string {
  const slug = tokenize(text).slice(0, 6).join("-");
  return (slug || "composite").slice(0, max);
}

export type MatchSource = "semantic" | "keyword";

export interface CompressSection {
  skillId: string;
  name: string;
  score: number;
  kept: boolean;
  /** When kept: token count of this skill's contribution. */
  tokens?: number;
}

export interface CompressReport {
  inputTokens: number;
  outputTokens: number;
  estimatedTokensSaved: number;
  savedRatio: number;
  keptSkills: { id: string; name: string; score: number }[];
  droppedSkills: { id: string; name: string; score: number }[];
  sections: CompressSection[];
  /** How relevance was scored: embeddings (semantic) or word overlap. */
  matchSource: MatchSource;
}

export interface CompositeResult {
  name: string;
  description: string;
  language: string;
  code: string;
  /** Sources whose sections were kept (passed to the optional polish pass). */
  keptSources: SkillSource[];
  report: CompressReport;
}

interface ScoredSkill {
  skill: SkillSource;
  score: number;
}

/**
 * Shared composite builder: keeps `effective` sections, dedupes imports,
 * and reports honest before/after token accounting. `scored` carries every
 * skill's score (for the report); `effective` is the selection policy's pick.
 */
function buildComposite(
  skills: SkillSource[],
  task: string,
  scored: ScoredSkill[],
  effective: ScoredSkill[],
  matchSource: MatchSource,
  opts: { name?: string; description?: string } = {},
): CompositeResult {
  const seenImports = new Set<string>();
  const imports: string[] = [];
  const sections: string[] = [];
  const keptSources: SkillSource[] = [];
  const language = pickLanguage(effective.map((e) => e.skill));
  const prefix = commentPrefix(language);

  for (const { skill } of effective) {
    const code = (skill.code ?? "").trim();
    const body = splitSkillCodeImports(code, imports, seenImports);
    const name = skill.name.trim() || skill.id;
    const desc = skill.description?.trim();
    sections.push(
      [`${prefix} ── ${name}${desc ? ` — ${desc}` : ""} ──`, ...(body.length > 0 ? body : [`${prefix} (no code)`])].join(
        "\n",
      ),
    );
    keptSources.push(skill);
  }

  const head = [
    `${prefix} Composite skill — task-compressed from source skills.`,
    `${prefix} Relevant to: ${task.slice(0, 300)}`,
    `${prefix} Shared imports are deduped below; only capability-relevant sections are kept.`,
    ...(imports.length > 0 ? [...imports, ""] : []),
  ].join("\n");
  const code = [head, sections.join("\n\n")].join("\n\n").trimEnd() + "\n";

  const inputTokens = skills.reduce((acc, s) => acc + estimateTokens(s.code ?? ""), 0);
  const outputTokens = estimateTokens(code);
  const estimatedTokensSaved = Math.max(0, inputTokens - outputTokens);

  const sectionsReport: CompressSection[] = scored.map(({ skill, score }) => ({
    skillId: skill.id,
    name: skill.name,
    score,
    kept: effective.some((e) => e.skill.id === skill.id),
    tokens: estimateTokens(skill.code ?? ""),
  }));

  return {
    name:
      (opts.name ?? "").trim() ||
      `Composite: ${slugify(task)} (${effective.length} skills)`,
    description:
      (opts.description ?? "").trim() ||
      `Task-compressed composite of ${effective.length} skill(s) for: ${task.slice(0, 200)}`,
    language,
    code,
    keptSources,
    report: {
      inputTokens,
      outputTokens,
      estimatedTokensSaved,
      savedRatio: inputTokens === 0 ? 0 : estimatedTokensSaved / inputTokens,
      keptSkills: effective.map(({ skill, score }) => ({
        id: skill.id,
        name: skill.name,
        score,
      })),
      // Drops are only reported when a real slimming happened.
      droppedSkills:
        effective.length === scored.length
          ? []
          : scored
              .filter((x) => !effective.some((e) => e.skill.id === x.skill.id))
              .map(({ skill, score }) => ({ id: skill.id, name: skill.name, score })),
      sections: sectionsReport,
      matchSource,
    },
  };
}

/** Effective selection for the keyword path: score > 0, else keep ALL. */
function keywordSelection(scored: ScoredSkill[]): ScoredSkill[] {
  const kept = scored.filter((x) => x.score > 0);
  return kept.length > 0 ? kept : scored;
}

/** Hybrid semantic score: embeddings dominate, keyword score anchors exact
 *  term hits. Normalized keyword contribution: kw / max(1, maxKw). */
export function hybridScore(cosine: number, keyword: number, maxKeyword: number): number {
  const kwNorm = maxKeyword > 0 ? keyword / maxKeyword : 0;
  return 0.65 * cosine + 0.35 * kwNorm;
}

/** Skills whose hybrid score clears the bar; else the top 2 (never empty). */
const SEMANTIC_KEEP_THRESHOLD = 0.35;

export function semanticSelection(scored: ScoredSkill[]): ScoredSkill[] {
  const kept = scored.filter((x) => x.score >= SEMANTIC_KEEP_THRESHOLD);
  if (kept.length > 0) return kept;
  return [...scored].sort((a, b) => b.score - a.score).slice(0, 2);
}

/**
 * Deterministic task compression (keyword scoring, zero tokens, offline):
 * keeps only the skills whose words overlap the task, dedupes shared imports,
 * returns ONE composite skill plus an honest token report. Never produces an
 * empty composite: if nothing scores, all skills are kept.
 */
export function compressSkillsForTask(
  skills: SkillSource[],
  task: string,
  opts: { name?: string; description?: string } = {},
): CompositeResult {
  const taskTokens = tokenize(task);
  const scored = skills.map((s) => ({ skill: s, score: scoreSkillForTask(s, taskTokens) }));
  return buildComposite(skills, task, scored, keywordSelection(scored), "keyword", opts);
}

/**
 * Task compression with SEMANTIC relevance: embeds task + skills via the local
 * Ollama embed model (3 s bound, never throws) and keeps the skills whose
 * hybrid score clears the bar. Falls back to the keyword path when the embed
 * daemon is unreachable — the report's `matchSource` says which one ran.
 */
export async function compressSkillsForTaskSemantic(
  skills: SkillSource[],
  task: string,
  opts: {
    name?: string;
    description?: string;
    embedBaseUrl?: string;
    /** Injection seam for tests — defaults to the real fetch. */
    embedFetch?: typeof fetch;
  } = {},
): Promise<CompositeResult> {
  const taskTokens = tokenize(task);
  const keyword = new Map(skills.map((s) => [s.id, scoreSkillForTask(s, taskTokens)]));

  let scored: ScoredSkill[];
  let matchSource: MatchSource;
  const cosines = await semanticScores(skills, task, {
    baseUrl: opts.embedBaseUrl,
    fetchFn: opts.embedFetch,
  });
  if (cosines) {
    // nomic-embed compresses short-text similarities into a tight band, so raw
    // cosines barely separate relevant from irrelevant — but min-max normalizing
    // WITHIN the batch zeroes the weakest skill even when it has real keyword
    // hits (live case: CSV/JSON task dropped JSON Writer at 0.175). Each skill
    // scores as the MAX of two views:
    //   • raw    — absolute hybrid (keyword hits anchor it ≥ 0.35, so exact
    //              term matches never drop);
    //   • relative — min-max normalized cosine with a floor that depends on
    //              keyword presence: skills WITH hits get a higher floor (they
    //              are anchored and must survive a min position), skills with
    //              none get a lower floor (the noise tail must still drop).
    const raw = skills.map((s) => cosines.get(s.id) ?? 0);
    const maxCos = Math.max(...raw);
    const minCos = Math.min(...raw);
    const span = maxCos - minCos;
    const maxKeyword = Math.max(1, ...keyword.values());
    scored = skills.map((s, i) => {
      const c = raw[i] ?? 0;
      const kw = keyword.get(s.id) ?? 0;
      if (span >= 1e-6) {
        const floor = kw > 0 ? 0.27 : 0.15;
        const rel = floor + 0.73 * ((c - minCos) / span);
        return {
          skill: s,
          score: Math.max(hybridScore(c, kw, maxKeyword), hybridScore(rel, kw, maxKeyword)),
        };
      }
      return { skill: s, score: hybridScore(c, kw, maxKeyword) };
    });
    scored.sort((a, b) => b.score - a.score); // deterministic order for the report
    matchSource = "semantic";
  } else {
    scored = skills.map((s) => ({ skill: s, score: keyword.get(s.id) ?? 0 }));
    matchSource = "keyword";
  }

  const effective =
    matchSource === "semantic"
      ? semanticSelection(scored)
      : keywordSelection(scored);
  return buildComposite(skills, task, scored, effective, matchSource, opts);
}

/** One optional LLM polish pass over the composite's kept sources (fail-safe). */
export function polishComposite(
  keptSources: SkillSource[],
  driver: PolishDriver,
  opts: { model: string; timeoutMs?: number },
) {
  return polishMergedSkill(keptSources, driver, opts);
}