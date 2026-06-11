// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import { fc } from "@fast-check/vitest";
import {
  AuditLog,
  MemoryAuditStore,
  GENESIS_SENTINEL,
  canonicalJson,
  hashPayload,
  computeChainHash,
  type AuditPayload,
} from "../src/audit-log.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_KEY = "a".repeat(64); // 32 bytes hex

function makePayload(overrides?: Partial<AuditPayload>): AuditPayload {
  return {
    entityType: "task",
    entityId: "00000000-0000-0000-0000-000000000001",
    action: "task.completed",
    actor: "nexus/runtime",
    ...overrides,
  };
}

// ─── Unit: crypto helpers ─────────────────────────────────────────────────────

describe("canonicalJson", () => {
  it("sorts keys deterministically", () => {
    const a = canonicalJson({ b: 1, a: 2 });
    const b = canonicalJson({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it("handles nested objects", () => {
    const result = canonicalJson({ z: { y: 1, x: 2 } });
    expect(result).toBe('{"z":{"x":"2","y":"1"}}');
  });

  it("handles arrays without sorting (arrays are ordered)", () => {
    const result = canonicalJson([3, 1, 2]);
    expect(result).toBe("[3,1,2]");
  });

  it("handles null", () => {
    expect(canonicalJson(null)).toBe("null");
  });
});

describe("hashPayload", () => {
  it("returns a 64-char hex string (SHA-256)", () => {
    const hash = hashPayload(makePayload());
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic for the same payload", () => {
    const p = makePayload();
    expect(hashPayload(p)).toBe(hashPayload(p));
  });

  it("differs for different payloads", () => {
    const a = hashPayload(makePayload({ action: "task.completed" }));
    const b = hashPayload(makePayload({ action: "task.failed" }));
    expect(a).not.toBe(b);
  });
});

describe("computeChainHash", () => {
  it("returns 64-char hex", () => {
    const h = computeChainHash(TEST_KEY, GENESIS_SENTINEL, "a".repeat(64));
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic", () => {
    const prev = "b".repeat(64);
    const payload = "c".repeat(64);
    expect(computeChainHash(TEST_KEY, prev, payload)).toBe(
      computeChainHash(TEST_KEY, prev, payload),
    );
  });

  it("changes when prevChainHash changes", () => {
    const payload = "d".repeat(64);
    const h1 = computeChainHash(TEST_KEY, "e".repeat(64), payload);
    const h2 = computeChainHash(TEST_KEY, "f".repeat(64), payload);
    expect(h1).not.toBe(h2);
  });

  it("changes when the HMAC key changes", () => {
    const prev = GENESIS_SENTINEL;
    const payload = "e".repeat(64);
    const h1 = computeChainHash("a".repeat(64), prev, payload);
    const h2 = computeChainHash("b".repeat(64), prev, payload);
    expect(h1).not.toBe(h2);
  });
});

// ─── Unit: AuditLog service ───────────────────────────────────────────────────

describe("AuditLog", () => {
  let store: MemoryAuditStore;
  let log: AuditLog;

  beforeEach(() => {
    store = new MemoryAuditStore();
    log = new AuditLog(store, TEST_KEY);
  });

  it("rejects a short HMAC key", () => {
    expect(() => new AuditLog(store, "short")).toThrow();
  });

  it("first append gets sequence 1", async () => {
    const result = await log.append(makePayload());
    expect(result.sequence).toBe(1);
  });

  it("sequences are monotonically increasing", async () => {
    const r1 = await log.append(makePayload({ action: "a" }));
    const r2 = await log.append(makePayload({ action: "b" }));
    const r3 = await log.append(makePayload({ action: "c" }));
    expect(r1.sequence).toBe(1);
    expect(r2.sequence).toBe(2);
    expect(r3.sequence).toBe(3);
  });

  it("chain_hash changes between entries", async () => {
    const r1 = await log.append(makePayload({ action: "a" }));
    const r2 = await log.append(makePayload({ action: "b" }));
    expect(r1.chainHash).not.toBe(r2.chainHash);
  });

  it("verifyAll returns valid=true for a clean log", async () => {
    await log.append(makePayload({ action: "x" }));
    await log.append(makePayload({ action: "y" }));
    await log.append(makePayload({ action: "z" }));
    const result = await log.verifyAll();
    expect(result.valid).toBe(true);
    expect(result.checkedCount).toBe(3);
  });

  it("verifyAll returns valid=true for empty log", async () => {
    const result = await log.verifyAll();
    expect(result.valid).toBe(true);
    expect(result.checkedCount).toBe(0);
  });

  it("detects chain_hash corruption", async () => {
    await log.append(makePayload({ action: "a" }));
    await log.append(makePayload({ action: "b" }));
    await log.append(makePayload({ action: "c" }));

    // Corrupt the second entry's chain_hash
    store._corruptAt(2);

    const result = await log.verifyAll();
    expect(result.valid).toBe(false);
    expect(result.firstBrokenSequence).toBe(2);
  });

  it("detects payload_hash corruption", async () => {
    await log.append(makePayload({ action: "a" }));
    await log.append(makePayload({ action: "b" }));

    // Corrupt the first entry's payload_hash
    store._corruptPayloadAt(1);

    const result = await log.verifyAll();
    expect(result.valid).toBe(false);
    expect(result.firstBrokenSequence).toBe(1);
  });

  it("verify with a partial range works", async () => {
    for (let i = 0; i < 5; i++) {
      await log.append(makePayload({ action: `action-${i}` }));
    }
    // Corrupt entry 4, verify only 1–3 — should still be valid
    store._corruptAt(4);
    const partial = await log.verify(1, 3);
    expect(partial.valid).toBe(true);
    expect(partial.checkedCount).toBe(3);
  });

  it("rejects invalid range", async () => {
    await expect(log.verify(5, 3)).rejects.toThrow(RangeError);
  });
});

// ─── Property-based: chain integrity ─────────────────────────────────────────

describe("AuditLog — property-based", () => {
  const payloadArb = fc.record({
    entityType: fc.constantFrom("task", "verdict", "approval", "signal"),
    entityId: fc.uuid(),
    action: fc.stringMatching(/^[a-z]+\.[a-z]+$/),
    actor: fc.constantFrom("nexus/runtime", "nexus/council", "nexus/governance", "human"),
    data: fc.option(fc.object(), { nil: undefined }),
  }) as fc.Arbitrary<AuditPayload>;

  it("N appends always produce a valid chain", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(payloadArb, { minLength: 1, maxLength: 20 }), async (payloads) => {
        const store = new MemoryAuditStore();
        const log = new AuditLog(store, TEST_KEY);
        for (const p of payloads) {
          await log.append(p);
        }
        const result = await log.verifyAll();
        expect(result.valid).toBe(true);
        expect(result.checkedCount).toBe(payloads.length);
      }),
      { numRuns: 50 },
    );
  });

  it("single payload corruption is always detected", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(payloadArb, { minLength: 3, maxLength: 15 }),
        fc.nat({ max: 2 }), // which entry to corrupt: 0=chain, 1=payload, 2=both
        async (payloads, corruptMode) => {
          const store = new MemoryAuditStore();
          const log = new AuditLog(store, TEST_KEY);
          for (const p of payloads) {
            await log.append(p);
          }

          // Corrupt the middle entry
          const corruptSeq = Math.ceil(payloads.length / 2);
          if (corruptMode === 0 || corruptMode === 2) store._corruptAt(corruptSeq);
          if (corruptMode === 1 || corruptMode === 2) store._corruptPayloadAt(corruptSeq);

          const result = await log.verifyAll();
          expect(result.valid).toBe(false);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("canonicalJson is injective over distinct objects (no collisions)", async () => {
    await fc.assert(
      fc.property(
        fc.record({ a: fc.integer(), b: fc.string() }),
        fc.record({ a: fc.integer(), b: fc.string() }),
        (obj1, obj2) => {
          if (obj1.a === obj2.a && obj1.b === obj2.b) return; // equal objects
          expect(canonicalJson(obj1)).not.toBe(canonicalJson(obj2));
        },
      ),
      { numRuns: 100 },
    );
  });
});
