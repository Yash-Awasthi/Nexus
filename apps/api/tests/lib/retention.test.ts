// SPDX-License-Identifier: Apache-2.0
/**
 * One test per retention policy, because a retention policy nobody asserts is a
 * sentence in a document. The three stores keep data for different reasons and the
 * tests differ accordingly:
 *
 *   traces — the store itself evicts past 1000 (proved in request-traces.test.ts);
 *            here the policy value is pinned and the store is shown to read it.
 *   notifications — every write carries the 30-day expiry, on the item and on the
 *            index that points at it, so an index cannot outlive its items.
 *   audit log — nothing removes an entry: not time, not count, and not an erasure
 *            request. Asserted three ways: the policy object, the erasure table
 *            list, and the migration trigger that refuses DELETE.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { USER_SCOPED_TABLES } from "@nexus/db";
import { RETENTION, keepsForever } from "@nexus/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createNotification, dismissNotification } from "../../src/lib/notifications-store.ts";
import { getSharedKV } from "../../src/lib/shared-kv.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await getSharedKV().clear();
  vi.restoreAllMocks();
});

describe("retention: traces", () => {
  it("keeps the newest 1000 and nothing else", () => {
    expect(RETENTION.traces.maxEntries).toBe(1000);
    expect(RETENTION.traces.ttlMs).toBeUndefined();
    expect(keepsForever(RETENTION.traces)).toBe(false);
  });

  it("is the value the store uses, not a copy of it", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/lib/request-traces.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("RETENTION.traces.maxEntries");
    // A literal would be a second policy that drifts from this one.
    expect(source).not.toMatch(/const MAX_TRACES = \d+/);
  });
});

describe("retention: notifications", () => {
  it("expires in 30 days", () => {
    expect(RETENTION.notifications.ttlMs).toBe(30 * DAY_MS);
    expect(RETENTION.notifications.maxEntries).toBeUndefined();
  });

  it("stamps that expiry on the item and on the index pointing at it", async () => {
    const kv = getSharedKV();
    const set = vi.spyOn(kv, "set");
    const n = await createNotification("user-ttl", { type: "system", title: "expiring" });

    const writes = set.mock.calls.map(([key, , ttlMs]) => ({ key: String(key), ttlMs }));
    const item = writes.find((w) => w.key === `notif:item:user-ttl:${n.id}`);
    const list = writes.find((w) => w.key === "notif:list:user-ttl");
    expect(item?.ttlMs).toBe(RETENTION.notifications.ttlMs);
    // The index carries the same expiry: a list entry that outlived its item
    // would render a notification that cannot be read.
    expect(list?.ttlMs).toBe(RETENTION.notifications.ttlMs);
  });

  it("re-stamps the expiry when a notification is changed", async () => {
    const n = await createNotification("user-ttl", { type: "system", title: "read me" });
    const kv = getSharedKV();
    const set = vi.spyOn(kv, "set");
    await dismissNotification("user-ttl", n.id);
    const stamped = set.mock.calls.filter(([, , ttlMs]) => ttlMs !== undefined);
    expect(stamped.length).toBeGreaterThan(0);
    for (const [, , ttlMs] of stamped) expect(ttlMs).toBe(RETENTION.notifications.ttlMs);
  });
});

describe("retention: audit log", () => {
  it("is kept forever, with no count and no clock", () => {
    expect(RETENTION.auditLog.indefinite).toBe(true);
    expect(RETENTION.auditLog.maxEntries).toBeUndefined();
    expect(RETENTION.auditLog.ttlMs).toBeUndefined();
    expect(keepsForever(RETENTION.auditLog)).toBe(true);
  });

  it("survives an erasure request, so erasing cannot erase the record of it", () => {
    const tables = USER_SCOPED_TABLES.map((t) => t.name);
    expect(tables).not.toContain("audit_log");
  });

  it("is protected by the database, not only by the application", () => {
    const sql = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../packages/db/migrations/20240610061320_0000_bootstrap/migration.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(sql).toMatch(/CREATE TRIGGER audit_log_no_delete/);
    expect(sql).toMatch(/CREATE TRIGGER audit_log_no_update/);
  });
});
