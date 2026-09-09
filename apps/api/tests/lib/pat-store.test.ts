// SPDX-License-Identifier: Apache-2.0
/**
 * PAT store persistence tests (playtest round 5).
 *
 * The store is DB-backed: api_keys is the source of truth, the in-process map
 * is a write-through cache hydrated at startup. These tests exercise the DB
 * contract against a mocked @nexus/db (same pattern as packages/billing):
 *   - createPat persists a row (hash, nxk_ prefix, owner, scopes, tier, expiry)
 *   - initPatStore hydrates tokens minted "before a restart"
 *   - verifyPat falls back to the DB on a cache miss and stamps lastUsedAt
 *   - revokePat hard-deletes from the DB and the cache
 *   - listings stay per-owner
 *
 * The real SQL semantics (eq/like/isNull filters) are verified live against
 * the dev DB in the playtest; the fake here pins the store's write/read
 * contract and argument shapes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { sha256hex } from "../../src/lib/crypto-utils.js";

// ── Hoist DB mocks (house pattern: packages/billing/tests) ───────────────────

const {
  mockSelectWhere,
  mockSelectLimit,
  mockSelectFrom,
  mockSelect,
  mockInsertValues,
  mockInsert,
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
  mockDeleteWhere,
  mockDelete,
} = vi.hoisted(() => {
  const mockSelectLimit = vi.fn().mockResolvedValue([]);
  // where() returns a thenable that ALSO carries .limit() so both
  // `await select().from().where()` and `await select().from().where().limit(1)`
  // resolve to the rows configured for the current test.
  const mockSelectWhere = vi.fn(() => {
    const rows = mockSelectWhere.rows as Record<string, unknown>[];
    return Object.assign(Promise.resolve(rows), { limit: async (n: number) => rows.slice(0, n) });
  });
  (mockSelectWhere as unknown as { rows: unknown[] }).rows = [];
  const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere, limit: mockSelectLimit }));
  const mockSelect = vi.fn(() => ({ from: mockSelectFrom }));

  const mockInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockInsert = vi.fn(() => ({ values: mockInsertValues }));

  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));

  const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const mockDelete = vi.fn(() => ({ where: mockDeleteWhere }));

  return {
    mockSelectWhere,
    mockSelectLimit,
    mockSelectFrom,
    mockSelect,
    mockInsertValues,
    mockInsert,
    mockUpdateWhere,
    mockUpdateSet,
    mockUpdate,
    mockDeleteWhere,
    mockDelete,
  };
});

vi.mock("@nexus/db", () => ({
  db: { select: mockSelect, insert: mockInsert, update: mockUpdate, delete: mockDelete },
}));

vi.mock("@nexus/db/schema", () => ({ apiKeys: {} }));

vi.mock("drizzle-orm", () => ({
  eq: (l: unknown, r: unknown) => ({ op: "=", l, r }),
  like: (l: unknown, r: unknown) => ({ op: "~~", l, r }),
  isNull: (l: unknown) => ({ op: "is null", l }),
  and: (...args: unknown[]) => ({ op: "and", args }),
}));

// Let the store's DB probe run against the mocked @nexus/db (vitest sets
// VITEST=true by default, which pat-store treats as "stay in-memory").
vi.stubEnv("VITEST", "");

import {
  createPat,
  initPatStore,
  listPats,
  revokePat,
  verifyPat,
} from "../../src/lib/pat-store.js";

function seedRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const id = String(Math.random());
  const raw = `nxk_${"a".repeat(48)}${id}`;
  return {
    id,
    keyHash: sha256hex(raw),
    keyPrefix: raw.slice(0, 10),
    name: "seeded",
    ownerId: "u-seed",
    plan: "free",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    revokedAt: null,
    expiresAt: null,
    lastUsedAt: null,
    scopes: ["*"],
    tier: "basic",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (mockSelectWhere as unknown as { rows: unknown[] }).rows = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VITEST", "");
});

describe("createPat", () => {
  it("persists a row to api_keys: hash, nxk_ prefix, owner, scopes, tier, expiry", async () => {
    const { entry, raw } = await createPat({
      ownerId: "u1",
      name: "ci-token",
      scopes: ["chat", "memory"],
      tier: "pro",
      expiresInDays: 30,
    });

    expect(raw.startsWith("nxk_")).toBe(true);
    expect(mockInsert).toHaveBeenCalled();
    const values = mockInsertValues.mock.calls[0]![0];
    // The persisted row must carry the SAME id as the entry returned to the
    // caller — otherwise revoke-by-id 404s after a restart (live bug, round 5).
    expect(values.id).toBe(entry.id);
    expect(values.keyHash).toBe(entry.hash);
    expect(values.keyPrefix).toBe(entry.prefix);
    expect(values.ownerId).toBe("u1");
    expect(values.name).toBe("ci-token");
    expect(values.scopes).toEqual(["chat", "memory"]);
    expect(values.tier).toBe("pro");
    expect(values.plan).toBe("pro");
    expect(values.expiresAt).toBeInstanceOf(Date);
  });

  it("defaults: no expiry, wildcard scopes, basic tier", async () => {
    const { entry } = await createPat({ ownerId: "u1", name: "plain" });
    expect(entry.expiresAt).toBeNull();
    expect(entry.scopes).toEqual(["*"]);
    expect(entry.tier).toBe("basic");
    expect(mockInsertValues.mock.calls[0]![0].expiresAt).toBeNull();
  });
});

describe("initPatStore (restart hydration)", () => {
  it("loads nxk_ rows from api_keys so pre-restart tokens keep verifying", async () => {
    const row = seedRow({ ownerId: "u-seed", id: "row-1" });
    (mockSelectWhere as unknown as { rows: unknown[] }).rows = [row];
    await initPatStore();
    // DB now empty (as if the source changed) — listing must still find the
    // hydrated token in the cache.
    (mockSelectWhere as unknown as { rows: unknown[] }).rows = [];
    const listed = await listPats("u-seed");
    expect(listed.some((t) => t.id === "row-1")).toBe(true);
  });
});

describe("verifyPat", () => {
  it("falls back to the DB on a cache miss (token minted by another process)", async () => {
    const raw = `nxk_${"b".repeat(48)}`;
    const row = seedRow({ ownerId: "u-other", id: "row-2", keyHash: sha256hex(raw) });
    (mockSelectWhere as unknown as { rows: unknown[] }).rows = [row];

    const entry = await verifyPat(raw);
    expect(entry).not.toBeNull();
    expect(entry!.ownerId).toBe("u-other");
  });

  it("stamps lastUsedAt in the DB on success", async () => {
    const { raw } = await createPat({ ownerId: "u1", name: "used" });
    (mockSelectWhere as unknown as { rows: unknown[] }).rows = [];
    await verifyPat(raw);
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockUpdateSet.mock.calls[0]![0]).toHaveProperty("lastUsedAt");
    expect(mockUpdateSet.mock.calls[0]![0].lastUsedAt).toBeInstanceOf(Date);
  });

  it("rejects a revoked token (map removed → DB empty → null)", async () => {
    const { entry, raw } = await createPat({ ownerId: "u1", name: "doomed" });
    await revokePat(entry.id, "u1");
    (mockSelectWhere as unknown as { rows: unknown[] }).rows = [];
    expect(await verifyPat(raw)).toBeNull();
  });
});

describe("revokePat", () => {
  it("hard-deletes from the DB and the cache", async () => {
    const { entry, raw } = await createPat({ ownerId: "u1", name: "revoke-me" });
    expect(await revokePat(entry.id, "u1")).toBe(true);

    expect(mockDelete).toHaveBeenCalled();
    expect(mockDeleteWhere.mock.calls[0]![0]).toBeDefined();

    (mockSelectWhere as unknown as { rows: unknown[] }).rows = [];
    expect((await listPats("u1")).some((t) => t.id === entry.id)).toBe(false);
    expect(await verifyPat(raw)).toBeNull();
  });

  it("is owner-scoped: another user cannot revoke it", async () => {
    const { entry } = await createPat({ ownerId: "u1", name: "mine" });
    expect(await revokePat(entry.id, "u2")).toBe(false);
    (mockSelectWhere as unknown as { rows: unknown[] }).rows = [];
    expect((await listPats("u1")).some((t) => t.id === entry.id)).toBe(true);
  });
});

describe("listPats", () => {
  it("merges DB rows but keeps listings per-owner", async () => {
    const { entry } = await createPat({ ownerId: "u1", name: "mine" });
    (mockSelectWhere as unknown as { rows: unknown[] }).rows = [
      seedRow({ ownerId: "u2", id: "row-other" }),
      seedRow({ ownerId: "u1", id: "row-own", keyHash: sha256hex(`nxk_${"c".repeat(48)}`) }),
    ];
    const listed = await listPats("u1");
    expect(listed.some((t) => t.id === entry.id)).toBe(true);
    expect(listed.some((t) => t.id === "row-own")).toBe(true);
    expect(listed.some((t) => t.id === "row-other")).toBe(false);
  });
});