// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/governance — HMAC-chained audit log (ADR-0010)
 *
 * Every write produces a chain_hash that cryptographically binds the new
 * entry to all previous entries:
 *
 *   payload_hash  = SHA-256( canonicalJson(payload) )
 *   chain_hash    = HMAC-SHA256( NEXUS_AUDIT_KEY, prevChainHash || payload_hash )
 *
 * The genesis entry uses GENESIS_SENTINEL as prevChainHash.
 *
 * Verification reads all entries in sequence order and re-derives each
 * chain_hash; any mismatch indicates either tampering or a missing entry.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AuditPayload {
  entityType: string;
  entityId: string;
  action: string;
  actor: string;
  data?: Record<string, unknown>;
}

export interface AuditEntry {
  id: string;
  sequence: number;
  entityType: string;
  entityId: string;
  action: string;
  actor: string;
  payload: AuditPayload;
  payloadHash: string;
  chainHash: string;
  createdAt: Date;
}

export interface AuditWriteResult {
  id: string;
  sequence: number;
  chainHash: string;
}

export interface VerifyResult {
  valid: boolean;
  checkedCount: number;
  /** Populated only when valid=false */
  firstBrokenSequence?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const GENESIS_SENTINEL = "NEXUS_AUDIT_CHAIN_GENESIS_V1";

// ─── Storage adapter interface ────────────────────────────────────────────────

/**
 * AuditStore — minimal persistence interface.
 *
 * The concrete implementation wires to Drizzle / Postgres.
 * A test double (MemoryAuditStore below) enables property-based testing
 * without a live DB.
 */
export interface AuditStore {
  /** Return the current max sequence (0 if empty). */
  latestSequence(): Promise<number>;
  /** Return the chain_hash of the entry at `sequence` (undefined if genesis). */
  chainHashAt(sequence: number): Promise<string | undefined>;
  /** Persist a new entry. Must be atomic w.r.t. sequence uniqueness. */
  append(entry: Omit<AuditEntry, "id" | "createdAt">): Promise<AuditWriteResult>;
  /** Return entries in sequence order for the given range [from, to] inclusive. */
  range(from: number, to: number): Promise<AuditEntry[]>;
}

// ─── Crypto helpers ──────────────────────────────────────────────────────────

/**
 * Canonical JSON: sorted keys, no extra whitespace.
 * Ensures the same payload always produces the same bytes regardless of
 * insertion-time key ordering.
 */
function normalise(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return JSON.stringify(obj); // primitives → their JSON string form
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = normalise((obj as Record<string, unknown>)[key]);
  }
  return sorted; // objects returned as value, not string
}
export function canonicalJson(obj: unknown): string {
  // Top-level null, array, or primitive: standard JSON serialisation
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return JSON.stringify(obj);
  }
  // Plain object: sort keys recursively, stringify primitive leaf values
  return JSON.stringify(normalise(obj));
}

/** SHA-256 hex of the canonical JSON encoding of `payload`. */
export function hashPayload(payload: AuditPayload): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

/**
 * HMAC-SHA256 chain link.
 *   HMAC(key, prevChainHash || payloadHash)
 *
 * Both inputs are fixed-length hex strings (64 chars each), so concatenation
 * is unambiguous — no length-extension risk.
 */
export function computeChainHash(
  hmacKey: string | Buffer,
  prevChainHash: string,
  payloadHash: string,
): string {
  return createHmac("sha256", hmacKey)
    .update(prevChainHash + payloadHash, "utf8")
    .digest("hex");
}

// ─── AuditLog service ────────────────────────────────────────────────────────

export class AuditLog {
  private readonly hmacKey: Buffer;

  constructor(
    private readonly store: AuditStore,
    hmacKeyHex: string,
  ) {
    if (!hmacKeyHex || hmacKeyHex.length < 32) {
      throw new Error(
        "NEXUS_AUDIT_KEY must be at least 32 hex characters (16 bytes). " +
          "Generate with: openssl rand -hex 32",
      );
    }
    this.hmacKey = Buffer.from(hmacKeyHex, "hex");
  }

