// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";

import { globalBus } from "@nexus/sse";

import { getSharedKV } from "../../src/lib/shared-kv.js";
import {
  createNotification,
  dismissAllNotifications,
  dismissNotification,
  getUnreadCount,
  listNotifications,
  markNotificationRead,
} from "../../src/lib/notifications-store.js";

// No REDIS_URL / UPSTASH env in tests → getSharedKV() falls back to the
// in-process MemoryKVStore. Clear it before every test so cases are isolated.
beforeEach(async () => {
  await getSharedKV().clear();
});

describe("notifications-store", () => {
  it("creates an unread notification with a UUID id", async () => {
    const n = await createNotification("user-1", {
      type: "research",
      title: "Research complete",
      message: "hi",
    });
    expect(n.id).toBeTruthy();
    expect(n.isRead).toBe(false);
    expect(new Date(n.createdAt).getTime()).not.toBeNaN();
  });

  it("lists newest-first and reports the unread count", async () => {
    await createNotification("user-1", { type: "system", title: "first" });
    await new Promise((r) => setTimeout(r, 5));
    await createNotification("user-1", { type: "system", title: "second" });

    const { notifications, unreadCount } = await listNotifications("user-1", 10);
    expect(notifications.map((n) => n.title)).toEqual(["second", "first"]);
    expect(unreadCount).toBe(2);
  });

  it("markNotificationRead flips isRead and drops the unread count", async () => {
    const n = await createNotification("user-1", { type: "system", title: "hi" });
    expect(await getUnreadCount("user-1")).toBe(1);

    expect(await markNotificationRead("user-1", n.id)).toBe(true);
    expect(await getUnreadCount("user-1")).toBe(0);

    const { notifications } = await listNotifications("user-1", 10);
    expect(notifications[0]?.isRead).toBe(true);
  });

  it("dismiss removes a single notification; dismissAll clears the tray", async () => {
    const a = await createNotification("user-1", { type: "system", title: "a" });
    const _b = await createNotification("user-1", { type: "system", title: "b" });

    expect(await dismissNotification("user-1", a.id)).toBe(true);
    let list = await listNotifications("user-1", 10);
    expect(list.notifications.map((n) => n.title)).toEqual(["b"]);

    expect(await dismissAllNotifications("user-1")).toBe(1);
    list = await listNotifications("user-1", 10);
    expect(list.notifications).toHaveLength(0);
  });

  it("marks unknown ids as missing (false) without throwing", async () => {
    await createNotification("user-1", { type: "system", title: "a" });
    expect(await markNotificationRead("user-1", "does-not-exist")).toBe(false);
    expect(await dismissNotification("user-1", "does-not-exist")).toBe(false);
  });

  it("scopes everything per user — no cross-user leakage", async () => {
    await createNotification("alice", { type: "system", title: "alice-notif" });
    await createNotification("bob", { type: "system", title: "bob-notif" });

    const alice = await listNotifications("alice", 10);
    expect(alice.notifications.map((n) => n.title)).toEqual(["alice-notif"]);

    const bob = await listNotifications("bob", 10);
    expect(bob.notifications.map((n) => n.title)).toEqual(["bob-notif"]);

    expect(await getUnreadCount("carol")).toBe(0);
  });

  it("reports the true unread count even when unread items sit beyond the returned slice", async () => {
    // Regression: unreadCount used to be computed inside the requested slice, so
    // a small ?limit= hid older unread items and the badge undercounted.
    const created: string[] = [];
    for (let i = 0; i < 10; i++) {
      const n = await createNotification("user-1", { type: "system", title: `n${i}` });
      created.push(n.id);
    }
    // Read the 6 newest (created newest-first).
    for (const id of created.slice(0, 6)) await markNotificationRead("user-1", id);

    const list = await listNotifications("user-1", 5);
    expect(list.notifications).toHaveLength(5);
    // All 5 returned are read (they are the newest); the 4 older ones are unread.
    expect(list.unreadCount).toBe(4);
    expect(await getUnreadCount("user-1")).toBe(4);
  });

  it("publishes a notification.new event on the per-user bus channel", async () => {
    // Regression: the live SSE stream (GET /api/notifications/stream) is fed by
    // this publish — if it ever stops firing, the badge/toast go quiet while
    // the poll interval still works, which is exactly the bug this guards.
    const received: unknown[] = [];
    const unsubscribe = globalBus.subscribe("notifications:user-1", (e) => received.push(e));
    try {
      const n = await createNotification("user-1", {
        type: "research",
        title: "Research complete",
        message: "report ready",
      });
      expect(received).toHaveLength(1);
      const ev = received[0] as { event?: string; data?: { id?: string; title?: string } };
      expect(ev.event).toBe("notification.new");
      expect(ev.data?.id).toBe(n.id);
      expect(ev.data?.title).toBe("Research complete");
    } finally {
      unsubscribe();
    }
  });

  it("count endpoint agrees with a full list after mixed reads", async () => {
    const created: string[] = [];
    for (let i = 0; i < 8; i++) {
      const n = await createNotification("user-2", { type: "system", title: `n${i}` });
      created.push(n.id);
    }
    await markNotificationRead("user-2", created[0]!); // newest
    await dismissNotification("user-2", created[7]!); // oldest — gone entirely

    expect(await getUnreadCount("user-2")).toBe(6);
    const { notifications, unreadCount } = await listNotifications("user-2", 100);
    expect(notifications).toHaveLength(7);
    expect(unreadCount).toBe(6);
  });
});
