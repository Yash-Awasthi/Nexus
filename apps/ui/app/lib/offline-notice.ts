// SPDX-License-Identifier: Apache-2.0
/**
 * The offline chip: a prompt that could not be sent, and where it went.
 *
 * The host owns the queue — it has a file, a clock and a flush timer — so this module is only the
 * renderer half: decide whether a failure *was* a connection failure, hand the text over, and say
 * what happened in words a person can act on. A failed send that is not a connection failure (a
 * 401, a validation error) must not be queued: it would sit in the queue being wrong.
 */
import { hostCan, hostInvoke } from "./host";

export interface OfflineState {
  online: boolean;
  queued: number;
}

/** Whether the host can queue at all (the desktop app can; a browser tab cannot). */
export function canQueueOffline(): boolean {
  return hostCan("offlineQueue");
}

/**
 * A failure that retrying could fix, judged from the message.
 *
 * The fetch layer in this app reduces a dead socket to "Failed to fetch" or a timeout; a server
 * that answered says something else, and its answer is not going to change by waiting.
 */
export function isNetworkFailure(message: string): boolean {
  const text = message.toLowerCase();
  return [
    "failed to fetch",
    "fetch failed",
    "network error",
    "networkerror",
    "offline",
    "connection lost",
    "econnrefused",
    "econnreset",
    "etimedout",
    "timeout",
    "timed out",
    "load failed",
    "socket hang up",
  ].some((needle) => text.includes(needle));
}

/**
 * Hand a prompt to the host's queue.
 *
 * Returns the new queue length, or `null` when there is no host to queue with — the caller then
 * keeps its own error message rather than claiming the work was saved.
 */
export async function queueOffline(
  text: string,
  sessionId: string | null,
): Promise<number | null> {
  if (!canQueueOffline() || !text.trim()) return null;
  try {
    return await hostInvoke<number>("offlineQueue", "queuePrompt", { text, sessionId });
  } catch {
    return null;
  }
}

/** The queue and the connection state, or null in a browser tab. */
export async function readOfflineState(): Promise<OfflineState | null> {
  if (!canQueueOffline()) return null;
  try {
    const state = await hostInvoke<OfflineState>("offlineQueue", "getOfflineState");
    return {
      online: state?.online !== false,
      queued: Math.max(0, Math.trunc(Number(state?.queued ?? 0))),
    };
  } catch {
    return null;
  }
}

/** Ask the host to send what it holds. Safe to call when nothing is queued. */
export async function flushOffline(): Promise<void> {
  if (!canQueueOffline()) return;
  try {
    await hostInvoke("offlineQueue", "flushOfflineQueue");
  } catch {
    /* the tray and the poll will try again; a chip is not the place to report this */
  }
}

/** What the chip says, in the two cases that matter. */
export function offlineNotice(queued: number): string {
  if (queued <= 0) return "";
  return queued === 1
    ? "1 prompt saved — it will send when the connection returns"
    : `${queued} prompts saved — they will send when the connection returns`;
}

/** The sentence shown in place of the failed reply. */
export function queuedInsteadOfFailed(queued: number): string {
  return `${offlineNotice(queued)} You can keep writing; the queue sends in order.`;
}
