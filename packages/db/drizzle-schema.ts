// SPDX-License-Identifier: Apache-2.0
/**
 * drizzle-schema.ts — flat schema bundle for drizzle-kit.
 *
 * drizzle-kit's internal TypeScript loader cannot resolve ".js"-suffixed
 * cross-imports (e.g. verdicts.ts → "./signals.js") because its CJS layer
 * maps ".js" to ".js", not to the ".ts" source.  This single-file bundle
 * defines every table in dependency order with no local imports, so
 * drizzle-kit processes it cleanly.
 *
 * Application code continues to use the individual files in src/schema/.
 * This file is referenced only from drizzle.config.ts.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ── ingested_events ────────────────────────────────────────────────────────────

export const ingestedEvents = pgTable(
  "ingested_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    metadata: jsonb("metadata"),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("ingested_events_source_idx").on(t.source),
    index("ingested_events_event_type_idx").on(t.eventType),
    index("ingested_events_created_at_idx").on(t.createdAt),
    uniqueIndex("ingested_events_idempotency_key_udx").on(t.idempotencyKey),
  ],
);

// ── signals ────────────────────────────────────────────────────────────────────

export const signals = pgTable(
  "signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    signalType: text("signal_type").notNull(),
    sourceEventIds: uuid("source_event_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    summary: text("summary").notNull(),
    priority: text("priority", { enum: ["low", "medium", "high", "critical"] })
      .notNull()
      .default("medium"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("signals_signal_type_idx").on(t.signalType),
    index("signals_priority_idx").on(t.priority),
    index("signals_created_at_idx").on(t.createdAt),
  ],
);

// ── verdicts ───────────────────────────────────────────────────────────────────

export const verdicts = pgTable(
  "verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    decision: text("decision", {
      enum: ["approve", "reject", "defer", "escalate"],
    }).notNull(),
    confidence: real("confidence").notNull(),
    rationale: text("rationale").notNull(),
    dissents: text("dissents")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    actions: jsonb("actions"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("verdicts_signal_id_idx").on(t.signalId),
    index("verdicts_decision_idx").on(t.decision),
    index("verdicts_created_at_idx").on(t.createdAt),
  ],
);

// ── council_transcripts ────────────────────────────────────────────────────────

export const councilTranscripts = pgTable(
  "council_transcripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    verdictId: uuid("verdict_id")
      .notNull()
      .unique()
      .references(() => verdicts.id, { onDelete: "cascade" }),
    turns: jsonb("turns").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("council_transcripts_verdict_id_idx").on(t.verdictId),
    index("council_transcripts_created_at_idx").on(t.createdAt),
  ],
);

// ── runtime_tasks ──────────────────────────────────────────────────────────────

export const runtimeTasks = pgTable(
  "runtime_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status", {
      enum: ["queued", "running", "completed", "failed", "cancelled", "awaiting_approval"],
    })
      .notNull()
      .default("queued"),
    priority: text("priority", { enum: ["low", "medium", "high"] })
      .notNull()
      .default("medium"),
    verdictId: uuid("verdict_id").references(() => verdicts.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key"),
    error: text("error"),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("runtime_tasks_status_idx").on(t.status),
    index("runtime_tasks_priority_idx").on(t.priority),
    index("runtime_tasks_type_idx").on(t.type),
    index("runtime_tasks_verdict_id_idx").on(t.verdictId),
    index("runtime_tasks_created_at_idx").on(t.createdAt),
    uniqueIndex("runtime_tasks_idempotency_key_udx").on(t.idempotencyKey),
  ],
);

// ── approval_requests ──────────────────────────────────────────────────────────

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: text("action").notNull(),
    requestor: text("requestor").notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected", "expired"] })
      .notNull()
      .default("pending"),
    resolution: text("resolution", { enum: ["approved", "rejected"] }),
    resolvedBy: text("resolved_by"),
    reason: text("reason"),
    context: jsonb("context"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
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

// ── audit_log ──────────────────────────────────────────────────────────────────

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: text("action").notNull(),
    actor: text("actor").notNull(),
    payload: jsonb("payload"),
    payloadHash: text("payload_hash").notNull(),
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

// ── memory_entries (requires pgvector extension) ───────────────────────────────

function vectorColumn(name: string, dimensions: number) {
  return customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(",")}]`;
    },
    fromDriver(value: string): number[] {
      return value
        .slice(1, -1)
        .split(",")
        .map((v) => parseFloat(v));
    },
  })(name);
}

export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: text("id").primaryKey(),
    text: text("text").notNull(),
    embedding: vectorColumn("embedding", 768).notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
  },
  (t) => [index("memory_entries_created_at_idx").on(t.createdAt)],
);

// ── api_keys ───────────────────────────────────────────────────────────────────

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    name: text("name").notNull(),
    ownerId: text("owner_id").notNull(),
    plan: text("plan", { enum: ["free", "pro", "enterprise"] })
      .notNull()
      .default("free"),
    monthlyQuota: integer("monthly_quota"),
    rpmLimit: integer("rpm_limit"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("api_keys_key_hash_udx").on(t.keyHash),
    index("api_keys_owner_id_idx").on(t.ownerId),
    index("api_keys_plan_idx").on(t.plan),
  ],
);

// ── usage_events ───────────────────────────────────────────────────────────────

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiKeyId: uuid("api_key_id").notNull(),
    endpoint: text("endpoint").notNull(),
    costUnits: integer("cost_units").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("usage_events_api_key_id_idx").on(t.apiKeyId),
    index("usage_events_created_at_idx").on(t.createdAt),
  ],
);

// ── subscriptions ──────────────────────────────────────────────────────────────

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    plan: text("plan", { enum: ["free", "pro", "enterprise"] }).notNull(),
    status: text("status", {
      enum: ["active", "past_due", "canceled", "trialing", "incomplete"],
    }).notNull(),
    currentPeriodEnd: bigint("current_period_end", { mode: "number" }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("subscriptions_stripe_sub_id_udx").on(t.stripeSubscriptionId),
    index("subscriptions_owner_id_idx").on(t.ownerId),
    index("subscriptions_stripe_customer_id_idx").on(t.stripeCustomerId),
  ],
);

// ── stripe_webhook_events ──────────────────────────────────────────────────────

export const stripeWebhookEvents = pgTable(
  "stripe_webhook_events",
  {
    stripeEventId: text("stripe_event_id").primaryKey(),
    eventType: text("event_type").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
    error: text("error"),
  },
  (t) => [
    index("stripe_webhook_events_event_type_idx").on(t.eventType),
    index("stripe_webhook_events_processed_at_idx").on(t.processedAt),
  ],
);