  /**
   * Append a new audit entry and return its id, sequence, and chain_hash.
   *
   * The call is idempotent at the application level only if the caller
   * supplies a deduplication mechanism (e.g. entityType+entityId+action
   * uniqueness check) — the audit log itself does NOT deduplicate.
   */
  async append(payload: AuditPayload): Promise<AuditWriteResult> {
    const latestSeq = await this.store.latestSequence();
    const sequence = latestSeq + 1;

    const prevChainHash =
      latestSeq === 0
        ? GENESIS_SENTINEL
        : ((await this.store.chainHashAt(latestSeq)) ?? GENESIS_SENTINEL);

    const payloadHash = hashPayload(payload);
    const chainHash = computeChainHash(this.hmacKey, prevChainHash, payloadHash);

    const entry: Omit<AuditEntry, "id" | "createdAt"> = {
      sequence,
      entityType: payload.entityType,
      entityId: payload.entityId,
      action: payload.action,
      actor: payload.actor,
      payload,
      payloadHash,
      chainHash,
    };

    return this.store.append(entry);
  }

  /**
   * Verify chain integrity from `fromSequence` to `toSequence`.
   *
   * Reads all entries in range, re-computes each chain_hash from scratch,
   * and compares using timing-safe equality to prevent timing attacks.
   */
  async verify(fromSequence: number, toSequence: number): Promise<VerifyResult> {
    if (fromSequence > toSequence) {
      throw new RangeError(`fromSequence (${fromSequence}) must be ≤ toSequence (${toSequence})`);
    }

    const entries = await this.store.range(fromSequence, toSequence);
    if (entries.length === 0) {
      return { valid: true, checkedCount: 0 };
    }

    // Determine the starting prevChainHash — the hash at (fromSequence - 1)
    let prevChainHash: string;
    if (fromSequence === 1) {
      prevChainHash = GENESIS_SENTINEL;
    } else {
      prevChainHash = (await this.store.chainHashAt(fromSequence - 1)) ?? GENESIS_SENTINEL;
    }

    for (const entry of entries) {
      const expectedHash = computeChainHash(this.hmacKey, prevChainHash, entry.payloadHash);

      // Re-derive payloadHash from the stored payload for tamper detection
      const recomputedPayloadHash = hashPayload(entry.payload);
      if (recomputedPayloadHash !== entry.payloadHash) {
        return {
          valid: false,
          checkedCount: entries.indexOf(entry),
          firstBrokenSequence: entry.sequence,
        };
      }

      // Timing-safe comparison of the chain hash
      const expectedBuf = Buffer.from(expectedHash, "hex");
      const actualBuf = Buffer.from(entry.chainHash, "hex");
      if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
        return {
          valid: false,
          checkedCount: entries.indexOf(entry),
          firstBrokenSequence: entry.sequence,
        };
      }

      prevChainHash = entry.chainHash;
    }

    return { valid: true, checkedCount: entries.length };
  }

  /** Convenience: verify the entire log from genesis. */
  async verifyAll(): Promise<VerifyResult> {
    const latest = await this.store.latestSequence();
    if (latest === 0) return { valid: true, checkedCount: 0 };
    return this.verify(1, latest);
  }

  /** Query entries — thin wrapper over the store. */
  async range(from: number, to: number): Promise<AuditEntry[]> {
    return this.store.range(from, to);
  }
}

// ─── In-memory store (for tests and dev) ────────────────────────────────────

export class MemoryAuditStore implements AuditStore {
  private entries: AuditEntry[] = [];

  async latestSequence(): Promise<number> {
    return this.entries.length === 0 ? 0 : (this.entries[this.entries.length - 1]?.sequence ?? 0);
  }

  async chainHashAt(sequence: number): Promise<string | undefined> {
    return this.entries.find((e) => e.sequence === sequence)?.chainHash;
  }

  async append(entry: Omit<AuditEntry, "id" | "createdAt">): Promise<AuditWriteResult> {
    const full: AuditEntry = {
      ...entry,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    this.entries.push(full);
    return { id: full.id, sequence: full.sequence, chainHash: full.chainHash };
  }

  async range(from: number, to: number): Promise<AuditEntry[]> {
    return this.entries.filter((e) => e.sequence >= from && e.sequence <= to);
  }

  /** Test helper: directly corrupt an entry's chain_hash */
  _corruptAt(sequence: number): void {
    const entry = this.entries.find((e) => e.sequence === sequence);
    if (entry) entry.chainHash = "0".repeat(64);
  }

  /** Test helper: directly corrupt an entry's payload_hash */
  _corruptPayloadAt(sequence: number): void {
    const entry = this.entries.find((e) => e.sequence === sequence);
    if (entry) entry.payloadHash = "f".repeat(64);
  }
}
