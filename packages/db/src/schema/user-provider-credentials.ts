// SPDX-License-Identifier: Apache-2.0
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── user_provider_credentials ───────────────────────────────────────────────────

/**
 * user_provider_credentials — per-user BYOK LLM provider API keys.
 *
 * Keys are encrypted at rest with AES-256-GCM (see apps/api secret-crypto);
 * `encrypted_key` holds base64(`[iv|tag|ciphertext]`). The raw key is NEVER
 * stored or returned over HTTP — only resolved server-side at request time.
 * `key_prefix` (first 8 chars) is shown in the UI; `key_hash` (SHA-256) supports
 * dedup. One active credential per (user, provider); rotation soft-deletes the old.
 */
export const userProviderCredentials = pgTable(
  "user_provider_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    /** Provider slug: openai | anthropic | groq | ... */
    provider: text("provider").notNull(),
    /** Optional user-friendly label */
    label: text("label"),
    /**
     * base64([iv|tag|ciphertext]) of the raw API key. Nullable: local/self-hosted
     * connections (e.g. ollama, custom base URLs) may have no key.
     */
    encryptedKey: text("encrypted_key"),
    /** First 8 chars of the raw key, for display */
    keyPrefix: text("key_prefix"),
    /** SHA-256 hex of the raw key, for dedup */
    keyHash: text("key_hash"),
    /** Optional base-URL override (local/self-hosted/custom providers) */
    baseUrl: text("base_url"),
    /** Enabled model ids for this connection (UI metadata, non-secret) */
    models: jsonb("models").$type<string[]>(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** Bumped whenever the key is resolved for an LLM request */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** Set on soft-delete (rotation/removal); excluded from normal queries */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // One live credential per (user, provider).
    uniqueIndex("user_provider_credentials_user_provider_udx")
      .on(t.userId, t.provider)
      .where(sql`${t.deletedAt} IS NULL`),
    index("user_provider_credentials_user_id_idx").on(t.userId),
  ],
);

export type UserProviderCredential = typeof userProviderCredentials.$inferSelect;
export type NewUserProviderCredential = typeof userProviderCredentials.$inferInsert;
