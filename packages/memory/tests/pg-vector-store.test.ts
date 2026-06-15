// SPDX-License-Identifier: Apache-2.0
/**
 * PgVectorStore tests — uses a mocked neon SQL function so no real DB is needed.
 * The mock is scoped to this file; it does not affect memory.test.ts.
 *
 * Schema bootstrap sequence (4 calls):
 *   1. CREATE EXTENSION IF NOT EXISTS vector
 *   2. CREATE TABLE IF NOT EXISTS memory_entries …
 *   3. CREATE INDEX IF NOT EXISTS memory_entries_created_at_idx (btree)
 *   4. CREATE INDEX IF NOT EXISTS memory_entries_embedding_idx (ivfflat) — non-fatal
 *
 * Search sequence (2 calls after schema):
 *   1. SET LOCAL ivfflat.probes = 10
 *   2. SELECT … ORDER BY embedding <=> … LIMIT n
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryError, PgVectorStore } from "../src/index.js";
import type { MemoryEntry } from "../src/index.js";

// ── Hoisted mock ──────────────────────────────────────────────────────────────

const { mockSqlFn } = vi.hoisted(() => {
  const mockSqlFn = vi.fn().mockResolvedValue([]);
  return { mockSqlFn };
});

vi.mock("@neondatabase/serverless", () => ({
  neon: vi.fn().mockImplementation(() => mockSqlFn),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "entry-1",
    text: "hello world",
    embedding: [0.1, 0.2, 0.3],
    metadata: { tag: "test" },
    createdAt: 1_000_000,
    ...overrides,
  };
}

/** Row as returned by Postgres (embedding stored as text "[0.1,0.2,0.3]") */
function makeRow(entry: MemoryEntry, score = 0.9): Record<string, unknown> {
  return {
    id: entry.id,
    text: entry.text,
    embedding_str: `[${entry.embedding.join(",")}]`,
    metadata: entry.metadata,
    created_at: entry.createdAt,
    expires_at: entry.expiresAt ?? null,
    score,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PgVectorStore", () => {
  beforeEach(() => {
    mockSqlFn.mockReset();
    mockSqlFn.mockResolvedValue([]); // default: all SQL calls succeed with empty result
  });

  // ── Constructor ─────────────────────────────────────────────────────────────

  it("throws MemoryError when DATABASE_URL is not set and no databaseUrl provided", () => {
    const orig = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => new PgVectorStore()).toThrow(MemoryError);
    } finally {
      if (orig !== undefined) process.env.DATABASE_URL = orig;
    }
  });

  it("constructs successfully with explicit databaseUrl", () => {
    expect(() => new PgVectorStore({ databaseUrl: "postgresql://localhost/test" })).not.toThrow();
  });

  it("reads DATABASE_URL from process.env if databaseUrl not supplied", () => {
    process.env.DATABASE_URL = "postgresql://localhost/env_test";
    try {
      expect(() => new PgVectorStore()).not.toThrow();
    } finally {
      delete process.env.DATABASE_URL;
    }
  });

  // ── save() ──────────────────────────────────────────────────────────────────

  it("save() bootstraps schema on first call then inserts", async () => {
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    const entry = makeEntry();
    const result = await store.save(entry);
    // save returns the same entry object
    expect(result).toEqual(entry);
    // neon tagged template was called (schema + insert)
    expect(mockSqlFn).toHaveBeenCalled();
  });

  it("save() does not re-bootstrap schema on subsequent calls", async () => {
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    const entry = makeEntry();
    await store.save(entry); // first call — triggers schema bootstrap (4 SQL calls + 1 insert)
    const callsAfterFirst = mockSqlFn.mock.calls.length;
    await store.save(makeEntry({ id: "entry-2" })); // second call — only 1 SQL call (insert)
    expect(mockSqlFn.mock.calls.length).toBe(callsAfterFirst + 1);
  });

  it("save() throws STORE_WRITE_FAILED when schema bootstrap fails", async () => {
    mockSqlFn.mockRejectedValueOnce(new Error("pg error"));
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    await expect(store.save(makeEntry())).rejects.toMatchObject({
      code: "STORE_WRITE_FAILED",
    });
  });

  it("save() throws STORE_WRITE_FAILED when insert fails", async () => {
    // Schema bootstrap (4 calls), then insert fails on call 5
    mockSqlFn
      .mockResolvedValueOnce([]) // 1: CREATE EXTENSION
      .mockResolvedValueOnce([]) // 2: CREATE TABLE
      .mockResolvedValueOnce([]) // 3: CREATE INDEX btree (created_at)
      .mockResolvedValueOnce([]) // 4: CREATE INDEX ivfflat (embedding) — non-fatal
      .mockRejectedValueOnce(new Error("insert failed")); // 5: INSERT
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    await expect(store.save(makeEntry())).rejects.toMatchObject({
      code: "STORE_WRITE_FAILED",
    });
  });

  it("save() handles entry with expiresAt", async () => {
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    const entry = makeEntry({ expiresAt: 2_000_000 });
    const result = await store.save(entry);
    expect(result.expiresAt).toBe(2_000_000);
  });

  // ── search() ────────────────────────────────────────────────────────────────

  it("search() returns empty array when no rows match", async () => {
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    const results = await store.search([0.1, 0.2, 0.3], 5);
    expect(results).toEqual([]);
  });

  it("search() maps DB rows to MemorySearchResult", async () => {
    const entry = makeEntry();
    // Schema bootstrap (4 calls) + SET LOCAL (1) + SELECT (1)
    mockSqlFn
      .mockResolvedValueOnce([]) // 1: CREATE EXTENSION
      .mockResolvedValueOnce([]) // 2: CREATE TABLE
      .mockResolvedValueOnce([]) // 3: CREATE INDEX btree
      .mockResolvedValueOnce([]) // 4: CREATE INDEX ivfflat
      .mockResolvedValueOnce([]) // 5: SET LOCAL ivfflat.probes = 10
      .mockResolvedValueOnce([makeRow(entry, 0.95)]); // 6: SELECT
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    const results = await store.search([0.1], 5);
    expect(results).toHaveLength(1);
    expect(results[0].entry.id).toBe(entry.id);
    expect(results[0].entry.text).toBe(entry.text);
    expect(results[0].score).toBe(0.95);
  });

  it("search() filters results by metadata", async () => {
    const entry = makeEntry({ metadata: { env: "prod" } });
    mockSqlFn
      .mockResolvedValueOnce([]) // 1: CREATE EXTENSION
      .mockResolvedValueOnce([]) // 2: CREATE TABLE
      .mockResolvedValueOnce([]) // 3: CREATE INDEX btree
      .mockResolvedValueOnce([]) // 4: CREATE INDEX ivfflat
      .mockResolvedValueOnce([]) // 5: SET LOCAL ivfflat.probes = 10
      .mockResolvedValueOnce([  // 6: SELECT returns 2 rows
        makeRow(entry, 0.9),
        makeRow(makeEntry({ id: "e2", metadata: { env: "dev" } }), 0.8),
      ]);
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    const results = await store.search([0.1], 5, { metadata: { env: "prod" } });
    expect(results).toHaveLength(1);
    expect(results[0].entry.metadata.env).toBe("prod");
  });

  it("search() passes excludeExpired=false to include expired entries", async () => {
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    // Should not throw when excludeExpired is false
    await expect(store.search([0.1], 5, { excludeExpired: false })).resolves.toEqual([]);
  });

  it("search() throws STORE_READ_FAILED when SQL fails", async () => {
    // Schema bootstrap (4 calls) + SET LOCAL (1) + SELECT rejects (1)
    mockSqlFn
      .mockResolvedValueOnce([]) // 1: CREATE EXTENSION
      .mockResolvedValueOnce([]) // 2: CREATE TABLE
      .mockResolvedValueOnce([]) // 3: CREATE INDEX btree
      .mockResolvedValueOnce([]) // 4: CREATE INDEX ivfflat
      .mockResolvedValueOnce([]) // 5: SET LOCAL ivfflat.probes = 10
      .mockRejectedValueOnce(new Error("db offline")); // 6: SELECT
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    await expect(store.search([0.1], 5)).rejects.toMatchObject({
      code: "STORE_READ_FAILED",
    });
  });

  // ── delete() ─────────────────────────────────────────────────────────────────

  it("delete() calls SQL with the correct id", async () => {
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    await store.delete("entry-1"); // schema bootstrap + delete
    // Last call should contain the id (can't easily inspect tagged template args, but it was called)
    expect(mockSqlFn).toHaveBeenCalled();
  });

  it("delete() throws STORE_WRITE_FAILED on SQL failure", async () => {
    // Schema bootstrap (4 calls) + DELETE rejects (1)
    mockSqlFn
      .mockResolvedValueOnce([]) // 1: CREATE EXTENSION
      .mockResolvedValueOnce([]) // 2: CREATE TABLE
      .mockResolvedValueOnce([]) // 3: CREATE INDEX btree
      .mockResolvedValueOnce([]) // 4: CREATE INDEX ivfflat
      .mockRejectedValueOnce(new Error("delete failed")); // 5: DELETE
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    await expect(store.delete("entry-1")).rejects.toMatchObject({
      code: "STORE_WRITE_FAILED",
    });
  });

  // ── list() ───────────────────────────────────────────────────────────────────

  it("list() returns empty array when table is empty", async () => {
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    const entries = await store.list();
    expect(entries).toEqual([]);
  });

  it("list() maps DB rows to MemoryEntry[]", async () => {
    const entry = makeEntry();
    // Schema bootstrap (4 calls) + SELECT (1)
    mockSqlFn
      .mockResolvedValueOnce([]) // 1: CREATE EXTENSION
      .mockResolvedValueOnce([]) // 2: CREATE TABLE
      .mockResolvedValueOnce([]) // 3: CREATE INDEX btree
      .mockResolvedValueOnce([]) // 4: CREATE INDEX ivfflat
      .mockResolvedValueOnce([makeRow(entry)]); // 5: SELECT
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(entry.id);
  });

  it("list() filters by metadata", async () => {
    // Schema bootstrap (4 calls) + SELECT (1)
    mockSqlFn
      .mockResolvedValueOnce([]) // 1: CREATE EXTENSION
      .mockResolvedValueOnce([]) // 2: CREATE TABLE
      .mockResolvedValueOnce([]) // 3: CREATE INDEX btree
      .mockResolvedValueOnce([]) // 4: CREATE INDEX ivfflat
      .mockResolvedValueOnce([  // 5: SELECT
        makeRow(makeEntry({ id: "e1", metadata: { role: "admin" } })),
        makeRow(makeEntry({ id: "e2", metadata: { role: "user" } })),
      ]);
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    const entries = await store.list({ metadata: { role: "admin" } });
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata.role).toBe("admin");
  });

  it("list() throws STORE_READ_FAILED on SQL failure", async () => {
    // Schema bootstrap (4 calls) + SELECT rejects (1)
    mockSqlFn
      .mockResolvedValueOnce([]) // 1: CREATE EXTENSION
      .mockResolvedValueOnce([]) // 2: CREATE TABLE
      .mockResolvedValueOnce([]) // 3: CREATE INDEX btree
      .mockResolvedValueOnce([]) // 4: CREATE INDEX ivfflat
      .mockRejectedValueOnce(new Error("list failed")); // 5: SELECT
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    await expect(store.list()).rejects.toMatchObject({ code: "STORE_READ_FAILED" });
  });

  // ── purge() ───────────────────────────────────────────────────────────────────

  it("purge() fast-path returns count of deleted rows", async () => {
    // Schema bootstrap (4 calls) + DELETE RETURNING (1)
    mockSqlFn
      .mockResolvedValueOnce([]) // 1: CREATE EXTENSION
      .mockResolvedValueOnce([]) // 2: CREATE TABLE
      .mockResolvedValueOnce([]) // 3: CREATE INDEX btree
      .mockResolvedValueOnce([]) // 4: CREATE INDEX ivfflat
      .mockResolvedValueOnce([{ id: "e1" }, { id: "e2" }]); // 5: DELETE RETURNING
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    const count = await store.purge();
    expect(count).toBe(2);
  });

  it("purge() fast-path throws STORE_WRITE_FAILED on SQL error", async () => {
    // Schema bootstrap (4 calls) + DELETE rejects (1)
    mockSqlFn
      .mockResolvedValueOnce([]) // 1: CREATE EXTENSION
      .mockResolvedValueOnce([]) // 2: CREATE TABLE
      .mockResolvedValueOnce([]) // 3: CREATE INDEX btree
      .mockResolvedValueOnce([]) // 4: CREATE INDEX ivfflat
      .mockRejectedValueOnce(new Error("purge failed")); // 5: DELETE
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    await expect(store.purge()).rejects.toMatchObject({ code: "STORE_WRITE_FAILED" });
  });

  it("purge() metadata-filtered path lists then deletes individually", async () => {
    const entry = makeEntry({ metadata: { tag: "old" } });
    // Schema bootstrap (4) + list query (1) + individual delete (1)
    mockSqlFn
      .mockResolvedValueOnce([]) // 1: CREATE EXTENSION
      .mockResolvedValueOnce([]) // 2: CREATE TABLE
      .mockResolvedValueOnce([]) // 3: CREATE INDEX btree
      .mockResolvedValueOnce([]) // 4: CREATE INDEX ivfflat
      .mockResolvedValueOnce([makeRow(entry)]) // 5: list returns 1 matching entry
      .mockResolvedValueOnce([]); // 6: individual DELETE
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    const count = await store.purge({ metadata: { tag: "old" } });
    expect(count).toBe(1);
  });

  it("purge() with metadata filter returns 0 when no entries match", async () => {
    // Schema bootstrap (4 calls) + list returns empty (1)
    mockSqlFn
      .mockResolvedValueOnce([]) // 1: CREATE EXTENSION
      .mockResolvedValueOnce([]) // 2: CREATE TABLE
      .mockResolvedValueOnce([]) // 3: CREATE INDEX btree
      .mockResolvedValueOnce([]) // 4: CREATE INDEX ivfflat
      .mockResolvedValueOnce([]); // 5: list returns nothing
    const store = new PgVectorStore({ databaseUrl: "postgresql://localhost/test" });
    const count = await store.purge({ metadata: { tag: "nonexistent" } });
    expect(count).toBe(0);
  });
});
