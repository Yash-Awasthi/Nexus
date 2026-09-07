// SPDX-License-Identifier: Apache-2.0
/**
 * §15.8 — cheap local memory extraction (Roadmap 15.8).
 *
 * The deterministic distillation in lib/mission-memory.ts stays the source of
 * truth: every fact there comes from the captured record/graph. This module
 * adds an OPTIONAL second pass — a small local model (default `llama3.2:1b`,
 * the roadmap's "reasoning-free" extractor) turns the distilled block into ≤3
 * carry-forward insights, stored on the terminal record and injected into the
 * next run's memory block alongside the deterministic facts.
 *
 * Contract: bounded (timeout), never throws, degrades to null — when the model
 * is unavailable, slow, or produces garbage, the deterministic memory stands
 * alone. Kill switch: NEXUS_MEMORY_EXTRACTOR=0. Model: NEXUS_MEMORY_EXTRACT_MODEL.
 */

const DEFAULT_MODEL = "llama3.2:1b";
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_INSIGHTS_CHARS = 600;
const MAX_OUTPUT_EXCERPT = 1_200;

export interface MissionInsights {
  /** Sanitized ≤3-line insight text (no fences, no preamble). */
  text: string;
  /** Which local model produced it (provenance). */
  model: string;
}

export interface ExtractorDeps {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

function buildPrompt(record: {
  goal: string;
  outcome: string;
  finalContent: string;
}): string {
  return [
    "You distill completed agent runs into short carry-forward notes.",
    `Run goal: ${record.goal.slice(0, 300)}`,
    `Outcome: ${record.outcome.slice(0, 200)}`,
    `Final output (excerpt): ${(record.finalContent || "(empty)").slice(0, MAX_OUTPUT_EXCERPT)}`,
    "",
    "Write AT MOST 3 short bullet lines (max 20 words each) of concrete, reusable",
    "insights for the NEXT run of the same goal: what worked, what failed, what to",
    "do differently. Plain lines starting with '- '. No preamble, no fences, no",
    "markdown headers, nothing else.",
  ].join("\n");
}

/** Sanitize model output: strip reasoning/fences, keep ≤3 bullet lines. */
export function sanitizeInsights(raw: string): string | null {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .split("\n")
    .filter((l) => !/^\s*```/.test(l)) // drop fence markers, keep the content
    .map((l) => l.trim())
    .filter((l) => /^[-*\d]/.test(l) && l.length > 8) // bullets only, non-trivial
    .map((l) => l.replace(/^[-*]\s*/, "- ").replace(/^\d+[.)]\s*/, "- ").slice(0, 200))
    .slice(0, 3);
  const text = cleaned.join("\n").slice(0, MAX_INSIGHTS_CHARS).trim();
  return text.length > 0 ? text : null;
}

/**
 * One bounded local-model pass. Returns null on any failure — the caller
 * keeps the deterministic memory untouched.
 */
export async function extractMissionInsights(
  record: { goal: string; outcome: string; finalContent: string },
  deps: ExtractorDeps = {},
): Promise<MissionInsights | null> {
  if (process.env.NEXUS_MEMORY_EXTRACTOR === "0") return null;
  const baseUrl = (deps.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(
    /\/$/,
    "",
  );
  const model = deps.model ?? process.env.NEXUS_MEMORY_EXTRACT_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = deps.timeoutMs ?? Number(process.env.NEXUS_MEMORY_EXTRACT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = (await Promise.race([
      doFetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          options: { num_predict: 160, temperature: 0 },
          messages: [{ role: "user", content: buildPrompt(record) }],
        }),
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ])) as Response | null;
    if (!res || !res.ok) return null;
    const body = (await res.json()) as { message?: { content?: string } };
    const text = sanitizeInsights(body.message?.content ?? "");
    return text ? { text, model } : null;
  } catch {
    return null;
  }
}
