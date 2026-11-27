<!-- SPDX-License-Identifier: Apache-2.0 -->

# 0023 — Erasure that answers with a receipt, and an export that proves itself by what it leaves out

**Status:** Accepted
**Date:** 2026-11-25

## Context

Erasure existed (`DELETE /api/v1/users/:id/data`) and was correct: the cascade covers every user-scoped table, the
key-value stores, sessions, and the audit log survives it on purpose. What it did not do was answer the question
the person asked. `204 No Content` after deleting an account is a correct HTTP response and a bad product one.

Portability did not exist at all. An account could leave only by being deleted.

Both halves invite the same class of bug: **a route that looks like it takes data with it, and quietly returns
either too much or too little.** A positive-only test ("the export contains my email") passes on a route that dumps
the table.

## Decision

1. **Erasure returns `200` with a receipt**: rows removed per table, plus `RETAINED_AFTER_DELETION` — audit
   entries, billing records, earlier backups, aggregate counters, server logs — each with a sentence a support
   engineer can paste into a reply. The list is data in `apps/api/src/lib/user-export.ts`, so the response and the
   documentation cannot drift.
2. **Export lives at `GET /api/v1/users/:id/export`**, self-only, and returns one JSON archive. Every `SELECT`
   lists its columns, so a future secret column cannot join every export by default; credential-shaped fields in
   key-value records are scrubbed by **field name** (`scrubSecrets`), not by value-matching, so a new provider's
   key format is covered without a new regex.
3. **Both routes are self-only (403 otherwise).** A stolen admin token must not be able to export or erase an
   account through this pair; the operator path (`admin.user_deleted`) is separate and audited separately.
4. **Both write audit events** (`account.exported`, `account.erased`), added to the audit catalogue whose test
   reads the emitting file.
5. **The tests assert absences**: no password hash, no refresh-token hash, no provider key material or prefix, and
   nothing belonging to another account.

## Consequences

- Deleting an account is now a conversation-ending answer rather than a `204`, and the retained list is a written
  commitment that a reviewer can hold the product to.
- The export is deliberately not a ZIP of raw files: it is one JSON document with typed sections. Simpler to
  verify, simpler to diff, and it forces the "what is in here" question to be answered in code.
- Background/worker rows that carry no `userId` are outside the export by construction — the archive is built
  from ownership, not from a timestamp. A future store must declare its owner column to be included, which is the
  same rule `@nexus/db`'s erasure cascade already enforces.
