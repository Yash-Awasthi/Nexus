<!-- SPDX-License-Identifier: Apache-2.0 -->

# Feature enrichment backlog

Features beyond the fixes, across the whole platform. Each has a priority (P1 do in this
program, P2 next, P3 when there is a reason), a status and the requirement it serves. Design for
P1 items is in [design.md](design.md).

| ID          | Feature                                                               | Priority | Status | Serves |
| ----------- | --------------------------------------------------------------------- | -------- | ------ | ------ |
| NX-FEAT-001 | Security check: posture endpoint, `nexus security check`, admin panel | P1       | in-progress | FR-1   |
| NX-FEAT-002 | Sign out everywhere / sign out one device ends access tokens          | P1       | done   | FR-2   |
| NX-FEAT-003 | Account security notifications                                        | P1       | open   | FR-3   |
| NX-FEAT-004 | MFA recovery codes                                                    | P1       | open   | FR-4   |
| NX-FEAT-005 | Security events in the hash-chained audit log                         | P1       | open   | FR-5   |
| NX-FEAT-006 | Cross-account isolation test over the live route table                | P2       | open   | —      |
| NX-FEAT-007 | Route census test in CI (public `/api/v1` routes must be listed)      | P1       | done   | —      |
| NX-FEAT-008 | CI advisory gate (`pnpm audit --prod --audit-level high`)             | P1       | open   | FR-6   |
| NX-FEAT-009 | Passkeys (WebAuthn) as a second factor and passwordless sign-in       | P3       | open   | —      |
| NX-FEAT-010 | Per-PAT last-used time and IP, shown in the tokens page               | P2       | open   | —      |
| NX-FEAT-011 | Audit-log export to object storage with object lock (threat model T3) | P3       | open   | —      |
| NX-FEAT-012 | Admin session viewer: list and revoke any user's sessions from the UI | P2       | open   | —      |
| NX-FEAT-013 | Content-Security-Policy violation reporting endpoint                  | P3       | open   | —      |
| NX-FEAT-014 | Warm pool for the Python sandbox (removes the ~2 s cold boot)         | P2       | open   | —      |

## Notes per item

- **NX-FEAT-006.** Boot the app with two users, walk `app.printRoutes()` / the OpenAPI document,
  create a resource as user A where a POST exists, and assert user B's GET/PATCH/DELETE on its id
  answer 404/403. Turns the sampled IDOR review into a regression test. Needs per-route fixtures,
  so it starts with the store-backed bridge routes.
- **NX-FEAT-007.** Done as `apps/api/tests/security/public-routes.test.ts`: a test rather than a
  script, so CI runs it with the API suite and no new pipeline step is needed.
- **NX-FEAT-009.** Worth it once recovery codes exist; needs a WebAuthn verifier, which means a
  dependency or a careful CBOR/COSE implementation. Not this program.
- **NX-FEAT-010.** `api_keys` already has the row; add `last_used_at`, `last_used_ip`, update at
  most once a minute per key.
- **NX-FEAT-014.** Only after measuring that users notice the boot.
