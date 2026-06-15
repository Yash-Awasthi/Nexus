// SPDX-License-Identifier: Apache-2.0
/**
 * PgVectorStore tests — uses a mocked neon SQL function so no real DB is needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemoryEntry } from "../src/index.js";

// ── Mock @neondatabase/serverless ─────────────────────────────────────────────
const mockSqlFn = vi.fn();

vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockSqlFn,
}));

// Dynamic import after mock is set up
const { PgVectorStore } = await import("../src/index.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "test-id-1",
    text: "hello world",
    embedding: Array.from({ length: 768 }, () => 0),
    metadata: {},
    createdAt: 1704067200, // 2024-01-01 00:00:00 UTC unix seconds
    ...overrides,
  };
}

/** Build a Postgres row as the Neon driver would return it. */
function makeRow(entry: MemoryEntry, score?: number) {
  const embStr = `[${entry.embedding.join(",")}]`;
  const row: Record<string, unknown> = {
    id: entry.id,
    text: entry.text,
    embedding_str: embStr,
    metadata: entry.metadata,
    created_at: entry.createdAt,
    expires_at: entry.expiresAt ?? null,
    user_id: entry.userId ?? null,
  };
  if (score !== undefined) row.score = score;
  return row;
}

/**
 * Chain exactly 6 schema-bootstrap mock resolved values:
 *  1. CREATE EXTENSION
 *  2. CREATE TABLE (with user_id column)
 *  3. ALTER TABLE ADD COLUMN IF NOT EXISTS user_id
 *  4. CREATE INDEX btree (created_at)
 *  5. CREATE INDEX ivfflat (embedding) — non-fatal, wrapped in try/catch
 *  6. CREATE INDEX btree (user_id)
 */
