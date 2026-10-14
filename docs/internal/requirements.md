<!-- SPDX-License-Identifier: Apache-2.0 -->

# Requirements

`SR-*` are security requirements, `FR-*` are feature requirements. Each names the findings
(`NX-SEC-*`) or features (`NX-FEAT-*`) that satisfy it. "MUST" items block the program's
success criteria; "SHOULD" items are done unless a written reason says otherwise.

## Execution isolation

- **SR-1 (MUST)** User- or model-supplied code in any language runs in a child process with an
  empty environment, Node's permission model (or an equivalent container), no network, a memory
  cap and a wall-clock deadline that also stops synchronous loops. Nothing runs inside the API
  process. → NX-SEC-001
- **SR-2 (MUST)** No interpreter state is shared between two callers. → NX-SEC-001
- **SR-3 (SHOULD)** Host terminal sessions are visible and writable only by the account that
  started them. → NX-SEC-018

## Authentication and sessions

- **SR-10 (MUST)** One-time tokens (password reset, email verification) never appear in logs in
  any environment. → NX-SEC-002
- **SR-11 (MUST)** A sign-in through a third-party identity never lands in an existing account
  whose email address was not verified, unless that account is first stripped of every other way
  in (password, MFA secret, sessions). → NX-SEC-003
- **SR-12 (MUST)** Third-party identities are matched on an attribute the user cannot reassign to
  someone else (verified email or immutable provider id). → NX-SEC-004, NX-SEC-010
- **SR-13 (MUST)** Revoking sessions (password reset, admin suspend, role change, account
  deletion, sign out everywhere) rejects every access token issued before it within seconds, on
  every replica, across restarts. Every authenticated path checks it, not only some. → NX-SEC-006
- **SR-14 (SHOULD)** A sign-in callback completes only in the browser that started it.
  → NX-SEC-009
- **SR-15 (SHOULD)** Password guessing is bounded per account, not only per account-and-address.
  → NX-SEC-011
- **SR-16 (SHOULD)** No unauthenticated endpoint answers whether a code is valid for an account; a
  TOTP code is accepted once. → NX-SEC-012
- **SR-17 (SHOULD)** One-time tokens cannot be redeemed twice by concurrent requests; a replayed
  refresh token ends the session family. → NX-SEC-017
- **SR-18 (SHOULD)** Tokens without an expiry are rejected. → NX-SEC-019

## Unauthenticated surfaces

- **SR-20 (MUST)** Every platform webhook (Slack, Teams, Telegram) verifies the sender with the
  platform's mechanism over the exact bytes received, and refuses when the operator has not
  configured verification. → NX-SEC-005, NX-SEC-008
- **SR-21 (MUST)** No server credential is sent to a URL taken from a request. → NX-SEC-005
- **SR-22 (MUST)** A public endpoint that spends the operator's provider credits has a ceiling
  that does not depend on any header the caller writes or on the caller's address alone.
  → NX-SEC-007
- **SR-23 (SHOULD)** Client addresses come only from Fastify's `request.ip` (which honours
  `NEXUS_TRUST_PROXY`), never from a raw `X-Forwarded-For`. → NX-SEC-007, NX-SEC-026

## Outbound requests

- **SR-30 (MUST)** Every request to a URL that a user, a model or outside content chose goes
  through the pinned SSRF fetch (`pinnedFetch` / `callerFetch` / `fetchPublic`), so a hostname
  re-resolving to a private address is refused at connect time. → NX-SEC-015
- **SR-31 (SHOULD)** The private-address check covers IPv6 transition ranges that embed IPv4
  (NAT64, 6to4, IPv4-compatible). → NX-SEC-023

## Client applications

- **SR-40 (SHOULD)** The desktop shell hands only `http:`, `https:` and `mailto:` links to the
  operating system. → NX-SEC-013

## Supply chain and operations

- **SR-50 (MUST)** No production dependency with a known `high` or `critical` advisory that has a
  patched release in a compatible range. → NX-SEC-016
- **SR-51 (SHOULD)** CI jobs run with a read-only token unless they declare more.
  → NX-SEC-022
- **SR-52 (SHOULD)** The development compose file does not publish unauthenticated data stores on
  every interface, and the ingest service refuses requests when its key is unset outside
  development. → NX-SEC-014
- **SR-53 (SHOULD)** The threat model describes the code as it is. → NX-SEC-027

## Features

- **FR-1 (MUST)** Security check: an admin-only endpoint, a CLI command and an admin panel that
  list each posture check with pass, warn or fail and the setting that fixes it. → NX-FEAT-001
- **FR-2 (SHOULD)** Sign out everywhere, and sign out one device, end access tokens as well as
  refresh tokens. → NX-FEAT-002
- **FR-3 (SHOULD)** Account security notifications: new sign-in, password changed, email changed,
  MFA turned on or off, personal access token created. → NX-FEAT-003
- **FR-4 (SHOULD)** MFA recovery codes: ten single-use codes, stored hashed, shown once,
  regenerable. → NX-FEAT-004
- **FR-5 (SHOULD)** Security-relevant events (failed sign-in lockout, MFA changes, role changes,
  session revocations) are written to the hash-chained audit log. → NX-FEAT-005
- **FR-6 (SHOULD)** CI fails on a new `high` production advisory. → NX-FEAT-008
