<!-- SPDX-License-Identifier: Apache-2.0 -->
# 0010 — Audit Log is HMAC-Chained

**Status:** Accepted
**Date:** 2026-06-11

## Context
NEXUS makes decisions that affect real systems (deploy, send email, post to Slack, create Linear tickets). These decisions must be auditable and tamper-evident — especially when an approval workflow is involved.

## Decision
Every governance decision, adapter execution, and approval event is written to an append-only `audit_log` table. Each row contains `(id, workspace_id, prev_hash, hash, event, payload, ts)` where `hash = HMAC_SHA256(secret, prev_hash || canonical_json(payload))`. `verifyAuditChain(workspaceId)` walks the chain and reports the first tampered index.

## Consequences
- Tampered or deleted audit rows are detectable.
- The HMAC secret must be rotated carefully (rotation invalidates old chains unless re-signed).
- Export of the audit log carries the full chain for offline verification.
