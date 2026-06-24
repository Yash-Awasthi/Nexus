// SPDX-License-Identifier: Apache-2.0
/**
 * agent-review — forked post-run learning loop.
 *
 * After a coding-agent run, a non-blocking review reads the transcript and asks
 * the model (no tools) for durable learnings worth carrying into future runs —
 * reusable patterns, gotchas, and facts. The result is streamed as an
 * `agent.learnings` event and logged.
 *
 * This is the capture half of the loop; persisting learnings into the
 * @nexus/memory vector store (so they're retrieved on later runs) is the
 * documented follow-up. The review never blocks or fails the main run.
 */
import type { LlmToolFn, RuntimeMessage } from "@nexus/agent-runtime";

export type LearningType = "memory" | "skill" | "pattern" | "gotcha";

export interface Learning {
  type: LearningType;
  content: string;
}

const LEARNING_TYPES: ReadonlySet<string> = new Set<LearningType>([
  "memory",
  "skill",
  "pattern",
  "gotcha",
]);

export const REVIEW_SYSTEM_PROMPT =
  "You are reviewing a COMPLETED coding-agent session transcript. Extract only " +
  "DURABLE learnings worth remembering for future runs in this codebase: reusable " +
  "patterns, non-obvious gotchas, conventions, or facts. Ignore one-off details and " +
  "anything already obvious from the code. Output ONLY a JSON array of objects " +
  '{"type","content"} where type is one of memory|skill|pattern|gotcha and content ' +
  "is a single concise sentence. Output [] if there is nothing durable. No prose, no " +
  "code fences.";

/** Flatten a transcript into the review model's input (bounded). */
export function buildReviewInput(messages: RuntimeMessage[], maxChars = 60_000): string {
  return messages
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n")
    .slice(0, maxChars);
}

/** Extract the learnings JSON array from the model's reply; [] if unparseable. */
export function parseLearnings(text: string): Learning[] {
  const match = /\[[\s\S]*\]/.exec(text);
  if (!match) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: Learning[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.content !== "string" || !rec.content.trim()) continue;
    const type = (
      typeof rec.type === "string" && LEARNING_TYPES.has(rec.type) ? rec.type : "memory"
    ) as LearningType;
    out.push({ type, content: rec.content.trim() });
  }
  return out;
}

/** Run the review: one tool-less model turn over the transcript → learnings. */
export async function reviewSession(
  messages: RuntimeMessage[],
  llm: LlmToolFn,
): Promise<Learning[]> {
  if (!messages.length) return [];
  const turn = await llm([{ role: "user", content: buildReviewInput(messages) }], {
    systemPrompt: REVIEW_SYSTEM_PROMPT,
  });
  return parseLearnings(turn.content);
}
