// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/db — GDPR erasure cascade tests.
 *
 * No live database: a fake recorder captures the sequence of delete calls, so we
 * assert the cascade covers every user-scoped table, targets user_id columns,
 * and removes the `users` row last.
 */
import { describe, it, expect } from "vitest";
import type { PgTable } from "drizzle-orm/pg-core";

import {
  eraseUserData,
  USER_SCOPED_TABLES,
  type ErasableDb,
  type ErasureResult,
} from "../src/gdpr.js";
import { users } from "../src/schema/index.js";

// A fake db that records each delete(table).where(cond) and returns a fixed count.
function recorderDb(rowCount = 1): {
  db: ErasableDb;
  order: PgTable[];
} {
  const order: PgTable[] = [];
  const db: ErasableDb = {
    delete(table: PgTable) {
      order.push(table);
      return {
        where(_condition) {
          return Promise.resolve({ rowCount });
        },
      };
    },
  };
  return { db, order };
}

describe("USER_SCOPED_TABLES manifest", () => {
  it("every entry targets a user_id column", () => {
    for (const t of USER_SCOPED_TABLES) {
      // Drizzle columns expose their SQL name; the whole point of the cascade is
      // that each entry keys off the owning user.
      expect((t.column as unknown as { name: string }).name).toBe("user_id");
    }
  });

  it("names are unique and non-empty", () => {
    const names = USER_SCOPED_TABLES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.length > 0)).toBe(true);
  });

  it("covers the known PII-bearing tables", () => {
    const names = new Set(USER_SCOPED_TABLES.map((t) => t.name));
    for (const required of [
      "oauth_credentials",
      "user_provider_credentials",
      "memory_entries",
      "refresh_tokens",
    ]) {
      expect(names.has(required)).toBe(true);
    }
  });
});

describe("eraseUserData", () => {
  it("deletes from every user-scoped table plus users", async () => {
    const { db, order } = recorderDb();
    const results = await eraseUserData(db, "user-123");
    // one delete per manifest table + the users row
    expect(order).toHaveLength(USER_SCOPED_TABLES.length + 1);
    expect(results).toHaveLength(USER_SCOPED_TABLES.length + 1);
  });

  it("removes the users row LAST (children before parent)", async () => {
    const { db, order } = recorderDb();
    await eraseUserData(db, "user-123");
    expect(order[order.length - 1]).toBe(users);
    // users must not appear among the earlier (child) deletes
    expect(order.slice(0, -1)).not.toContain(users);
  });

  it("reports per-table deleted counts", async () => {
    const { db } = recorderDb(3);
    const results = await eraseUserData(db, "user-123");
    expect(results.every((r: ErasureResult) => r.deleted === 3)).toBe(true);
    expect(results.at(-1)?.table).toBe("users");
  });

  it("is idempotent — a second run over an erased user deletes nothing", async () => {
    const { db } = recorderDb(0);
    const results = await eraseUserData(db, "ghost");
    expect(results.every((r) => r.deleted === 0)).toBe(true);
  });

  it("treats a missing rowCount as 0", async () => {
    const order: PgTable[] = [];
    const db: ErasableDb = {
      delete(table: PgTable) {
        order.push(table);
        return { where: () => Promise.resolve({}) }; // no rowCount reported
      },
    };
    const results = await eraseUserData(db, "u");
    expect(results.every((r) => r.deleted === 0)).toBe(true);
  });
});
