// SPDX-License-Identifier: Apache-2.0
/**
 * Offline queue: a prompt typed while the API cannot be reached is kept, not lost.
 *
 * The desktop app runs its own API on loopback, so "offline" is rarely the internet: it is the
 * API restarting, the machine waking, or a request that timed out mid-flight. Losing the text in
 * that window is the failure worth avoiding, so the queue lives in a file next to the data
 * directory and survives a restart of both processes.
 *
 * Three decisions are worth stating, because each one is a place to get it wrong:
 *
 * - **A permanent refusal is dropped, a transient one is kept.** Retrying a prompt the server
 *   rejected with a 4xx forever is a queue that never drains and a user who never learns why.
 * - **The queue is bounded and expires.** Fifty prompts or seven days is enough to ride out an
 *   outage; an unbounded queue on a disk is a way to fill a disk.
 * - **The indicator names the count.** "Offline" with no number hides the thing the user needs
 *   to know, which is whether their work is still there.
 */
import fs from "node:fs";
import path from "node:path";

export const QUEUE_FILE = "offline-queue.json";
export const MAX_QUEUED = 50;
export const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** The longest prompt kept; longer text is refused rather than truncated. */
export const MAX_PROMPT_CHARS = 20_000;

export interface QueuedPrompt {
  id: string;
  sessionId: string | null;
  text: string;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

/** What a send attempt reported. `permanent` means retrying cannot help. */
export interface SendResult {
  ok: boolean;
  permanent?: boolean;
  error?: string;
}

export interface FlushResult {
  queue: QueuedPrompt[];
  sent: QueuedPrompt[];
  dropped: { prompt: QueuedPrompt; reason: string }[];
}

function isQueued(value: unknown): value is QueuedPrompt {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<QueuedPrompt>;
  return (
    typeof v.id === "string" &&
    typeof v.text === "string" &&
    typeof v.createdAt === "string" &&
    !Number.isNaN(new Date(v.createdAt).getTime())
  );
}

/** Drop expired and malformed entries, keeping order and the cap. */
export function prune(queue: readonly QueuedPrompt[], now = Date.now()): QueuedPrompt[] {
  return queue
    .filter(isQueued)
    .filter((prompt) => {
      const age = now - new Date(prompt.createdAt).getTime();
      // A clock that moved backwards must not resurrect an ancient prompt, and a future
      // timestamp (a wrong clock) must not keep one alive either.
      return age >= -60_000 && age <= MAX_AGE_MS;
    })
    .slice(-MAX_QUEUED);
}

/** Read the queue, treating an unreadable file as empty rather than as an error. */
export function loadQueue(dir: string, now = Date.now()): QueuedPrompt[] {
  try {
    const raw = fs.readFileSync(path.join(dir, QUEUE_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? prune(parsed as QueuedPrompt[], now) : [];
  } catch {
    return [];
  }
}

/** Write the queue. Throws only when the directory itself cannot be written. */
export function saveQueue(dir: string, queue: readonly QueuedPrompt[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, QUEUE_FILE);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(queue, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // Rename, so a crash mid-write leaves the previous queue intact instead of a truncated file.
  fs.renameSync(tmp, target);
}

export interface EnqueueInput {
  text: string;
  sessionId?: string | null;
  id?: string;
  now?: number;
}

/**
 * Add a prompt. Returns the new queue and, when the queue was full, the prompt that had to give
 * way — surfacing it lets the caller tell the user instead of silently discarding work.
 */
export function enqueue(
  queue: readonly QueuedPrompt[],
  input: EnqueueInput,
): { queue: QueuedPrompt[]; dropped?: QueuedPrompt } {
  const text = input.text.trim();
  if (!text) throw new Error("Nothing to queue: the prompt is empty.");
  if (text.length > MAX_PROMPT_CHARS)
    throw new Error(
      `Nothing to queue: the prompt is ${text.length} characters, over the ${MAX_PROMPT_CHARS} limit.`,
    );

  const now = input.now ?? Date.now();
  const entry: QueuedPrompt = {
    id: input.id ?? `q_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: input.sessionId ?? null,
    text,
    createdAt: new Date(now).toISOString(),
    attempts: 0,
  };
  const next = [...prune(queue, now), entry];
  if (next.length <= MAX_QUEUED) return { queue: next };
  const dropped = next.shift()!;
  return { queue: next, dropped };
}

/**
 * Try every queued prompt in order.
 *
 * Order matters: a conversation is a sequence, so a later prompt that arrives before an earlier
 * one would be answering the wrong question. A transient failure stops the walk — if the first
 * prompt cannot be sent, the third certainly cannot.
 */
export async function flush(
  queue: readonly QueuedPrompt[],
  send: (prompt: QueuedPrompt) => Promise<SendResult>,
  now = Date.now(),
): Promise<FlushResult> {
  const remaining: QueuedPrompt[] = [];
  const sent: QueuedPrompt[] = [];
  const dropped: FlushResult["dropped"] = [];

  for (const prompt of prune(queue, now)) {
    let result: SendResult;
    try {
      result = await send(prompt);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (result.ok) {
      sent.push(prompt);
      continue;
    }
    if (result.permanent) {
      dropped.push({ prompt, reason: result.error ?? "the server refused it" });
      continue;
    }
    remaining.push({
      ...prompt,
      attempts: prompt.attempts + 1,
      ...(result.error ? { lastError: result.error } : {}),
    });
    // Keep the rest untouched: they are behind this one and their turn has not come.
    const index = prune(queue, now).indexOf(prompt);
    remaining.push(...prune(queue, now).slice(index + 1));
    break;
  }

  return { queue: remaining, sent, dropped };
}

export interface IndicatorState {
  online: boolean;
  queued: number;
  flushing?: boolean;
}

/** The one-line state a tray tooltip or a chip shows. */
export function indicator(state: IndicatorState): { label: string; tone: "ok" | "warn" } {
  const queued = Math.max(0, Math.trunc(state.queued));
  const noun = queued === 1 ? "prompt" : "prompts";
  if (!state.online)
    return {
      label: queued === 0 ? "Offline" : `Offline — ${queued} ${noun} queued`,
      tone: "warn",
    };
  if (queued === 0) return { label: "Online", tone: "ok" };
  if (state.flushing) return { label: `Sending ${queued} queued ${noun}…`, tone: "warn" };
  return { label: `${queued} ${noun} queued — sending on reconnect`, tone: "warn" };
}
