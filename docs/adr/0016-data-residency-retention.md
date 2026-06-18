<!-- SPDX-License-Identifier: Apache-2.0 -->

# 0016 — Data Residency and Retention

**Status:** Accepted (amended 2026-06-18 — phased implementation documented)
**Date:** 2026-06-11

## Context

NEXUS processes financial signals and AI deliberation transcripts that may contain PII or commercially sensitive information. Users need control over their data.

## Decision — Phased implementation

**Phase 1 (v1.0 — implemented):**
- `DELETE /api/v1/workspaces/:id` soft-deletes the workspace (`deleted_at` timestamp). Audit event `workspace.deleted` is emitted to the HMAC-chained audit log.
- Data residency: self-hosted by default — no data leaves the user's infrastructure unless explicitly configured (e.g., LLM provider API calls).
- Workspace schema has `deleted_at` column; deleted workspaces are excluded from all queries via `isNull(workspaces.deletedAt)`.

**Phase 2 (post-v1.0 — not yet implemented):**
- Hard delete worker job: BullMQ scheduled job purges soft-deleted workspace rows + cascade 30 days after `deleted_at`.
- Per-workspace retention policies: `workspace_settings` table with `retention_days` per data category (signals, verdicts, transcripts, audit_logs).
- Retention enforcement worker: nightly scan deletes rows older than policy threshold.

**Phase 3 (enterprise — future):**
- Column-level encryption for PII fields via `pgcrypto` AES-256-GCM.
- Right-to-erasure API endpoint (`POST /workspaces/:id/gdpr/erase`) for GDPR Article 17 compliance.

## Consequences

- v1 delivers soft-delete + audit trail. Full data lifecycle management is post-v1.
- Retention policies do not block feature development — no CI enforcement.
- Hard delete is irreversible once the worker runs — UI confirmation required (Phase 2).
- pgcrypto column encryption deferred — standard Postgres encryption + volume-level encryption suffices for v1.
