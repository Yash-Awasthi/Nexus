// SPDX-License-Identifier: Apache-2.0
/**
 * skill-embed — semantic skill selection (mission pillar 2 depth: "only the
 * relevant capabilities" needs meaning, not keyword overlap).
 *
 * A task like "build a landing page" never mentions "CSS", so word-overlap
 * scoring cannot select the right skills. This module embeds the task and
 * each skill (name + description + code head) with the LOCAL Ollama embed
 * model (nomic-embed-text by default — the mission's "reasoning-free model"
 * class) and scores skills by cosine similarity.
 *
 * Safety contract: embedding is a cheap local HTTP probe, bounded (3 s), and
 * NEVER throws — callers get `null` when the daemon is down and fall back to
 * the deterministic keyword scorer. Zero LLM tokens: embed models are
 * encoder-only, not generation.
 */

export interface EmbedOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 3_000;

/** Embed a batch of texts with the local Ollama embed model. null = unavailable. */
export async function embedTexts(
  texts: string[],
  opts: EmbedOptions = {},
): Promise<number[][] | null> {
  const baseUrl = opts.baseUrl ?? process.env.OLLAMA_BASE_URL;
  if (!baseUrl) return null;
  const model = opts.model ?? process.env.NEXUS_EMBED_MODEL ?? "nomic-embed-text";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const res = await (opts.fetchFn ?? fetch)(`${baseUrl.replace(/\/+$/, "")}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { embeddings?: number[][] };
    const embeddings = data.embeddings;
    return embeddings && embeddings.length === texts.length ? embeddings : null;
  } catch {
    return null; // daemon down or timed out — semantic selection degrades gracefully
  }
}

/** Cosine similarity of two equal-length vectors (0 on mismatch). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined || bi === undefined) continue;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface EmbedSkill {
  id: string;
  name: string;
  description?: string;
  code?: string;
}

/** Embed text used for a skill (name + description + first 800 code chars). */
export function skillEmbedText(s: EmbedSkill): string {
  return [s.name, s.description ?? "", (s.code ?? "").slice(0, 800)].filter(Boolean).join("\n");
}

/**
 * Cosine similarity of each skill to the task. null when the embed daemon is
 * unreachable (caller falls back to keyword scoring).
 */
export async function semanticScores(
  skills: EmbedSkill[],
  task: string,
  opts: EmbedOptions = {},
): Promise<Map<string, number> | null> {
  if (skills.length === 0 || !task.trim()) return null;
  const vectors = await embedTexts([task.trim(), ...skills.map(skillEmbedText)], opts);
  if (!vectors) return null;
  const taskVec = vectors[0];
  if (!taskVec) return null;
  const out = new Map<string, number>();
  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i];
    const skillVec = vectors[i + 1];
    if (!skill || !skillVec) continue;
    out.set(skill.id, cosineSimilarity(taskVec, skillVec));
  }
  return out;
}
