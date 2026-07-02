// SPDX-License-Identifier: Apache-2.0
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  doublePrecision,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── api_keys ──────────────────────────────────────────────────────────────────

/**
 * api_keys — hashed API keys issued to callers.
 *
 * Raw keys are NEVER stored.  The server hashes the inbound key with SHA-256
 * and looks up the hash.  key_prefix (first 8 chars of the raw key) is stored
 * in plaintext so callers can identify their keys in dashboards.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** SHA-256 hex of the raw key — used for fast lookup */
    keyHash: text("key_hash").notNull(),
    /** First 8 chars of the raw key (e.g. "nxk_abc1") for display only */
    keyPrefix: text("key_prefix").notNull(),
    /** Human-readable label */
    name: text("name").notNull(),
    /** Owning user / organisation identifier */
    ownerId: text("owner_id").notNull(),
    /** Billing plan: free | pro | enterprise */
    plan: text("plan", { enum: ["free", "pro", "enterprise"] })
      .notNull()
      .default("free"),
    /** Max requests per calendar month (null = unlimited) */
    monthlyQuota: integer("monthly_quota"),
    /** Max requests per minute (null = no rate limit) */
    rpmLimit: integer("rpm_limit"),
    /**
     * BYOK spend-guard: max USD the user's own provider spend may reach this
     * calendar month (null = uncapped). Metered, never charged by Nexus.
     */
    monthlyCostCapUsd: doublePrecision("monthly_cost_cap_usd"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when the key is revoked; revoked keys are rejected immediately */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("api_keys_key_hash_udx").on(t.keyHash),
    index("api_keys_owner_id_idx").on(t.ownerId),
    index("api_keys_plan_idx").on(t.plan),
  ],
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

// ── usage_events ──────────────────────────────────────────────────────────────

/**
 * usage_events — per-request billing meter.
 *
 * Written by the quota middleware on every authenticated request.
 * Used for monthly quota aggregation and invoice line items.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiKeyId: uuid("api_key_id").notNull(),
    /** Endpoint path, e.g. "/api/v1/council/deliberate" */
    endpoint: text("endpoint").notNull(),
    /** Logical cost units (1 = one API call; more for heavy inference) */
    costUnits: integer("cost_units").notNull().default(1),
    /** Model id the call hit (null for non-inference endpoints). */
    model: text("model"),
    /** Prompt (input) tokens billed for this request. */
    promptTokens: integer("prompt_tokens").notNull().default(0),
    /** Completion (output) tokens billed for this request. */
    completionTokens: integer("completion_tokens").notNull().default(0),
    /** Prompt-cache read (hit) tokens. */
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    /** Prompt-cache write (store) tokens. */
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    /** USD cost of the call, priced from provider-registry at record time. */
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("usage_events_api_key_id_idx").on(t.apiKeyId),
    index("usage_events_created_at_idx").on(t.createdAt),
  ],
);

export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;

// ── subscriptions ─────────────────────────────────────────────────────────────

/**
 * subscriptions — Stripe subscription state synced via webhook.
 *
 * Created/updated by the Stripe webhook handler on:
 *   customer.subscription.created
 *   customer.subscription.updated
 *   customer.subscription.deleted
 */
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
    /** Unix timestamp of the current billing period end */
    currentPeriodEnd: bigint("current_period_end", { mode: "number" }),
    /** Whether the subscription auto-renews */
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

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;

// ── stripe_webhook_events ─────────────────────────────────────────────────────

/**
 * stripe_webhook_events — idempotency log for processed Stripe events.
 *
 * Before processing any webhook event we check this table; if the Stripe
 * event ID already exists we skip processing (Stripe guarantees at-least-once
 * delivery so duplicates are expected).
 */
export const stripeWebhookEvents = pgTable(
  "stripe_webhook_events",
  {
    /** Stripe event ID, e.g. "evt_1Px..." */
    stripeEventId: text("stripe_event_id").primaryKey(),
    eventType: text("event_type").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
    /** null = success, string = error message */
    error: text("error"),
  },
  (t) => [
    index("stripe_webhook_events_event_type_idx").on(t.eventType),
    index("stripe_webhook_events_processed_at_idx").on(t.processedAt),
  ],
);

export type StripeWebhookEvent = typeof stripeWebhookEvents.$inferSelect;
