<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security findings register

Baseline: `main` at `c9d4a19`, 2026-10-14. Conventions are in [README.md](README.md).

## Audit coverage

| Area                                                        | Depth at baseline | Notes                                                                     |
| ----------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------- |
| API bootstrap, route scopes, auth middleware, `@nexus/auth` | Full              |                                                                           |
| Register / login / refresh / reset / verify / sessions      | Full              |                                                                           |
| OAuth (Google, GitHub, Slack), OIDC, SAML, SCIM, MFA        | Full              |                                                                           |
| Route census: `/api/v1` routes without a `preHandler`       | Full (script)     | Re-run after adding routes, see below                                     |
| Exec surfaces: sandbox, PTC, drive, PTY, skills, workflows  | Full              | Org CLI runtimes read for env handling only                               |
| SSRF guard and outbound fetch call sites in api and worker  | Full              | Packages' own fetches only where a user URL reaches them                  |
| Bots (Slack, Teams, Telegram), Libertas                     | Full              |                                                                           |
| IDOR in `api-bridge.ts` (sampled ~40 id-param handlers)     | Sampled           | Consistent owner checks; a full automated pass is NX-FEAT-006             |
| Org layer (`org-*.ts`), workspaces sharing                  | Not yet           | Next audit pass                                                           |
| Worker job handlers, BullMQ payload trust                   | Not yet           | Next audit pass                                                           |
| Connectors, MCP client/servers, plugin registry/run         | Partial           | MCP servers SSRF checked; plugin publish/run not yet                      |
| Session sync (desktop ↔ cloud)                              | Not yet           |                                                                           |
| UI (XSS sinks, link handling, token storage)                | Full (grep)       | React 19 blocks `javascript:` hrefs; one static `dangerouslySetInnerHTML` |
| Desktop shell                                               | Partial           | Window prefs, navigation, IPC entry                                       |
| Python ingest service                                       | Partial           | Auth, crawl fetch                                                         |
| CI workflows, compose files, Dockerfiles                    | Partial           |                                                                           |
| Dependencies (`pnpm audit --prod`)                          | Full              | 51 advisories: 21 high, 23 moderate, 7 low                                |

Route census: `apps/api/tests/security/public-routes.test.ts` builds the server, lists every
`/api/v1` route without a `require*` preHandler and fails unless it is on the test's allowlist
(and fails when a listed route gains a guard, so the list stays exact). It runs with the API suite.

## Summary

| Severity | Open | Fixed | Accepted |
| -------- | ---- | ----- | -------- |
| Critical | 0    | 1     | 0        |
| High     | 0    | 5     | 0        |
| Medium   | 5    | 8     | 0        |
| Low      | 4    | 4     | 2        |

## Findings

### NX-SEC-001 — Python sandbox runs inside the API process

- **Severity:** critical · **Status:** fixed
- **Evidence:** `apps/api/src/routes/sandbox.ts:131` `runViaPyodide` loads Pyodide with
  `loadPyodide()` in the API process and keeps one interpreter for every caller; used by
  `POST /api/sandbox/execute` (Python, the default when `PISTON_URL` is unset) and by the code
  agent (`apps/api/src/routes/api-bridge.ts:2716`).
- **Impact:** Pyodide's `js` module is the host's `globalThis`. Any signed-in account (open
  registration in the cloud) can read `process.env` — JWT secret, API key, encryption keys,
  provider keys — and reach `process.getBuiltinModule("child_process")`. Reproduced locally on
  Node 26.8.1 / Pyodide 314.0.7: environment read succeeded and `execSync` ran. With the JWT
  secret an attacker mints an admin token. A `while True: pass` blocks the event loop with no
  deadline. Variables one caller defines are visible to the next.
