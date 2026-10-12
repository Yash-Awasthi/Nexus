-- SPDX-License-Identifier: Apache-2.0
-- Migration 0017: approval request ownership
--
-- Governance approvals had no owner, so any account could list, read, approve
-- or reject any other account's requests. Rows written before this migration
-- keep a NULL owner and are visible to no user; new rows belong to their creator.

ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "owner_id" text;

CREATE INDEX IF NOT EXISTS "approval_requests_owner_idx" ON "approval_requests" ("owner_id");
