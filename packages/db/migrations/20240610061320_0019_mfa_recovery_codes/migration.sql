-- SPDX-License-Identifier: Apache-2.0
-- Migration 0019: MFA recovery codes
--
-- SHA-256 hashes of single-use codes that stand in for an authenticator code at sign-in, so a
-- lost phone does not lock its owner out. A used code is removed from the array.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_recovery_codes" text[] NOT NULL DEFAULT '{}';
