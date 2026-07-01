// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the drizzle SealedTokenStore adapter. These use a hand-rolled
 * fake db (no live Postgres) to lock the epoch-ms ↔ timestamptz mapping and the
 * column name shims. The live-DB path is exercised by the OAuth route
 * integration tests, which self-skip on missing DATABASE_URL.
 */
import { describe, it, expect } from "vitest";
import type { NexusDB } from "@nexus/db";
import type { SealedRecord } from "@nexus/llm-oauth";
import {
  DrizzleSealedTokenStore,
  dateToMs,
  msToDate,
  createOAuthTokenStore,
} from "../../src/lib/oauth-token-store.js";

/** Minimal drizzle-chain fake capturing the values written / rows returned. */
function fakeDb(opts: {
  selectRows?: unknown[];
  deleteRows?: unknown[];
  onValues?: (v: Record<string, unknown>) => void;
} = {}): NexusDB {
  return {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        opts.onValues?.(v);
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => opts.selectRows ?? [] }),
      }),
    }),
    delete: () => ({
      where: () => ({ returning: async () => opts.deleteRows ?? [] }),
    }),
  } as unknown as NexusDB;
}

const REC: SealedRecord = {
  userId: "u-1",
  providerId: "google-vertex",
  sealed: "base64-sealed-blob",
  expiresAt: 1_700_000_000_000,
  scope: "cloud-platform",
};

describe("epoch-ms ↔ Date mapping", () => {
  it("round-trips a timestamp", () => {
    expect(dateToMs(msToDate(1_700_000_000_000))).toBe(1_700_000_000_000);
  });

  it("preserves null in both directions", () => {
    expect(msToDate(null)).toBeNull();
    expect(dateToMs(null)).toBeNull();
    expect(msToDate(undefined)).toBeNull();
    expect(dateToMs(undefined)).toBeNull();
  });
});

describe("DrizzleSealedTokenStore", () => {
  it("upsert converts epoch-ms expiresAt to a Date and maps port fields to columns", async () => {
    let written: Record<string, unknown> | undefined;
    const store = new DrizzleSealedTokenStore(fakeDb({ onValues: (v) => (written = v) }));
    await store.upsert(REC);
    expect(written).toBeDefined();
    expect(written!.provider).toBe("google-vertex"); // providerId -> provider
    expect(written!.sealedTokens).toBe("base64-sealed-blob"); // sealed -> sealedTokens
    expect(written!.expiresAt).toBeInstanceOf(Date);
    expect((written!.expiresAt as Date).getTime()).toBe(1_700_000_000_000);
    expect(written!.lastRefreshedAt).toBeInstanceOf(Date);
  });

  it("upsert passes null expiresAt straight through", async () => {
    let written: Record<string, unknown> | undefined;
    const store = new DrizzleSealedTokenStore(fakeDb({ onValues: (v) => (written = v) }));
    await store.upsert({ ...REC, expiresAt: null });
    expect(written!.expiresAt).toBeNull();
  });

  it("get maps a DB row (Date expiresAt) back to the epoch-ms port shape", async () => {
    const row = {
      userId: "u-1",
      provider: "google-vertex",
      sealedTokens: "blob",
      expiresAt: new Date(1_700_000_000_000),
      scope: "cloud-platform",
    };
    const store = new DrizzleSealedTokenStore(fakeDb({ selectRows: [row] }));
    const rec = await store.get("u-1", "google-vertex");
    expect(rec).toEqual({
      userId: "u-1",
      providerId: "google-vertex",
      sealed: "blob",
      expiresAt: 1_700_000_000_000,
      scope: "cloud-platform",
    });
  });

  it("get returns null on a miss", async () => {
    const store = new DrizzleSealedTokenStore(fakeDb({ selectRows: [] }));
    expect(await store.get("u-1", "nope")).toBeNull();
  });

  it("get maps a null expiresAt column to null", async () => {
    const row = { userId: "u", provider: "p", sealedTokens: "b", expiresAt: null, scope: null };
    const store = new DrizzleSealedTokenStore(fakeDb({ selectRows: [row] }));
    expect((await store.get("u", "p"))!.expiresAt).toBeNull();
  });

  it("delete returns true when a row existed, false otherwise", async () => {
    const hit = new DrizzleSealedTokenStore(fakeDb({ deleteRows: [{ id: "x" }] }));
    expect(await hit.delete("u", "p")).toBe(true);
    const miss = new DrizzleSealedTokenStore(fakeDb({ deleteRows: [] }));
    expect(await miss.delete("u", "p")).toBe(false);
  });
});

describe("createOAuthTokenStore", () => {
  it("returns null when the dedicated vault key is unset (503 degrade signal)", () => {
    expect(createOAuthTokenStore({}, fakeDb())).toBeNull();
  });

  it("returns null when the vault key is invalid (wrong length)", () => {
    expect(createOAuthTokenStore({ NEXUS_OAUTH_VAULT_KEY: "too-short" }, fakeDb())).toBeNull();
  });

  it("builds a store when a valid 32-byte key is present", () => {
    const key = Buffer.alloc(32, 7).toString("hex"); // 64 hex chars = 32 bytes
    expect(createOAuthTokenStore({ NEXUS_OAUTH_VAULT_KEY: key }, fakeDb())).not.toBeNull();
  });
});