- **Fix:** run each Python execution in a child Node under the permission model, reading only the
  Pyodide package directory, with an empty environment, the network prelude, a memory cap and a
  deadline — the model `lib/untrusted-js.ts` already uses. See [design.md](design.md#nx-sec-001).
- **Test:** `apps/api/tests/lib/untrusted-python.test.ts`

### NX-SEC-002 — Reset and verification tokens are written to the log

- **Severity:** high · **Status:** fixed
- **Evidence:** `apps/api/src/routes/auth-users.ts:692` logs `{ resetToken }` and `:934` logs
  `{ verifyToken }` at `info`, in every environment including production.
- **Impact:** anyone with log access (hosting dashboard, log drain, Sentry breadcrumbs) can reset
  any user's password within the hour the token lives.
- **Fix:** drop the token from the log line; keep the event. Non-production still returns it in
  the response body for tests.
- **Test:** `apps/api/tests/routes/auth-token-logging.test.ts`

### NX-SEC-003 — Single sign-on takes over unverified accounts

- **Severity:** high · **Status:** fixed
- **Evidence:** `upsertOAuthUser` (`routes/oauth.ts:87`), `upsertOidcUser` (`routes/oidc.ts:277`),
  `upsertSamlUser` (`routes/saml.ts:180`) match an existing account by email and sign in to it
  whatever `users.emailVerified` says. `POST /auth/register` needs no verification and
  `PATCH /auth/me` sets any unused email.
- **Impact:** pre-account takeover. Someone registers (or renames to) a victim's address with a
  password they know; when the victim later signs in with Google, GitHub, OIDC or SAML they land
  in that account, and the first party keeps a working password (and any MFA it set).
- **Fix:** one shared linking helper: when the matched account is unverified, remove its password
  and MFA secret, revoke its sessions, then mark it verified. See design.
- **Test:** `apps/api/tests/routes/sso-claim-unverified.test.ts`

### NX-SEC-004 — GitHub sign-in keyed on a renamable login

- **Severity:** high · **Status:** fixed
- **Evidence:** `routes/oauth.ts:327` uses the public profile email, else
  `${login}@users.noreply.github.com`.
- **Impact:** a user without a public email is identified by login. GitHub logins can be released
  and claimed by someone else, who then signs in as the original account.
- **Fix:** read `GET /user/emails` (the `user:email` scope is already requested) and use the
  primary verified address; fall back to GitHub's id-bearing noreply form
  `${id}+${login}@users.noreply.github.com`, which never transfers between people.
- **Test:** `apps/api/tests/routes/oauth-github-identity.test.ts`

### NX-SEC-005 — Teams bot webhook is unauthenticated and sends the bot token to a caller-chosen URL

- **Severity:** high · **Status:** fixed
- **Evidence:** `routes/bots.ts:142` `POST /api/v1/bots/teams/activity` has no verification;
  `packages/bots/src/index.ts:573` replies to `activity.serviceUrl` from the request body with a
  freshly acquired Bot Framework bearer token.
- **Impact:** when Teams credentials are configured, anyone can make the server mint a Bot
  Framework token and post it to their own URL, and can spend the operator's model credits.
- **Fix:** verify the Bot Framework JWT (OpenID metadata, JWKS, issuer, audience = app id,
  `serviceUrl` claim equals the activity's), refuse when Teams is not configured, and only ever
  reply to the verified `serviceUrl`.
- **Test:** `packages/bots/tests/botframework-auth.test.ts, apps/api/tests/routes/bots-webhooks.test.ts`

### NX-SEC-006 — Access-token revocation is never triggered, not persisted, and skipped on one path

- **Severity:** medium · **Status:** fixed
- **Evidence:** `lib/auth-hardening.ts` holds `SessionRevocationRegistry` in memory; nothing in the
  API calls `revokeAllForSubject` or `revokeJti`. `resolveIdentity` (`middleware/auth.ts:175`,
  run for every `/api/v1` request) never consults it, and `requireUserId` routes trust it.
  Access tokens carry no `jti`.
- **Impact:** after a password reset, admin suspension, role change, deletion or sign-out, issued
  access tokens keep working until they expire (15 minutes). On Fly's two machines a revocation
  would not cross replicas even if it were written.
- **Fix:** persist a per-subject cutoff (and per-session id) in the shared KV with a TTL equal to
  the access-token lifetime, check it in both verifiers, and call it from every place that ends
  sessions. See design.
- **Test:** `apps/api/tests/routes/session-revocation.test.ts`

### NX-SEC-007 — Public completion endpoint has no effective spend ceiling

- **Severity:** high · **Status:** fixed
- **Evidence:** `routes/libertas.ts:43` keys the 5-per-minute limit on the first
  `X-Forwarded-For` value, which the caller writes; prompt length is unbounded; `max_tokens` is
  not clamped below.
- **Impact:** unauthenticated, unlimited use of the operator's `GROQ_API_KEY` (set on the Render
  deployment).
- **Fix:** key on `request.ip` (IPv6 by /64), clamp `max_tokens` to `[1, 512]`, cap the prompt,
  and add a global per-minute ceiling that holds whatever addresses the requests come from.
- **Test:** `apps/api/tests/routes/libertas-ceilings.test.ts`

### NX-SEC-008 — Slack and Telegram webhooks are unauthenticated unless configured, and Slack verification cannot pass

- **Severity:** medium · **Status:** fixed
- **Evidence:** `routes/bots.ts:114` verifies the Slack signature over `JSON.stringify(body)`
  instead of the raw bytes, so a configured secret rejects real Slack requests, and an unset one
  skips verification. Telegram's secret is optional (`bots.ts` → `TelegramBotAdapter`). The
  gateway forwarder authenticates with `API_KEY`/`NEXUS_INTERNAL_KEY`/`"dev"` instead of
  `NEXUS_API_KEY` (`bots.ts:44`), so replies fail in practice.
- **Fix:** keep the raw body for the Slack route (scoped content-type parser, as
  `orgHookRoutes` does), refuse Slack and Telegram webhooks when their secret is unset, and call
  the gateway with `NEXUS_API_KEY`.
- **Test:** `apps/api/tests/routes/bots-webhooks.test.ts`

### NX-SEC-009 — Sign-in callbacks are not bound to the browser that started them

- **Severity:** medium · **Status:** fixed
- **Evidence:** OAuth and OIDC store `state` in the shared KV only (`routes/oauth.ts:66`,
  `routes/oidc.ts`). Nothing ties it to the initiating browser.
- **Impact:** login CSRF: a callback URL produced in one browser completes in another, signing the
  victim into the attacker's account (their later uploads and keys land there).
- **Fix:** set an `HttpOnly; SameSite=Lax` cookie carrying the state when redirecting to the
  provider and require it on browser-navigation callbacks.
- **Test:** `apps/api/tests/routes/oauth-state-binding.test.ts`

### NX-SEC-010 — Google ignores `email_verified`; Slack sign-in mints accounts for any Slack user

- **Severity:** medium · **Status:** fixed
- **Evidence:** `routes/oauth.ts:228`; Slack callback builds `${authed_user.id}@slack.workspace`
  and always creates an account.
- **Fix:** require `email_verified === true` from Google; key Slack identities on team id plus
  user id (`<team>.<user>@slack.invalid`, legacy accounts adopted on next sign-in) and refuse an
  answer that names no user, which previously mapped every such sign-in to one shared account.
  Slack stays a consumer-style sign-in like Google and GitHub, so it creates accounts.
- **Test:** `apps/api/tests/routes/oauth-identity-checks.test.ts`

### NX-SEC-011 — Password guessing is limited per address, not per account

- **Severity:** medium · **Status:** fixed
- **Evidence:** `loginThrottleKey(email, ip)` in `lib/auth-hardening.ts`; in memory.
- **Fix:** add an account-wide failure counter in the shared KV with a softer ceiling (slows a
  distributed guess without letting an attacker lock the owner out for long).
- **Test:** `apps/api/tests/routes/auth-account-ceiling.test.ts`

### NX-SEC-012 — Unauthenticated TOTP check endpoint; codes are replayable; secrets may be plaintext

- **Severity:** medium · **Status:** in-progress
- **Evidence:** `routes/mfa.ts:282` `POST /mfa/validate` answers whether a code is valid for any
  `userId` without authentication (login already checks MFA itself). TOTP codes are accepted again
  within their window. Without `NEXUS_MFA_KEY` the secret is stored in plaintext.
- **Fix:** remove `/mfa/validate` (done; no client used it); each sign-in code is accepted once
  (shared-KV mark per user and time step, done); the plaintext fallback is reported by the
  security check (NX-FEAT-001, pending).
- **Test:** `apps/api/tests/routes/auth-mfa-login.test.ts`

### NX-SEC-013 — Desktop shell opens any URL scheme from the renderer

- **Severity:** medium · **Status:** open
- **Evidence:** `apps/desktop/src/main.ts:103-124` passes every `window.open` target and foreign
  navigation to `shell.openExternal`.
- **Impact:** content that reaches the renderer (model output, a malicious page) can hand
  `file:`, `smb:` or OS protocol-handler URLs to the operating system.
- **Fix:** allow only `http:`, `https:` and `mailto:`.
- **Test:** _to be named_

### NX-SEC-014 — Development stack exposes data stores and disables ingest auth

- **Severity:** medium · **Status:** open
- **Evidence:** `docker-compose.yml:29-30` and `:59-60` publish Postgres and password-less Redis on
  every interface; `:311` passes the ingest key as `NEXUS_API_SECRET`, which the service does not
  read, and `services/ingest/src/nexus_ingest/auth.py:26-29` disables auth when its key is unset;
  `routes/scrape.py` has no auth dependency at all.
- **Fix:** bind published ports to `127.0.0.1`, pass `NEXUS_INGEST_API_KEY`, make ingest auth fail
  closed unless `NEXUS_INGEST_ENV=development`, put the scrape router behind the key.
- **Test:** _to be named_

### NX-SEC-015 — Model catalogue probe uses an unpinned fetch on a user-saved base URL

- **Severity:** medium · **Status:** fixed
- **Evidence:** `routes/api-bridge.ts:560` `fetchModelCatalog` calls global `fetch` on a base URL
  that a user saved (checked once at save time).
- **Impact:** a hostname that re-resolves to a private address after saving reaches internal
  services; model ids from the response are echoed back.
- **Fix:** use `callerFetch`.
- **Test:** `apps/api/tests/routes/model-catalog-ssrf.test.ts`

### NX-SEC-016 — Production dependencies with high advisories

- **Severity:** medium · **Status:** open
- **Evidence:** `pnpm audit --prod` at baseline: `fast-uri` (SSRF / host confusion, used by
  Fastify's schema formats), `sharp` (libvips/libheif/librsvg), `adm-zip`, `brace-expansion`,
  `js-yaml`, `dompurify`, `protobufjs`, `katex`, `colord`.
- **Fix:** bump direct dependencies where they pin the old version; otherwise `pnpm.overrides` to
  the first patched release in the same major. Re-run the audit.
- **Test:** `pnpm audit --prod --audit-level high` exits 0.

### NX-SEC-017 — One-time token races and no refresh-token reuse detection

- **Severity:** medium · **Status:** fixed
- **Evidence:** `routes/auth-users.ts` reset-password selects then updates `usedAt` without a
  guard, so two concurrent requests both succeed; refresh rotation treats a replayed (revoked)
  token as merely invalid.
- **Fix:** mark used with `WHERE used_at IS NULL … RETURNING`; on presentation of an already
  rotated refresh token revoke all of that user's sessions.
- **Test:** `apps/api/tests/routes/auth-token-reuse.test.ts`

### NX-SEC-018 — Host terminal sessions are not owner-scoped

- **Severity:** medium · **Status:** open
- **Evidence:** `routes/local-pty.ts` list/stream/write/resize/delete look sessions up by id only.
- **Impact:** where the PTY plane is reachable by more than one account (`NEXUS_LOCAL_PTY_FORCE`,
  or several accounts on one desktop API), one account can read and type into another's shell.
- **Fix:** record the owner on spawn, filter and check on every access.
- **Test:** _to be named_

### NX-SEC-019 — JWTs without `exp` never expire

- **Severity:** low · **Status:** fixed
- **Evidence:** `packages/auth/src/index.ts` `verifyJwt` / `verifyJwtRS256` and
  `middleware/auth.ts:36` `_verifyHs256` skip the expiry check when `exp` is absent.
- **Fix:** reject tokens without a numeric `exp`.
- **Test:** `packages/auth/tests/auth.test.ts, apps/api/tests/middleware/auth-with-tier.test.ts`

### NX-SEC-020 — SCIM token comparison is not constant-time; deprovisioning leaves access tokens live

- **Severity:** low · **Status:** fixed
- **Evidence:** `routes/scim.ts:53` uses `!==`; deactivate and delete do not revoke sessions.
- **Fix:** `timingSafeEqual` on SHA-256 digests; call subject revocation (NX-SEC-006).
- **Test:** `apps/api/tests/routes/scim-auth.test.ts`

### NX-SEC-021 — CORS reflects every origin when `ALLOWED_ORIGINS` is unset

- **Severity:** low · **Status:** open
- **Evidence:** `server.ts` `origin: ALLOWED_ORIGINS?.split(",") ?? true`. Bearer tokens are not
  sent automatically, so impact is limited; flagged by the security check.
- **Fix:** keep the default for development; report it in the security check for production.

### NX-SEC-022 — CI token permissions and action pinning

- **Severity:** low · **Status:** open
- **Evidence:** `build.yml`, `lint.yml`, `test.yml`, `k6.yml`, `conventional-commits.yml` declare
  no `permissions`; third-party actions are pinned by tag.
- **Fix:** top-level `permissions: contents: read` everywhere it is missing.

### NX-SEC-023 — SSRF guard misses IPv6 ranges that embed IPv4

- **Severity:** low · **Status:** fixed
- **Evidence:** `packages/runtime/src/security-utils.ts` `isPrivateIPv6` handles `::ffff:` but not
  NAT64 `64:ff9b::/96`, 6to4 `2002::/16` or IPv4-compatible `::a.b.c.d`.
- **Fix:** extract the embedded IPv4 for those prefixes and apply the IPv4 check.
- **Test:** `packages/runtime/tests/security-utils.test.ts`

### NX-SEC-024 — Upstash rate-limit counter can lose its expiry

- **Severity:** low · **Status:** fixed
- **Evidence:** `lib/rate-limiter.ts` sends `INCR` and `EXPIRE` as two requests.
- **Fix:** one pipeline `[["INCR", k], ["EXPIRE", k, s, "NX"]]`.
- **Test:** `apps/api/tests/lib/rate-limiter-upstash.test.ts`

### NX-SEC-025 — Registration reveals whether an email has an account

- **Severity:** low · **Status:** accepted
- **Reason:** rate-limited to 5 per hour per address; the usual trade-off for a sign-up form that
  can tell the user what went wrong.

### NX-SEC-026 — GeoIP route reads raw `X-Forwarded-For`

- **Severity:** low · **Status:** wontfix
- **Evidence:** `routes/geoip.ts:132`.
- **Reason:** `/geoip/me` only tells the caller about an address; a spoofed header changes the
  caller's own answer, and `/geoip/:ip` already looks up any address. Behind an untrusted proxy
  the header is also the only way to see the client's address. No security effect.

### NX-SEC-027 — Threat model no longer matches the code

- **Severity:** low · **Status:** open
- **Evidence:** `docs/security/threat-model.md` lists removed packages (`packages/adapters`),
  "planned" controls that exist (rate limiting, SSRF guard) and none of the exec surfaces.
- **Fix:** rewrite against [architecture.md](architecture.md) at the end of the program.

### NX-SEC-028 — Brief share links are signed with a public default key

- **Severity:** medium · **Status:** fixed
- **Evidence:** `packages/brief-engine/src/index.ts:87` and `apps/api/src/routes/brief.ts` sign and
  verify share URLs with `BRIEF_SIGNING_KEY`, falling back to the literal `"dev-key"`; the Render
  blueprint does not set it. `GET /api/v1/brief/:domain/share/:digest` is public (found by the
  route census).
- **Impact:** anyone can mint a valid share URL for any user id and date and read that brief.
- **Fix:** when `BRIEF_SIGNING_KEY` is unset, derive the key from `NEXUS_API_KEY` (always present,
  checked at start-up) with a fixed label; never fall back to a constant.
- **Test:** `apps/api/tests/routes/brief-share-key.test.ts`

### NX-SEC-029 — Audit chain falls back to a public HMAC key

- **Severity:** low · **Status:** open
- **Evidence:** `apps/api/src/lib/audit-emitter.ts:62` and `routes/audit.ts:86` use
  `"nexus-dev-audit-key"` when `NEXUS_AUDIT_KEY` is unset; production start-up only warns.
- **Impact:** someone with database write access can rebuild a valid chain after editing entries,
  defeating the tamper evidence (threat model T3).
- **Fix:** changing the fallback would break verification of existing chains, so the security check
  (NX-FEAT-001) fails on it in production and the start-up warning names the consequence.

## Strengths worth keeping

Recorded so a later change does not remove them by accident: child-process JavaScript sandbox and
PTC sandbox under the permission model; pinned SSRF fetch with redirect re-checks; stealth browser
routing every request through it; drive exec in Docker with quota-sized tmpfs and a hard refusal
of host shells in production; exec policy with single-use, action-bound approvals; secret store
that never returns values; SAML with InResponseTo replay protection and signed assertions; OIDC
`email_verified` strictness and provisioning allowlist; startup refusal of placeholder secrets in
production; refresh tokens hashed, rotated, cookie `HttpOnly; SameSite=Strict`; admin role
re-read from the database.
