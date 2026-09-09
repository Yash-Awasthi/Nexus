// SPDX-License-Identifier: Apache-2.0
/**
 * Per-user notification store — backs the /api/notifications* surface used by
 * the sidebar NotificationBell and the dashboard activity feed.
 *
 * Persistence: shared KV (Redis / Upstash / in-memory fallback via getSharedKV).
 * Cross-pod safe, survives restarts, auto-expires after NOTIF_TTL_MS.
 *
 * Storage layout:
 *   notif:list:{userId}            → string[] of notification ids, newest first
 *   notif:item:{userId}:{id}       → serialized Notification
 */

import { globalBus } from "@nexus/sse";

import { getSharedKV } from "./shared-kv.js";

export interface AppNotification {
  id: string;
  type: string; // "research" | "connector" | "system" | "autopilot" | ...
  title: string;
  message?: string;
  link?: string; // dashboard-relative route the bell/dropdown can navigate to
  isRead: boolean;
  createdAt: string;
}

const NOTIF_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const listKey = (userId: string) => `notif:list:${userId}`;
const itemKey = (userId: string, id: string) => `notif:item:${userId}:${id}`;

export function userIdFor(uid: string | undefined): string {
  return uid?.trim() ? uid : "anonymous";
}

/** Create a notification for a user (newest first). */
export async function createNotification(
  userId: string | undefined,
  input: Pick<AppNotification, "type" | "title" | "message" | "link">,
): Promise<AppNotification> {
  const uid = userIdFor(userId);
  const kv = getSharedKV();

  const notif: AppNotification = {
    id: crypto.randomUUID(),
    type: input.type,
    title: input.title,
    message: input.message,
    link: input.link,
    isRead: false,
    createdAt: new Date().toISOString(),
  };

  // Best-effort: never throw into the caller's request path.
  try {
    const ids = (await kv.get<string[]>(listKey(uid))) ?? [];
    ids.unshift(notif.id);
    // Keep the index bounded (cap 200) so the KV list never balloons.
    const trimmed = ids.slice(0, 200);
    await kv.set(listKey(uid), trimmed, NOTIF_TTL_MS);
    await kv.set(itemKey(uid, notif.id), notif, NOTIF_TTL_MS);
    // Fan out to live listeners (GET /api/notifications/stream). Single
    // publish point — every creator (routes, bulk, research/autopilot
    // emitters) goes through here, so the stream can never miss an event.
    globalBus.publish(`notifications:${uid}`, {
      event: "notification.new",
      data: notif,
      id: notif.id,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "notifications-store.write-failed",
        error: (err as Error).message,
      }),
    );
  }
  return notif;
}

/** List notifications for a user, newest first. */
export async function listNotifications(
  userId: string | undefined,
  limit = 20,
): Promise<{ notifications: AppNotification[]; unreadCount: number }> {
  const uid = userIdFor(userId);
  const kv = getSharedKV();
  try {
    // The index is bounded (≤ NOTIF_TTL-kept 200 entries), so reading every item
    // is cheap — and lets unreadCount stay truthful even when callers only ask
    // for a small slice (e.g. ?limit=5). Counting unread only inside the slice
    // made the badge undercount as soon as unread items aged past the window.
    const ids = (await kv.get<string[]>(listKey(uid))) ?? [];
    const all = (
      await Promise.all(ids.map((id) => kv.get<AppNotification>(itemKey(uid, id))))
    ).filter((n): n is AppNotification => Boolean(n));
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return {
      notifications: all.slice(0, limit),
      unreadCount: all.filter((n) => !n.isRead).length,
    };
  } catch {
    return { notifications: [], unreadCount: 0 };
  }
}

/** Unread count only (lightweight — the bell polls this every 60s). */
export async function getUnreadCount(userId: string | undefined): Promise<number> {
  const { unreadCount } = await listNotifications(userId, 1);
  return unreadCount;
}

async function mutate(
  userId: string | undefined,
  id: string,
  fn: (n: AppNotification) => AppNotification,
): Promise<boolean> {
  const uid = userIdFor(userId);
  const kv = getSharedKV();
  try {
    const existing = await kv.get<AppNotification>(itemKey(uid, id));
    if (!existing) return false;
    await kv.set(itemKey(uid, id), fn(existing), NOTIF_TTL_MS);
    return true;
  } catch {
    return false;
  }
}

export async function markNotificationRead(
  userId: string | undefined,
  id: string,
): Promise<boolean> {
  return mutate(userId, id, (n) => ({ ...n, isRead: true }));
}

export async function dismissNotification(
  userId: string | undefined,
  id: string,
): Promise<boolean> {
  const uid = userIdFor(userId);
  const kv = getSharedKV();
  try {
    const existing = await kv.get<AppNotification>(itemKey(uid, id));
    if (!existing) return false; // nothing to dismiss — caller may 404
    const ids = (await kv.get<string[]>(listKey(uid))) ?? [];
    const next = ids.filter((x) => x !== id);
    await kv.set(listKey(uid), next, NOTIF_TTL_MS);
    await kv.delete(itemKey(uid, id));
    return true;
  } catch {
    return false;
  }
}

export async function dismissAllNotifications(userId: string | undefined): Promise<number> {
  const uid = userIdFor(userId);
  const kv = getSharedKV();
  try {
    const ids = (await kv.get<string[]>(listKey(uid))) ?? [];
    for (const id of ids) await kv.delete(itemKey(uid, id));
    await kv.set(listKey(uid), [], NOTIF_TTL_MS);
    return ids.length;
  } catch {
    return 0;
  }
}
