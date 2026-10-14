<!-- SPDX-License-Identifier: Apache-2.0 -->

# Roadmap

Ordered by risk. Each line is one commit (or a small run of commits) with its test. Check the
box in the same commit that lands the item, and update the register status.

Push rule (public repository): push only once every critical and high item is fixed on the
branch, then after each later phase. Merging to `main` deploys to Render; that is an operator
decision.

## Phase 0 — Baseline and documents

- [x] Audit baseline recorded (`security-findings.md`)
- [x] Goals, requirements, architecture, design, roadmap, enrichment written

## Phase 1 — Critical and high

- [x] NX-SEC-001 Python sandbox in a child process (`lib/untrusted-python.ts`)
- [x] NX-SEC-002 Reset and verification tokens out of logs
- [x] NX-SEC-003 Safe SSO linking (`lib/sso-link.ts`), all three SSO paths
- [x] NX-SEC-004 GitHub identity from verified emails
- [x] NX-SEC-005 Teams webhook verifies the Bot Framework JWT; replies only to verified service URL
- [x] NX-SEC-007 Libertas ceilings
- [x] NX-FEAT-007 Route census test and allowlist
- [x] Push branch

## Phase 2 — Sessions and sign-in

- [x] NX-SEC-006 Persistent revocation (`lib/session-revocation.ts`), `sid` claim, both verifiers
- [x] NX-FEAT-002 `POST /auth/sessions/revoke-all`; session delete ends its access token
- [x] NX-SEC-017 Reset/verify single redemption; refresh reuse ends the family
- [x] NX-SEC-009 Sign-in state cookie
- [x] NX-SEC-010 Google `email_verified`; Slack identity and provisioning policy
- [x] NX-SEC-011 Account-wide guess ceiling in shared KV
- [x] NX-SEC-012 Remove `/mfa/validate`; TOTP replay guard
- [x] NX-SEC-019 JWT `exp` required
- [x] NX-SEC-020 SCIM constant-time compare; deprovision revokes
- [x] Push

## Phase 3 — Platform

- [x] NX-SEC-008 Slack raw-body verification; Slack/Telegram refuse without secrets; forwarder key
- [x] NX-SEC-015 Catalogue probe through `callerFetch`
- [x] NX-SEC-018 PTY sessions owner-scoped
- [x] NX-SEC-023 IPv6 embedded-IPv4 ranges in the SSRF guard
- [x] NX-SEC-026 GeoIP uses `request.ip`
- [x] NX-SEC-024 Upstash counter in one pipeline
- [x] NX-SEC-028 Brief share key derived from the API key, never a constant
- [x] NX-SEC-013 Desktop external links limited to http/https/mailto
- [x] NX-SEC-014 Compose binds to loopback; ingest key wired; ingest auth fails closed; scrape router behind key
- [x] NX-SEC-016 Dependency advisories cleared (overrides / bumps)
- [x] NX-SEC-022 CI `permissions: contents: read`
- [x] Push

## Phase 4 — Security features

- [x] NX-FEAT-001 Security check: `lib/security-posture.ts`, admin endpoint, CLI command, admin panel
- [x] NX-SEC-029 Audit key fallback reported by the security check
- [x] NX-FEAT-005 Audit events for security changes
- [x] NX-FEAT-003 Account security notifications
- [x] NX-FEAT-004 MFA recovery codes (migration, routes, login, UI)
- [x] NX-FEAT-008 CI advisory gate
- [x] Push

## Phase 5 — Second audit pass and documents

- [x] Audit org layer and workspace sharing
- [x] Audit worker job handlers and BullMQ payload trust
- [x] Audit plugin registry publish/run and marketplace content
- [x] Audit session sync
- [x] NX-SEC-027 Rewrite `docs/security/threat-model.md`
- [x] `docs/STATUS.md` behaviour-change notes for operators (webhook secrets now required, Libertas
      ceilings, SSO claim of unverified accounts)
- [x] Push

## Phase 6 — Account email

- [x] NX-FEAT-015 `lib/mailer.ts`, reset/verification/invitation/security mail, UI pages
- [x] NX-SEC-033 Email change needs the current password; old address told
- [x] `email-delivery` security check; Render and `.env.example` settings
- [x] Push

## Later (P2/P3 enrichment)

NX-FEAT-006, 010 and 012 are done (006 found NX-SEC-034 to NX-SEC-037); 014 is measured and deferred.
P3: 009, 011, 013. See [enrichment.md](enrichment.md).
