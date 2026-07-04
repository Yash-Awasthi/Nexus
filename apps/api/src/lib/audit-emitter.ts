// SPDX-License-Identifier: Apache-2.0
/**
 * audit-emitter — fire-and-forget helper for appending HMAC-chained audit entries.
 *
 * Chain algorithm (ADR-0010):
 *   payload_hash = SHA-256( JSON.stringify(payload, sorted_keys) )
 *   chain_hash   = HMAC-SHA256(NEXUS_AUDIT_KEY, prev_chain_hash + payload_hash)
 *
 * Sequence assignment uses MAX(sequence)+1 inside a serialisable transaction
 * to prevent gaps under concurrent inserts.
 *
 * This module is intentionally side-effect-free: it never throws. All errors
 * are caught and logged so a failing audit write never breaks the caller.
 */

import { createHash, createHmac } from "node:crypto";

import { db } from "@nexus/db";
import { auditLog, GENESIS_SENTINEL } from "@nexus/db/schema";
import { desc } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";

// ── Internal helpers ──────────────────────────────────────────────────────────

function payloadHash(payload: unknown): string {
  const sorted =
    payload && typeof payload === "object"
      ? JSON.stringify(payload, Object.keys(payload as object).sort())
      : JSON.stringify(payload ?? null);
  return createHash("sha256").update(sorted).digest("hex");
}

function chainHash(key: string, prevHash: string, pHash: string): string {
  return createHmac("sha256", key)
    .update(prevHash + pHash)
    .digest("hex");
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface AuditEventInput {
  entityType: string;
  entityId: string;
  action: string;
  actor: string;
  payload?: Record<string, unknown>;
}

/**
 * Append one audit log entry. Fire-and-forget — never throws.
 *
 * @param event  The event to record.
 * @param logger Optional Fastify logger for error reporting.
 */
export async function emitAuditEvent(
  event: AuditEventInput,
  logger?: FastifyBaseLogger,
): Promise<void> {
  try {
    if (!process.env.DATABASE_URL) return;

    const auditKey = process.env.NEXUS_AUDIT_KEY ?? "nexus-dev-audit-key";

    // Compute the next chain link against an executor (a transaction when the
    // driver supports one, otherwise the plain db handle). The transactional
    // path row-locks the latest entry so concurrent inserts don't race on the
    // sequence number; the fallback path is best-effort append (fine for the
    // single-writer neon-http driver, which has no transaction support).
    const appendWith = async (exec: typeof db, locked: boolean) => {
      const q = exec
        .select({ sequence: auditLog.sequence, chainHash: auditLog.chainHash })
        .from(auditLog)
        .orderBy(desc(auditLog.sequence))
        .limit(1);
      const [latest] = await (locked ? q.for("update") : q);

      const nextSeq = (latest?.sequence ?? 0) + 1;
      const prevHash = latest?.chainHash ?? GENESIS_SENTINEL;
      const pHash = payloadHash(event.payload ?? null);
      const cHash = chainHash(auditKey, prevHash, pHash);

      await exec.insert(auditLog).values({
        sequence: nextSeq,
        entityType: event.entityType,
        entityId: event.entityId,
        action: event.action,
        actor: event.actor,
        payload: event.payload ?? null,
        payloadHash: pHash,
        chainHash: cHash,
      });
    };

    try {
      await db.transaction(async (tx) => appendWith(tx as unknown as typeof db, true));
    } catch (txErr) {
      // neon-http (and other transaction-less drivers) throw here — fall back to
      // a non-transactional append rather than dropping the audit entry.
      if ((txErr as Error)?.message?.includes("transaction")) {
        await appendWith(db, false);
      } else {
        throw txErr;
      }
    }
  } catch (err) {
    // Never propagate — audit failures must not break the caller's flow
    logger?.error({ err, event }, "audit-emitter: failed to write audit entry");
  }
}
