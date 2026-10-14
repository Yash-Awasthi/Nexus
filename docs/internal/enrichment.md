<!-- SPDX-License-Identifier: Apache-2.0 -->

# Feature enrichment backlog

Features beyond the fixes, across the whole platform. Each has a priority (P1 do in this
program, P2 next, P3 when there is a reason), a status and the requirement it serves. Design for
P1 items is in [design.md](design.md).

| ID          | Feature                                                                | Priority | Status | Serves |
| ----------- | ---------------------------------------------------------------------- | -------- | ------ | ------ |
| NX-FEAT-001 | Security check: posture endpoint, `nexus security check`, admin panel  | P1       | done   | FR-1   |
| NX-FEAT-002 | Sign out everywhere / sign out one device ends access tokens           | P1       | done   | FR-2   |
| NX-FEAT-003 | Account security notifications                                         | P1       | done   | FR-3   |
| NX-FEAT-004 | MFA recovery codes                                                     | P1       | done   | FR-4   |
| NX-FEAT-005 | Security events in the hash-chained audit log                          | P1       | done   | FR-5   |
| NX-FEAT-006 | Cross-account isolation test over the live route table                 | P2       | done   | —      |
| NX-FEAT-007 | Route census test in CI (public `/api/v1` routes must be listed)       | P1       | done   | —      |
| NX-FEAT-008 | CI advisory gate (`pnpm audit --prod --audit-level high`)              | P1       | done   | FR-6   |
| NX-FEAT-009 | Passkeys (WebAuthn) as a second factor and passwordless sign-in        | P3       | open   | —      |
| NX-FEAT-010 | Per-PAT last-used time and IP, shown in the tokens page                | P2       | done   | —      |
| NX-FEAT-011 | Audit-log export to object storage with object lock (threat model T3)  | P3       | done   | —      |
| NX-FEAT-012 | Admin session viewer: list and revoke any user's sessions from the UI  | P2       | done   | —      |
| NX-FEAT-013 | Content-Security-Policy violation reporting endpoint                   | P3       | done   | —      |
| NX-FEAT-014 | Warm pool for the Python sandbox (removes the ~2 s cold boot)          | P2       | open   | —      |
| NX-FEAT-015 | Transactional email (SMTP or API) for reset, verification, invitations | P1       | done   | FR-3   |

## Notes per item

- **NX-FEAT-006.** Done as `apps/api/tests/security/cross-account.test.ts`: every collection with a
  create route and item routes gets a fixture or a written reason to skip, and a new one fails the
  test until it does. Found NX-SEC-034 to NX-SEC-037.
- **NX-FEAT-007.** Done as `apps/api/tests/security/public-routes.test.ts`: a test rather than a
  script, so CI runs it with the API suite and no new pipeline step is needed.
- **NX-FEAT-009.** Worth it once recovery codes exist; needs a WebAuthn verifier, which means a
  dependency or a careful CBOR/COSE implementation. Not this program.
- **NX-FEAT-010.** Done: migration 0020 adds `last_used_ip`; `verifyPat` takes the request IP and
  writes at most once a minute per token unless the address changes (`tests/lib/pat-store.test.ts`).
- **NX-FEAT-012.** Done with a user-side twin: `components/sessions-list.tsx` serves Profile and
  Admin → Users; tests in `tests/routes/admin-sessions.test.ts` and `e2e/sessions.spec.ts`.
- **NX-FEAT-014.** Measured 2026-10-14: ~2.2 s per run, almost all of it Pyodide start-up; one
  pre-booted child holds ~136 MB idle. Deferred while the deployment is a 512 MB free instance.
- **NX-FEAT-011.** Done as `lib/audit-export.ts`: the API copies new entries to
  `AUDIT_EXPORT_S3_*` every 10 minutes as JSONL, with a per-object COMPLIANCE lock when
  `AUDIT_EXPORT_RETAIN_DAYS` is set. It runs in the API so it works without a worker or Redis.
- **NX-FEAT-013.** Done as `POST /api/v1/csp-report` (`routes/csp-report.ts`): `report-uri` and
  `report-to` in the policy, both report formats, 16 KB bodies, 60 a minute per address, one log
  line per violation with query strings dropped.
- **NX-FEAT-015.** Resend's HTTP API over `fetch`, so no new dependency; SMTP waits until an
  operator needs it. Mails reset links, verification links (sent after sign-up), workspace
  invitations and every security notice (an email change tells the old address). UI pages:
  `/forgot-password`, `/reset-password`, `/verify-email`.
