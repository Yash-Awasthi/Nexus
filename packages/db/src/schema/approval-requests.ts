// SPDX-License-Identifier: Apache-2.0
import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * approval_requests — governance gate: humans or senior agents approve/reject
 * governed actions before execution.
 *
 * An approval request is created whenever the policy engine determines that a
 * verdict-derived action exceeds the autonomous execution boundary.  The
 * runtime task will be held in awaiting_approval status until the request
 * resolves or expires.
 */
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Type of entity requiring approval, e.g. "task", "verdict" */
    entityType: text("entity_type").notNull(),
    /** ID of the entity in its respective table */
    entityId: uuid("entity_id").notNull(),
    /** The governed action being requested, e.g. "email.send-to-external" */
    action: text("action").notNull(),
    /** Identity of the agent or user requesting the approval */
    requestor: text("requestor").notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected", "expired"] })
      .notNull()
      .default("pending"),
    /** Approval/rejection outcome — null while pending */
    resolution: text("resolution", { enum: ["approved", "rejected"] }),
    /** Identity of the human/agent that resolved the request */
    resolvedBy: text("resolved_by"),
    /** Optional human-readable justification for the resolution */
    reason: text("reason"),
    /** Contextual payload delivered with the approval notification */
    context: jsonb("context"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Null means no expiry; expired requests are swept by a scheduled job */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    index("approval_requests_entity_idx").on(t.entityType, t.entityId),
    index("approval_requests_status_idx").on(t.status),
    index("approval_requests_requestor_idx").on(t.requestor),
    index("approval_requests_created_at_idx").on(t.createdAt),
    index("approval_requests_expires_at_idx").on(t.expiresAt),
  ],
);

export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export type NewApprovalRequest = typeof approvalRequests.$inferInsert;