function schemaMocks() {
  return mockSqlFn
    .mockResolvedValueOnce([]) // 1: CREATE EXTENSION
    .mockResolvedValueOnce([]) // 2: CREATE TABLE
    .mockResolvedValueOnce([]) // 3: ALTER TABLE ADD COLUMN user_id
    .mockResolvedValueOnce([]) // 4: CREATE INDEX btree created_at
    .mockResolvedValueOnce([]) // 5: CREATE INDEX ivfflat embedding
    .mockResolvedValueOnce([]); // 6: CREATE INDEX btree user_id
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PgVectorStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── save() ──────────────────────────────────────────────────────────────────

  describe("save()", () => {
    it("inserts entry and returns it", async () => {
      const entry = makeEntry();
      schemaMocks().mockResolvedValueOnce([]); // 7: INSERT (upsert, no rows returned)

      const store = new PgVectorStore({ databaseUrl: "postgresql://fake" });
      const result = await store.save(entry);

      expect(result.id).toBe("test-id-1");
      expect(result.text).toBe("hello world");
      expect(mockSqlFn).toHaveBeenCalledTimes(7);
    });

    it("throws when INSERT fails", async () => {
      schemaMocks().mockRejectedValueOnce(new Error("unique violation")); // 7: INSERT throws

      const store = new PgVectorStore({ databaseUrl: "postgresql://fake" });
      await expect(store.save(makeEntry())).rejects.toThrow();
      expect(mockSqlFn).toHaveBeenCalledTimes(7);
    });

    it("includes userId in returned entry when provided", async () => {
      const entry = makeEntry({ userId: "user-abc" });
      schemaMocks().mockResolvedValueOnce([]); // 7: INSERT

      const store = new PgVectorStore({ databaseUrl: "postgresql://fake" });
      const result = await store.save(entry);

      expect(result.userId).toBe("user-abc");
      expect(mockSqlFn).toHaveBeenCalledTimes(7);
    });
  });

  // ── search() ────────────────────────────────────────────────────────────────

  describe("search()", () => {
    it("returns entries ordered by similarity", async () => {
      const entry = makeEntry();
      schemaMocks()
        .mockResolvedValueOnce([]) // 7: SET LOCAL ivfflat.probes
        .mockResolvedValueOnce([makeRow(entry, 0.95)]); // 8: SELECT

      const store = new PgVectorStore({ databaseUrl: "postgresql://fake" });
      const results = await store.search(entry.embedding, 5);

      expect(results).toHaveLength(1);
      expect(results[0]!.entry.id).toBe("test-id-1");
      expect(results[0]!.score).toBeCloseTo(0.95);
      expect(mockSqlFn).toHaveBeenCalledTimes(8);
    });

    it("returns empty array when no results", async () => {
      schemaMocks()
        .mockResolvedValueOnce([]) // 7: SET LOCAL ivfflat.probes
        .mockResolvedValueOnce([]); // 8: SELECT returns empty

      const store = new PgVectorStore({ databaseUrl: "postgresql://fake" });
      const results = await store.search(Array(768).fill(0), 10);

      expect(results).toHaveLength(0);
      expect(mockSqlFn).toHaveBeenCalledTimes(8);
    });

    it("filters by userId when provided", async () => {
      const entry = makeEntry({ userId: "user-abc" });
      schemaMocks()
        .mockResolvedValueOnce([]) // 7: SET LOCAL ivfflat.probes
        .mockResolvedValueOnce([makeRow(entry, 0.9)]); // 8: SELECT

      const store = new PgVectorStore({ databaseUrl: "postgresql://fake" });
      const results = await store.search(entry.embedding, 5, { userId: "user-abc" });

      expect(results).toHaveLength(1);
      expect(results[0]!.entry.userId).toBe("user-abc");
      expect(mockSqlFn).toHaveBeenCalledTimes(8);
    });
  });

  // ── delete() ────────────────────────────────────────────────────────────────

  describe("delete()", () => {
    it("resolves without error on successful delete", async () => {
      schemaMocks().mockResolvedValueOnce([]); // 7: DELETE

      const store = new PgVectorStore({ databaseUrl: "postgresql://fake" });
      await expect(store.delete("test-id-1")).resolves.toBeUndefined();
      expect(mockSqlFn).toHaveBeenCalledTimes(7);
    });

    it("throws when delete fails", async () => {
      schemaMocks().mockRejectedValueOnce(new Error("DB error")); // 7: DELETE fails

      const store = new PgVectorStore({ databaseUrl: "postgresql://fake" });
      await expect(store.delete("bad-id")).rejects.toThrow("DB error");
      expect(mockSqlFn).toHaveBeenCalledTimes(7);
    });
  });

  // ── list() ──────────────────────────────────────────────────────────────────

  describe("list()", () => {
    it("returns all entries matching filter", async () => {
      const entry = makeEntry({ metadata: { source: "notes" } });
      schemaMocks().mockResolvedValueOnce([makeRow(entry)]); // 7: SELECT

      const store = new PgVectorStore({ databaseUrl: "postgresql://fake" });
      const results = await store.list({ metadata: { source: "notes" } });

      expect(results).toHaveLength(1);
      expect(results[0]!.metadata.source).toBe("notes");
      expect(mockSqlFn).toHaveBeenCalledTimes(7);
    });

    it("returns empty array when no entries match", async () => {
      schemaMocks().mockResolvedValueOnce([]); // 7: SELECT returns empty

      const store = new PgVectorStore({ databaseUrl: "postgresql://fake" });
      const results = await store.list();

      expect(results).toHaveLength(0);
      expect(mockSqlFn).toHaveBeenCalledTimes(7);
    });

    it("filters by userId when provided", async () => {
      const entry = makeEntry({ userId: "user-xyz" });
      schemaMocks().mockResolvedValueOnce([makeRow(entry)]); // 7: SELECT

      const store = new PgVectorStore({ databaseUrl: "postgresql://fake" });
      const results = await store.list({ userId: "user-xyz" });

      expect(results).toHaveLength(1);
      expect(results[0]!.userId).toBe("user-xyz");
      expect(mockSqlFn).toHaveBeenCalledTimes(7);
    });
  });

  // ── purge() ─────────────────────────────────────────────────────────────────

  describe("purge()", () => {
    it("fast-paths to DELETE RETURNING when no metadata filter provided", async () => {
      schemaMocks().mockResolvedValueOnce([]); // 7: DELETE RETURNING id (0 rows)

      const store = new PgVectorStore({ databaseUrl: "postgresql://fake" });
      const count = await store.purge();

      expect(count).toBe(0);
      expect(mockSqlFn).toHaveBeenCalledTimes(7);
    });

    it("lists then deletes when metadata filter provided", async () => {
      const entry = makeEntry({ metadata: { source: "old" } });
      schemaMocks()
        .mockResolvedValueOnce([makeRow(entry)]) // 7: SELECT (list)
        .mockResolvedValueOnce([]); // 8: DELETE by id

      const store = new PgVectorStore({ databaseUrl: "postgresql://fake" });
      const count = await store.purge({ metadata: { source: "old" } });

      expect(count).toBe(1);
      expect(mockSqlFn).toHaveBeenCalledTimes(8);
    });
  });
});
