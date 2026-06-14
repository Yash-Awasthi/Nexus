<!-- SPDX-License-Identifier: Apache-2.0 -->

# 0016 — Data Residency and Retention

**Status:** Accepted
**Date:** 2026-06-11

## Context

NEXUS processes financial signals and AI deliberation transcripts that may contain PII or commercially sensitive information. Users need control over their data.

## Decision

- Per-workspace retention policies: admins configure how long signals, verdicts, transcripts, and audit logs are retained.
- Right-to-deletion: a `DELETE /v1/workspaces/:id` endpoint purges all workspace data (cascading deletes + pgvector cleanup) within 30 days.
- All data encrypted at rest (Postgres `pgcrypto` for sensitive columns; OS-level encryption for volumes).
- Data residency: self-hosted by default — no data leaves the user's infrastructure unless explicitly configured (e.g., OpenAI API calls).

## Consequences

- Retention policy enforcement requires a background worker job.
- Deletion is irreversible — the UI requires explicit confirmation.
- Encrypted columns cannot be searched with standard SQL predicates — application-layer decryption required.
