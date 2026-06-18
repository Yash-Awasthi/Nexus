// SPDX-License-Identifier: Apache-2.0
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── users ─────────────────────────────────────────────────────────────────────

/**
 * users — platform user accounts.
 *
 * Passwords stored as Argon2id hashes (via crypto.scrypt when Argon2 unavailable).
 * Email is the unique identifier; sub (subject) is the UUID used in JWTs.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    /** Display name */
    name: text("name"),
    /** Platform role: owner | admin | member | viewer */
    role: text("role", { enum: ["owner", "admin", "member", "viewer"] })
      .notNull()
      .default("member"),
    /** Billing tier: free | pro | enterprise */
    tier: text("tier", { enum: ["free", "pro", "enterprise"] })
      .notNull()
      .default("free"),
    /** Whether email has been verified */
    emailVerified: boolean("email_verified").notNull().default(false),
    /** TOTP secret (base32) — null if MFA not enabled */
    totpSecret: text("totp_secret"),
    /** Whether TOTP MFA is active */
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    /** Stripe customer ID — set on first checkout */
    stripeCustomerId: text("stripe_customer_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** Set on soft-delete; excluded from normal queries */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("users_email_udx").on(t.email),
    index("users_tier_idx").on(t.tier),
    index("users_role_idx").on(t.role),
    index("users_stripe_customer_id_idx").on(t.stripeCustomerId),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// ── refresh_tokens ────────────────────────────────────────────────────────────

/**
 * refresh_tokens — opaque refresh token store.
 *
 * Raw refresh tokens are never stored.
 * token_hash = SHA-256(raw_token).
 * On /auth/refresh: validate hash, check not revoked/expired, rotate (revoke old, issue new).
 */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** SHA-256 hex of the raw refresh token */
    tokenHash: text("token_hash").notNull(),
    userId: uuid("user_id").notNull(),
    /** Revoked tokens are kept for audit purposes; lookups must check this */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Client hint: device or browser (optional, for session management UI) */
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("refresh_tokens_token_hash_udx").on(t.tokenHash),
    index("refresh_tokens_user_id_idx").on(t.userId),
    index("refresh_tokens_expires_at_idx").on(t.expiresAt),
  ],
);

export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;

// ── workspaces ────────────────────────────────────────────────────────────────

/**
 * workspaces — multi-tenant organisation units.
 *
 * A user can belong to multiple workspaces with different roles.
 * All resource lookups should be scoped to a workspace_id when present.
 */
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** URL-safe slug, unique across the platform */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** User ID of the workspace creator — always has "owner" role */
    ownerId: uuid("owner_id").notNull(),
    /** Billing tier inherited by members */
    tier: text("tier", { enum: ["free", "pro", "enterprise"] })
      .notNull()
      .default("free"),
    /** Stripe customer ID for workspace-level billing */
    stripeCustomerId: text("stripe_customer_id"),
    /** Optional: data residency region constraint */
    dataRegion: text("data_region"),
    /** Optional: custom domain for white-label deployments */
    customDomain: text("custom_domain"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("workspaces_slug_udx").on(t.slug),
    index("workspaces_owner_id_idx").on(t.ownerId),
  ],
);

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;

// ── workspace_members ─────────────────────────────────────────────────────────

/**
 * workspace_members — junction table: user ↔ workspace with role.
 *
 * Role hierarchy: owner > admin > member > viewer
 *   owner   — full control, billing, deletion
 *   admin   — manage members, settings, no billing
 *   member  — create resources, read all
 *   viewer  — read-only
 */
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role", { enum: ["owner", "admin", "member", "viewer"] })
      .notNull()
      .default("member"),
    /** Null until accepted; invitation sent to email */
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workspace_members_workspace_user_udx").on(t.workspaceId, t.userId),
    index("workspace_members_user_id_idx").on(t.userId),
    index("workspace_members_workspace_id_idx").on(t.workspaceId),
  ],
);

export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;

// ── workspace_invitations ─────────────────────────────────────────────────────

/**
 * workspace_invitations — pending email invitations to join a workspace.
 *
 * Token is a random 32-byte hex string; expires 72 hours after creation.
 */
export const workspaceInvitations = pgTable(
  "workspace_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    /** Email address the invitation was sent to */
    email: text("email").notNull(),
    role: text("role", { enum: ["admin", "member", "viewer"] }).notNull().default("member"),
    /** SHA-256 hex of the raw invitation token */
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: uuid("invited_by_user_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workspace_invitations_token_hash_udx").on(t.tokenHash),
    index("workspace_invitations_workspace_id_idx").on(t.workspaceId),
    index("workspace_invitations_email_idx").on(t.email),
  ],
);

export type WorkspaceInvitation = typeof workspaceInvitations.$inferSelect;
export type NewWorkspaceInvitation = typeof workspaceInvitations.$inferInsert;

// ── password_reset_tokens ─────────────────────────────────────────────────────

/**
 * password_reset_tokens — single-use time-limited tokens for password recovery.
 *
 * Raw tokens are never stored.
 * token_hash = SHA-256(raw_token).
 * Token expires 1 hour after creation; usedAt is set on redemption (single-use).
 */
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** SHA-256 hex of the raw reset token */
    tokenHash: text("token_hash").notNull(),
    userId: uuid("user_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Null until redeemed — single-use enforcement */
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("password_reset_tokens_token_hash_udx").on(t.tokenHash),
    index("password_reset_tokens_user_id_idx").on(t.userId),
    index("password_reset_tokens_expires_at_idx").on(t.expiresAt),
  ],
);

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;

// ── email_verification_tokens ─────────────────────────────────────────────────

/**
 * email_verification_tokens — one-time tokens for email address verification.
 *
 * token_hash = SHA-256(raw_token). Expires 24 hours after creation.
 * usedAt is set on redemption to enforce single-use.
 *
 * In dev/test the token is logged and returned in the API response so no
 * SMTP dependency is needed.
 */
export const emailVerificationTokens = pgTable(
  "email_verification_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** SHA-256 hex of the raw verification token */
    tokenHash: text("token_hash").notNull(),
    userId: uuid("user_id").notNull(),
    /** The email address this token was issued for (supports future email-change verify) */
    email: text("email").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Null until redeemed — single-use enforcement */
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("email_verification_tokens_token_hash_udx").on(t.tokenHash),
    index("email_verification_tokens_user_id_idx").on(t.userId),
    index("email_verification_tokens_email_idx").on(t.email),
  ],
);

export type EmailVerificationToken = typeof emailVerificationTokens.$inferSelect;
export type NewEmailVerificationToken = typeof emailVerificationTokens.$inferInsert;
