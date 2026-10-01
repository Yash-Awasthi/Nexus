// SPDX-License-Identifier: Apache-2.0
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  bigint,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * audit_log — immutable HMAC-SHA256 chained audit trail (ADR-0010).
 *
 * Chain integrity:
 *   chain_hash = HMAC-SHA256(key=NEXUS_AUDIT_KEY, data=prev_chain_hash || payload_hash)
 *
 * Where:
 *   payload_hash = SHA-256( JSON.stringify(payload, sorted keys) )
 *   prev_chain_hash = chain_hash of the previous row (ordered by `sequence`)
 *                     The genesis entry uses GENESIS_SENTINEL as prev.
 *
 * Verification:
 *   Re-compute chain_hash for each entry in sequence order.
 *   Any mismatch indicates tampering or out-of-order insertion.
 *
 * Append-only enforcement:
 *   Application-level: the AuditLog service only exposes append + read.
 *   DB-level: a trigger (set in migration) prevents UPDATE and DELETE.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Monotonically increasing sequence number — the chain ordering key */
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    /** Type of the entity being audited, e.g. "task", "verdict", "approval" */
    entityType: text("entity_type").notNull(),
    /** ID of the audited entity in its respective table */
    entityId: uuid("entity_id").notNull(),
    /** The action that occurred, e.g. "task.completed", "approval.resolved" */
    action: text("action").notNull(),
    /** Identity of the agent/user that caused the action */
    actor: text("actor").notNull(),
    /** Full event payload at time of audit — JSONB for future indexing */
    payload: jsonb("payload"),
    /**
     * SHA-256 hex digest of the canonical payload (stable JSON with sorted keys).
     * Computed by the application before insert.
     */
    payloadHash: text("payload_hash").notNull(),
    /**
     * HMAC-SHA256 chain link:
     *   HMAC(key, prev_chain_hash || payload_hash)
     * Computed by the application before insert.
     * The genesis entry stores HMAC(key, GENESIS_SENTINEL || payload_hash).
     */
    chainHash: text("chain_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("audit_log_sequence_udx").on(t.sequence),
    index("audit_log_entity_idx").on(t.entityType, t.entityId),
    index("audit_log_action_idx").on(t.action),
    index("audit_log_actor_idx").on(t.actor),
    index("audit_log_created_at_idx").on(t.createdAt),
  ],
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;

/** The sentinel string used as the "previous hash" for the genesis entry */
export const GENESIS_SENTINEL = "NEXUS_AUDIT_CHAIN_GENESIS_V1";
