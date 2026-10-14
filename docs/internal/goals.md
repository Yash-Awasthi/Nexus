<!-- SPDX-License-Identifier: Apache-2.0 -->

# Goals

## Why

Nexus runs model output, user code, third-party webhooks and outside web content inside one
server that also holds every operator secret and every user's provider keys. The cloud
deployment allows open registration, so "authenticated" means "anyone with an email address".
The codebase has had many careful hardening passes (exec policy, pinned SSRF fetch, child-process
JavaScript sandbox, secret store, SAML replay protection), but a baseline audit on 2026-10-14
found paths that bypass those controls entirely. The goal is to close them, prove they stay
closed, and give operators a way to see their deployment's security posture without reading
the source.

## Goals

1. **No registered user can reach operator secrets or run code on the host** unless an
   operator granted it. Every code path that executes user or model input runs in a process
   that has no secrets, no filesystem beyond what it needs, no network, a memory cap and a
   deadline.
2. **Identity is bound to proof.** An account is reachable only by someone who proved control of
   its email address or of a stable provider identity; sign-in flows cannot be replayed into
   another browser; revoking a session or resetting a password ends access everywhere within
   seconds, across restarts and replicas.
3. **Unauthenticated surfaces are authenticated or bounded.** Every webhook verifies its sender
   with the platform's real mechanism; every public endpoint has a cost ceiling an attacker cannot
   lift by changing a header or an address.
4. **Secrets never reach logs, responses or child processes** that do not need them.
5. **Operators can check their own deployment.** One endpoint, one CLI command and one admin
   panel report misconfigurations that weaken these guarantees (the security check).
6. **Account holders can see and control their security.** Sign-in and security-change
   notifications, sign out everywhere, recovery codes for MFA.
7. **Regressions are caught by tests**, not by the next audit: every fix ships with a test that
   fails without it.

## Success criteria

- Every `critical` and `high` finding in [security-findings.md](security-findings.md) is `fixed`
  with a named test, and every `medium` is `fixed` or `accepted` with a written reason.
- `pnpm test` passes for every touched workspace, and `pnpm typecheck` and `pnpm lint` pass.
- `GET /api/v1/admin/security/posture` reports a clean result on a correctly configured Render
  deployment and names each misconfiguration on a deliberately weakened one.
- `docs/security/threat-model.md` matches the code.

## Non-goals

- Rewriting working subsystems for style. A fix is the smallest change at the layer every caller
  routes through.
- Formal certification (SOC 2, ISO 27001). The audit log and controls support it; the paperwork
  is not this program.
- Adding paid tiers or gating features. Nexus stays free and bring-your-own-key.
- Protecting a desktop install from its own owner. On the desktop app the owner is the operator;
  controls there defend against hostile content (web pages, model output, imported files), not
  against the person at the keyboard.
- Replacing the in-process exec policy with an external policy engine.

## Constraints

- Node 24+ (repository runs on Node 26), pnpm 12, TypeScript strict, Fastify 5.
- Must keep working with no Redis (Postgres-backed shared KV fallback) and on the desktop app
  with embedded PGlite.
- No new runtime dependency where the standard library or an installed package covers the need.
- Behaviour changes that an operator must act on are written up in `docs/STATUS.md` in the
  style of the existing SSO behaviour-change note.
