// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic unit tests for the HMAC-chained audit log.
 *
 * These tests use only the in-memory MemoryAuditStore so they require no
 * database and no @fast-check — they run in the standard vitest unit job.
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  AuditLog,
  MemoryAuditStore,
  GENESIS_SENTINEL,
  canonicalJson,
  hashPayload,
  computeChainHash,
  type AuditPayload,
} from "../src/audit-log.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_KEY = "a".repeat(64); // 32 bytes as hex

function makePayload(overrides?: Partial<AuditPayload>): AuditPayload {
  return {
    entityType: "task",
    entityId: "00000000-0000-0000-0000-000000000001",
    action: "task.completed",
    actor: "nexus/runtime",
    ...overrides,
  };
}

// ── canonicalJson ─────────────────────────────────────────────────────────────

describe("canonicalJson", () => {
  it("serialises null", () => {
    expect(canonicalJson(null)).toBe("null");
  });

  it("serialises numbers", () => {
    expect(canonicalJson(42)).toBe("42");
  });

  it("serialises strings", () => {
    expect(canonicalJson("hello")).toBe('"hello"');
  });

  it("serialises arrays", () => {
    expect(canonicalJson([1, 2, 3])).toBe("[1,2,3]");
  });

  it("sorts object keys alphabetically", () => {
    const result = canonicalJson({ z: 1, a: 2, m: 3 });
    expect(result.indexOf('"a"')).toBeLessThan(result.indexOf('"m"'));
    expect(result.indexOf('"m"')).toBeLessThan(result.indexOf('"z"'));
  });

  it("produces identical output regardless of key insertion order", () => {
    const a = canonicalJson({ b: 1, a: 2 });
    const b = canonicalJson({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it("sorts nested object keys", () => {
    const result = canonicalJson({ outer: { z: 1, a: 2 } });
    const parsed = JSON.parse(result) as { outer: Record<string, number> };
    expect(Object.keys(parsed.outer)).toEqual(["a", "z"]);
  });
});

// ── hashPayload ───────────────────────────────────────────────────────────────

describe("hashPayload", () => {
  it("returns a 64-char hex string (SHA-256)", () => {
    const h = hashPayload(makePayload());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same payload", () => {
    const p = makePayload();
    expect(hashPayload(p)).toBe(hashPayload(p));
  });

  it("differs when payload changes", () => {
    expect(hashPayload(makePayload({ action: "a" }))).not.toBe(
      hashPayload(makePayload({ action: "b" })),
    );
  });

  it("is order-independent (uses canonicalJson)", () => {
    // Two payloads with same data but different JS key-insertion order
    // should hash identically because canonicalJson sorts keys.
    const h1 = hashPayload({ entityType: "t", entityId: "1", action: "x", actor: "y" });
    const h2 = hashPayload({ actor: "y", entityType: "t", action: "x", entityId: "1" });
    expect(h1).toBe(h2);
  });
});

// ── computeChainHash ──────────────────────────────────────────────────────────

describe("computeChainHash", () => {
  const prevHash = "b".repeat(64);
  const payloadHash = "c".repeat(64);

  it("returns a 64-char hex HMAC-SHA256", () => {
    const h = computeChainHash(TEST_KEY, prevHash, payloadHash);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const h1 = computeChainHash(TEST_KEY, prevHash, payloadHash);
    const h2 = computeChainHash(TEST_KEY, prevHash, payloadHash);
    expect(h1).toBe(h2);
  });

  it("differs when the key changes", () => {
    const h1 = computeChainHash(TEST_KEY, prevHash, payloadHash);
    const h2 = computeChainHash("b".repeat(64), prevHash, payloadHash);
    expect(h1).not.toBe(h2);
  });

  it("differs when prevChainHash changes", () => {
    const h1 = computeChainHash(TEST_KEY, "0".repeat(64), payloadHash);
    const h2 = computeChainHash(TEST_KEY, "1".repeat(64), payloadHash);
    expect(h1).not.toBe(h2);
  });

  it("accepts a Buffer key", () => {
    const buf = Buffer.from(TEST_KEY, "hex");
    const h = computeChainHash(buf, prevHash, payloadHash);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── AuditLog ──────────────────────────────────────────────────────────────────

describe("AuditLog", () => {
  let store: MemoryAuditStore;
  let log: AuditLog;

  beforeEach(() => {
    store = new MemoryAuditStore();
    log = new AuditLog(store, TEST_KEY);
  });

  // ── Constructor validation

  it("throws when hmacKey is empty", () => {
    expect(() => new AuditLog(store, "")).toThrow(/NEXUS_AUDIT_KEY/);
  });

  it("throws when hmacKey is too short", () => {
    expect(() => new AuditLog(store, "aabbcc")).toThrow(/NEXUS_AUDIT_KEY/);
  });

  it("constructs successfully with a 32+ char key", () => {
    expect(() => new AuditLog(store, TEST_KEY)).not.toThrow();
  });

  // ── append

  it("appends first entry at sequence 1", async () => {
    const result = await log.append(makePayload());
    expect(result.sequence).toBe(1);
  });

  it("increments sequence on each append", async () => {
    const r1 = await log.append(makePayload());
    const r2 = await log.append(makePayload({ action: "task.failed" }));
    expect(r2.sequence).toBe(r1.sequence + 1);
  });

  it("returns a chainHash of 64 hex chars", async () => {
    const result = await log.append(makePayload());
    expect(result.chainHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("consecutive chainHashes differ (each entry binds to the prior)", async () => {
    const r1 = await log.append(makePayload());
    const r2 = await log.append(makePayload({ action: "task.failed" }));
    expect(r1.chainHash).not.toBe(r2.chainHash);
  });

  // ── verify

  it("verifyAll on empty log returns valid with checkedCount 0", async () => {
    const result = await log.verifyAll();
    expect(result.valid).toBe(true);
    expect(result.checkedCount).toBe(0);
  });

  it("verifyAll on a valid 3-entry chain returns valid", async () => {
    await log.append(makePayload());
    await log.append(makePayload({ action: "task.failed" }));
    await log.append(makePayload({ action: "user.created" }));
    const result = await log.verifyAll();
    expect(result.valid).toBe(true);
    expect(result.checkedCount).toBe(3);
  });

  it("verify(1, 1) on a single entry returns valid", async () => {
    await log.append(makePayload());
    const result = await log.verify(1, 1);
    expect(result.valid).toBe(true);
  });

  it("verify throws RangeError when fromSequence > toSequence", async () => {
    await expect(log.verify(5, 3)).rejects.toThrow(RangeError);
  });

  it("verify on empty range returns valid with checkedCount 0", async () => {
    await log.append(makePayload());
    const result = await log.verify(999, 1000);
    expect(result.valid).toBe(true);
    expect(result.checkedCount).toBe(0);
  });

  // ── tamper detection

  it("detects a corrupted chainHash", async () => {
    await log.append(makePayload());
    await log.append(makePayload({ action: "task.failed" }));
    store._corruptAt(1);
    const result = await log.verifyAll();
    expect(result.valid).toBe(false);
    expect(result.firstBrokenSequence).toBe(1);
  });

  it("detects a corrupted payloadHash", async () => {
    await log.append(makePayload());
    store._corruptPayloadAt(1);
    const result = await log.verifyAll();
    expect(result.valid).toBe(false);
  });

  // ── range query

  it("range returns the correct slice of entries", async () => {
    for (let i = 0; i < 5; i++) await log.append(makePayload({ action: `step-${i}` }));
    const entries = await log.range(2, 4);
    expect(entries).toHaveLength(3);
    expect(entries[0]?.sequence).toBe(2);
    expect(entries[2]?.sequence).toBe(4);
  });

  // ── genesis sentinel

  it("first entry uses GENESIS_SENTINEL as prevChainHash", async () => {
    const r = await log.append(makePayload());
    const payloadHash = hashPayload(makePayload());
    const expectedChain = computeChainHash(
      Buffer.from(TEST_KEY, "hex"),
      GENESIS_SENTINEL,
      payloadHash,
    );
    expect(r.chainHash).toBe(expectedChain);
  });
});

// ── MemoryAuditStore ──────────────────────────────────────────────────────────

describe("MemoryAuditStore", () => {
  it("latestSequence returns 0 when empty", async () => {
    const store = new MemoryAuditStore();
    expect(await store.latestSequence()).toBe(0);
  });

  it("chainHashAt returns undefined for missing sequence", async () => {
    const store = new MemoryAuditStore();
    expect(await store.chainHashAt(99)).toBeUndefined();
  });
});
