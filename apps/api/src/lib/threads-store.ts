// SPDX-License-Identifier: Apache-2.0
/**
 * Per-user deliberation thread store — backs /api/threads* (dashboard
 * "Recent Deliberations", the chat sidebar, and message history).
 *
 * Persistence: shared KV (Redis / Upstash / in-memory fallback via getSharedKV).
 * Cross-pod safe, survives restarts, expires after THREAD_TTL_MS.
 *
 * Storage layout:
 *   thread:list:{userId}          → string[] of thread ids, newest-updated first
 *   thread:item:{userId}:{id}     → serialized Thread
 *   thread:msgs:{userId}:{id}     → serialized ThreadMessage[] (bounded)
 */

import { getSharedKV } from "./shared-kv.js";
import { withKeyLock } from "./with-key-lock.js";

export interface Thread {
  id: string;
  title: string;
  mode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadMessage {
  id: string;
  role: "user" | "opinion" | "verdict" | "system";
  member?: string | null;
  content: string;
  round: number;
  createdAt: string;
}

const THREAD_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const MAX_THREADS = 100;
const MAX_MESSAGES = 500;

const listKey = (userId: string) => `thread:list:${userId}`;
const itemKey = (userId: string, id: string) => `thread:item:${userId}:${id}`;
const msgsKey = (userId: string, id: string) => `thread:msgs:${userId}:${id}`; // Every mutation is a read-modify-write on the KV — serialized per key via the
// shared withKeyLock (see lib/with-key-lock.ts for the race it closes).

/** Same normalization as notifications-store's userIdFor — anonymous callers share a bucket. */
export function userIdFor(uid: string | undefined): string {
  return uid?.trim() ? uid : "anonymous";
}

/** List threads for a user, most-recently-updated first. */
export async function listThreads(userId: string | undefined, limit = 50): Promise<Thread[]> {
  const uid = userIdFor(userId);
  const kv = getSharedKV();
  try {
    // The id list is write-order authoritative (every create/update prepends),
    // so sort by list position — timestamps have ms resolution and two writes
    // in the same millisecond would otherwise tie (and mis-order) the sort.
    const ids = (await kv.get<string[]>(listKey(uid))) ?? [];
    const rank = new Map(ids.map((id, i) => [id, i]));
    const threads = (await Promise.all(ids.map((id) => kv.get<Thread>(itemKey(uid, id))))).filter(
      (t): t is Thread => Boolean(t),
    );
    threads.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    return threads.slice(0, limit);
  } catch {
    return [];
  }
}

/** Fetch a single thread (metadata only — use listMessages for content). */
export async function getThread(
  userId: string | undefined,
  id: string,
): Promise<Thread | undefined> {
  const uid = userIdFor(userId);
  const kv = getSharedKV();
  try {
    return await kv.get<Thread>(itemKey(uid, id));
  } catch {
    return undefined;
  }
}

/**
 * Create (or upsert) a thread. A client-generated id is accepted so the web
 * UI's existing UUIDs survive — re-creating the same id moves it to the front
 * instead of duplicating it.
 */
export async function createThread(
  userId: string | undefined,
  input: { id?: string; title?: string; mode?: string },
): Promise<Thread> {
  const uid = userIdFor(userId);
  const id = input.id ?? crypto.randomUUID();
  return withKeyLock(itemKey(uid, id), async () => {
    const kv = getSharedKV();
    const existing = await kv.get<Thread>(itemKey(uid, id));
    const thread: Thread = {
      id,
      title: (input.title ?? existing?.title ?? "New deliberation").slice(0, 200),
      mode: input.mode ?? existing?.mode,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      const ids = (await kv.get<string[]>(listKey(uid))) ?? [];
      const next = [thread.id, ...ids.filter((x) => x !== thread.id)].slice(0, MAX_THREADS);
      await kv.set(listKey(uid), next, THREAD_TTL_MS);
      await kv.set(itemKey(uid, thread.id), thread, THREAD_TTL_MS);
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "threads-store.create-failed",
          error: (err as Error).message,
        }),
      );
    }
    return thread;
  });
}

/** Update title/mode and bump updatedAt (moves the thread to the front). */
/** Lock-free core — callers must already hold the key lock (or be inside one). */
async function updateThreadUnlocked(
  uid: string,
  id: string,
  patch: { title?: string; mode?: string },
): Promise<Thread | undefined> {
  const kv = getSharedKV();
  try {
    const existing = await kv.get<Thread>(itemKey(uid, id));
    if (!existing) return undefined;
    const thread: Thread = {
      ...existing,
      title: patch.title?.trim() ? patch.title.slice(0, 200) : existing.title,
      mode: patch.mode?.trim() ? patch.mode : existing.mode,
      updatedAt: new Date().toISOString(),
    };
    const ids = (await kv.get<string[]>(listKey(uid))) ?? [];
    const next = [thread.id, ...ids.filter((x) => x !== thread.id)].slice(0, MAX_THREADS);
    await kv.set(listKey(uid), next, THREAD_TTL_MS);
    await kv.set(itemKey(uid, id), thread, THREAD_TTL_MS);
    return thread;
  } catch {
    return undefined;
  }
}

export async function updateThread(
  userId: string | undefined,
  id: string,
  patch: { title?: string; mode?: string },
): Promise<Thread | undefined> {
  const uid = userIdFor(userId);
  return withKeyLock(itemKey(uid, id), () => updateThreadUnlocked(uid, id, patch));
}

/** Delete a thread and its messages. */
export async function deleteThread(userId: string | undefined, id: string): Promise<boolean> {
  const uid = userIdFor(userId);
  return withKeyLock(itemKey(uid, id), async () => {
    const kv = getSharedKV();
    try {
      const existing = await kv.get<Thread>(itemKey(uid, id));
      if (!existing) return false;
      const ids = (await kv.get<string[]>(listKey(uid))) ?? [];
      await kv.set(
        listKey(uid),
        ids.filter((x) => x !== id),
        THREAD_TTL_MS,
      );
      await kv.delete(itemKey(uid, id));
      await kv.delete(msgsKey(uid, id));
      return true;
    } catch {
      return false;
    }
  });
}

/** List a thread's messages in stored (append) order. */
export async function listMessages(
  userId: string | undefined,
  id: string,
): Promise<ThreadMessage[]> {
  const uid = userIdFor(userId);
  const kv = getSharedKV();
  try {
    return (await kv.get<ThreadMessage[]>(msgsKey(uid, id))) ?? [];
  } catch {
    return [];
  }
}

/**
 * Append messages (upsert by id — re-saving a round replaces, never
 * duplicates) and touch the thread's updatedAt.
 */
export async function appendMessages(
  userId: string | undefined,
  id: string,
  messages: ThreadMessage[],
): Promise<number> {
  if (messages.length === 0) return 0;
  const uid = userIdFor(userId);
  return withKeyLock(itemKey(uid, id), async () => {
    const kv = getSharedKV();
    try {
      const existing = await kv.get<ThreadMessage[]>(msgsKey(uid, id));
      const byId = new Map((existing ?? []).map((m) => [m.id, m]));
      for (const m of messages) byId.set(m.id, m);
      const next = Array.from(byId.values()).slice(-MAX_MESSAGES);
      await kv.set(msgsKey(uid, id), next, THREAD_TTL_MS);
      // Bump the thread so it surfaces in "Recent Deliberations" ordering.
      // (Unlocked variant — the append already holds the key lock.)
      await updateThreadUnlocked(uid, id, {});
      return next.length;
    } catch {
      return 0;
    }
  });
}
