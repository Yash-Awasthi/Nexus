// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoist DB mocks ─────────────────────────────────────────────────────────────

const {
  mockInsertReturning,
  mockInsertValues,
  mockInsert,
  mockSelectLimit,
  mockSelectWhere,
  mockSelect,
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
} = vi.hoisted(() => {
  const mockInsertReturning = vi.fn().mockResolvedValue([]);
  const mockInsertValues = vi.fn(() => ({ returning: mockInsertReturning }));
  const mockInsert = vi.fn(() => ({ values: mockInsertValues }));

  const mockSelectLimit = vi.fn().mockResolvedValue([]);
  const mockSelectWhere = vi.fn(() => ({ limit: mockSelectLimit }));
  const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockSelect = vi.fn(() => ({ from: mockSelectFrom }));

  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));

  return {
    mockInsertReturning,
    mockInsertValues,
    mockInsert,
    mockSelectLimit,
    mockSelectWhere,
    mockSelect,
    mockUpdateWhere,
    mockUpdateSet,
    mockUpdate,
  };
});

vi.mock("@nexus/db", () => ({
  db: { select: mockSelect, insert: mockInsert, update: mockUpdate },
}));

vi.mock("@nexus/db/schema", () => ({
  apiKeys: { keyHash: "keyHash", ownerId: "ownerId", id: "id" },
}));

vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { createApiKey, lookupApiKey, revokeApiKey, listApiKeys } from "../src/api-keys.js";

const FAKE_KEY = {
  id: "uuid-1",
  keyHash: "hash",
  keyPrefix: "nxk_abcd",
  name: "Test Key",
  ownerId: "user-1",
  plan: "free" as const,
  monthlyQuota: null,
  rpmLimit: null,
  createdAt: new Date(),
  revokedAt: null,
};

// ── createApiKey ──────────────────────────────────────────────────────────────

describe("createApiKey", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts a new key and returns rawKey + apiKey", async () => {
    mockInsertReturning.mockResolvedValueOnce([FAKE_KEY]);
    const result = await createApiKey({ name: "Test Key", ownerId: "user-1" });
    expect(result.rawKey).toMatch(/^nxk_[0-9a-f]{32}$/);
    expect(result.apiKey).toMatchObject({ id: "uuid-1", name: "Test Key" });
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it("throws when insert returns no rows", async () => {
    mockInsertReturning.mockResolvedValueOnce([]);
    await expect(createApiKey({ name: "Test", ownerId: "u1" })).rejects.toThrow(
      "Failed to create API key",
    );
  });

  it("stores pro plan and quota/rpm limits when provided", async () => {
    mockInsertReturning.mockResolvedValueOnce([{ ...FAKE_KEY, plan: "pro" }]);
    const result = await createApiKey({
      name: "Pro Key",
      ownerId: "u2",
      plan: "pro",
      monthlyQuota: 5000,
      rpmLimit: 100,
    });
    expect(result.apiKey.plan).toBe("pro");
  });
});

// ── lookupApiKey ──────────────────────────────────────────────────────────────

describe("lookupApiKey", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the key when found and not revoked", async () => {
    mockSelectLimit.mockResolvedValueOnce([FAKE_KEY]);
    const result = await lookupApiKey("nxk_abc123");
    expect(result).toMatchObject({ id: "uuid-1" });
  });

  it("returns undefined when key is not found in DB", async () => {
    mockSelectLimit.mockResolvedValueOnce([]);
    const result = await lookupApiKey("nxk_notfound");
    expect(result).toBeUndefined();
  });

  it("returns undefined when key is revoked", async () => {
    mockSelectLimit.mockResolvedValueOnce([{ ...FAKE_KEY, revokedAt: new Date() }]);
    const result = await lookupApiKey("nxk_revoked");
    expect(result).toBeUndefined();
  });
});

// ── revokeApiKey ──────────────────────────────────────────────────────────────

describe("revokeApiKey", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls db.update to set revokedAt on the given id", async () => {
    await revokeApiKey("uuid-1");
    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(mockUpdateSet).toHaveBeenCalledOnce();
    expect(mockUpdateWhere).toHaveBeenCalledOnce();
  });
});

// ── listApiKeys ───────────────────────────────────────────────────────────────

describe("listApiKeys", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns all keys for the given ownerId (no .limit() in the chain)", async () => {
    // listApiKeys awaits .where() directly (no .limit())
    mockSelectWhere.mockResolvedValueOnce([FAKE_KEY]);
    const result = await listApiKeys("user-1");
    expect(result).toHaveLength(1);
    expect(result[0]?.ownerId).toBe("user-1");
  });

  it("returns empty array when owner has no keys", async () => {
    mockSelectWhere.mockResolvedValueOnce([]);
    const result = await listApiKeys("user-nobody");
    expect(result).toEqual([]);
  });
});
