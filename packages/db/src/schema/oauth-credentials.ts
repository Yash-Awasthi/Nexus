// SPDX-License-Identifier: Apache-2.0
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── oauth_credentials ───────────────────────────────────────────────────────────

/**
 * oauth_credentials — per-user OAuth tokens for providers authed via
 * @nexus/llm-oauth (e.g. Google Cloud → Vertex).
 *
 * The whole token bundle (access + refresh + expiry) is sealed as a single
 * AES-256-GCM blob: `sealed_tokens` holds base64(`[iv|tag|ciphertext]`) of
 * JSON(OAuthTokens), wire-compatible with the BYOK secret-crypto vault. The
 * refresh token — the only long-lived secret — is NEVER stored in the clear and
 * NEVER returned over HTTP. `scope` and `expires_at` are non-secret mirrors kept
 * as plain columns so "expiring soon" can be queried without decrypting.
 *
 * One live credential per (user, provider). Per the token-vault security review
 * (packages/llm-oauth/SECURITY.md §7), revocation is a HARD DELETE — there is no
 * soft-delete column, because a soft-deleted sealed token is still a live grant.
 */
export const oauthCredentials = pgTable(
  "oauth_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    /** AuthProvider.id, e.g. "google-vertex". */
    provider: text("provider").notNull(),
    /** base64([iv|tag|ciphertext]) of JSON(OAuthTokens) — access + refresh + expiry. */
    sealedTokens: text("sealed_tokens").notNull(),
    /** Non-secret granted scope, for display/diagnostics. */
    scope: text("scope"),
    /** Non-secret access-token expiry mirror (the secret copy is inside sealed_tokens). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** Bumped whenever the access token is refreshed and re-sealed. */
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
  },
  (t) => [
    // One live OAuth credential per (user, provider). Revoke hard-deletes the row.
    uniqueIndex("oauth_credentials_user_provider_udx").on(t.userId, t.provider),
    index("oauth_credentials_user_id_idx").on(t.userId),
  ],
);

export type OAuthCredential = typeof oauthCredentials.$inferSelect;
export type NewOAuthCredential = typeof oauthCredentials.$inferInsert;
