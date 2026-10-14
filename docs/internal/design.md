<!-- SPDX-License-Identifier: Apache-2.0 -->

# Design

How each fix and feature is built. Principle throughout: fix at the one place every caller goes
through, reuse what the codebase already has (`untrusted-js.ts`, `pinnedFetch`, shared KV,
`emitAuditEvent`, notifications store), add no runtime dependency.

## NX-SEC-001 — Python in a child process {#nx-sec-001}

New `apps/api/src/lib/untrusted-python.ts`, shaped like `lib/untrusted-js.ts`, exporting
`runUntrustedPython(code, timeoutMs)` with the same result type. `runViaPyodide` in
`routes/sandbox.ts` becomes a thin call to it, so the sandbox route and the code agent both move.

Child process:

```
node --permission
     --allow-fs-read=<pyodide package dir>
     --max-old-space-size=256
     -e <RUNNER> <pyodide dir>
env: {} (ELECTRON_RUN_AS_NODE=1 inside the desktop app)
```

Runner, in order:

1. `SANDBOX_PRELUDE` from `@nexus/agent-runtime` (clears `process.env`, stubs sockets, DNS,
   `fetch`).
2. Replace `process.binding` with a function that answers only `"constants"` (Pyodide's NODEFS
   reads `process.binding("constants").fs` at start-up, and the permission model forbids the real
   one).
3. `loadPyodide({ indexURL })` from the package directory, then read the code from stdin, write a
   start marker to stderr, `runPythonAsync`, stream stdout and stderr.

Parent: boot deadline 30 s (as in `untrusted-js.ts`), run deadline from the start marker,
`SIGKILL` on either, output capped. One child per execution, so no state crosses callers.

Measured: boot about 2.1 s on the development machine. Verified inside the child: `process.env`
is empty, `child_process` and host `fs` reads throw `ERR_ACCESS_DENIED`.

Ceiling, marked in code: one cold boot per run. Upgrade path if latency matters: a small pool of
pre-booted children, each used once.

## NX-SEC-002 — Tokens out of logs

Remove `resetToken` and `verifyToken` from the two `app.log.info` calls; log the user id instead
of the email. Test: capture the Fastify logger stream during a forgot-password call and assert
the token string never appears.

## NX-SEC-003 — Safe linking of a sign-in identity {#nx-sec-003}

New `apps/api/src/lib/sso-link.ts`:

```ts
/** Prepare an existing account to be entered through a third-party identity. */
export async function claimForSso(
  user: { id: string; emailVerified: boolean },
  provider: string,
): Promise<void>;
```

When `emailVerified` is false: in one transaction set `passwordHash = "oauth:<provider>:no-password"`,
`mfaEnabled = false`, `totpSecret = null`, `emailVerified = true`; revoke every refresh token;
call the subject revocation from NX-SEC-006; emit `auth.sso_claimed_unverified` to the audit log.
When true: nothing. `upsertOAuthUser`, `upsertOidcUser`, `upsertSamlUser` call it on the
existing-account branch (SAML's own "mark verified" update moves into it).

Why strip instead of refuse: refusing would let anyone block a real person from ever using SSO
with their own address by registering it first. Stripping gives the address to the person who
proved it and leaves the squatter nothing.

## NX-SEC-004 — GitHub identity

After the token exchange, `GET https://api.github.com/user/emails`; pick `primary && verified`;
else the first `verified`; else `${id}+${login}@users.noreply.github.com`. The public profile
email is no longer read.

## NX-SEC-005 / 008 — Webhook verification {#webhooks}

**Teams.** New `packages/bots/src/botframework-auth.ts`:

- OpenID metadata `https://login.botframework.com/v1/.well-known/openidconfiguration` →
  `jwks_uri`; both cached 24 h in process; refetch once on unknown `kid`.
- Verify the `Authorization: Bearer` JWT: RS256 only, issuer `https://api.botframework.com`,
  audience equals `TEAMS_BOT_APP_ID`, `exp`/`nbf` with 5 minutes skew, and the token's
  `serviceurl` claim equals `activity.serviceUrl`.
- The route answers 503 when `TEAMS_BOT_APP_ID` is unset and 401 on any failure, before the
  adapter runs. Network calls take an injectable `fetch` so tests run offline with a generated key
  pair.

**Slack.** Register the Slack route inside its own plugin with
`addContentTypeParser("application/json", { parseAs: "string" })` (the `orgHookRoutes` pattern),
verify over the raw string, then `JSON.parse`. Refuse with 503 when `SLACK_SIGNING_SECRET` is unset
(the URL-verification challenge included: Slack signs it too).

**Telegram.** Refuse with 503 when `TELEGRAM_WEBHOOK_SECRET` is unset.

**Forwarder.** `_gatewayHandler` authenticates with `NEXUS_API_KEY`.

## NX-SEC-006 / NX-FEAT-002 — Persistent session revocation {#revocation}

New `apps/api/src/lib/session-revocation.ts` over the shared KV (Redis, Upstash or Postgres —
whatever the deployment has):

- `revokeSubject(userId)` writes `auth:revoked:sub:<id>` = now (epoch seconds), TTL = access-token
  lifetime + 60 s. Past that, every token issued before the cutoff has expired anyway.
- `revokeSession(sid)` writes `auth:revoked:sid:<sid>` with the same TTL.
- `isRevoked({ sub, iat, sid })` reads both keys; a 5-second in-process memo per key bounds the
  extra KV reads to one per user per five seconds per replica. KV failure: fail open (logged),
  consistent with rate limiting; the 15-minute token lifetime stays the hard bound.
- Access tokens gain a `sid` claim: the id of the refresh-token row of the session that minted it,
  so "sign out this device" ends that device's access token too.

Both verifiers call `isRevoked`: `requireAuth` after `authenticate()`, and `resolveIdentity`
before it sets `nexusUserId` (a revoked token resolves to no identity). The in-memory
`SessionRevocationRegistry` stays in `@nexus/auth` for other consumers; the API stops passing it.

Callers: password reset, admin suspend / role change / delete, SCIM deactivate and delete, GDPR
erase, `DELETE /auth/sessions/:id` (that `sid`), new `POST /auth/sessions/revoke-all`, SSO claim
(NX-SEC-003), refresh-token reuse (NX-SEC-017).

## NX-SEC-007 — Libertas ceilings

- Client key: `request.ip`; IPv6 collapsed to its /64.
- Global bucket `libertas:global` at `NEXUS_LIBERTAS_GLOBAL_PER_MIN` (default 30) checked before
  the per-client bucket.
- `prompt` ≤ 4 000 characters (400 otherwise); `max_tokens` clamped to `[1, 512]`; a JSON schema
  on the route.

## NX-SEC-009 — Callback bound to the browser

On `GET /oauth/<p>` and `/auth/oidc/authorize`: also set `nexus_sso_state=<state>; HttpOnly;
SameSite=Lax; Path=/api/v1; Max-Age=300` (`Secure` on https). On the callback, when the request
is a browser navigation (`isBrowserNavigation`), require the cookie to equal `state`, then clear
it. The desktop app's main-process fetch is not a browser navigation and keeps the KV-only check;
its window is not reachable by another site.

## NX-SEC-010 — Google and Slack identities

Google: refuse unless `email_verified === true` in userinfo. Slack: identity
`${team.id}.${authed_user.id}@slack.invalid` (`.invalid` cannot be a real mailbox), and new accounts
only through `assertMayProvision`.

## NX-SEC-011 — Account-wide guess ceiling

Second counter keyed on the email alone in the shared KV: 30 failures per 15 minutes trips a
5-minute lock. The per `email|ip` exponential throttle stays as the first line. Lock state lives
in the KV so restarts and replicas agree.

## NX-SEC-012 — MFA

Delete `POST /mfa/validate` (no caller in `apps/ui`, `apps/cli`, `apps/desktop` — verified with a
search before removal). Replay: KV key `mfa:last-step:<userId>` with the accepted time step, TTL
2 minutes; `totpMatches` returns the step it matched and login refuses a step ≤ the stored one.

## NX-SEC-013 — Desktop external links

`openExternalSafe(url)`: parse; only `http:`, `https:`, `mailto:` reach `shell.openExternal`;
anything else is dropped and logged. Both call sites use it.

## NX-SEC-015 — Model catalogue fetch

`fetchModelCatalog` calls `callerFetch` instead of `fetch`.

## NX-SEC-017 — Token races

Reset: `UPDATE … SET used_at = now WHERE id = $1 AND used_at IS NULL RETURNING id`; continue only
when a row returns. Same for email verification. Refresh: when the presented hash matches a row
whose `revoked_at` is set, revoke all of that user's refresh tokens and `revokeSubject`, then
answer 401.

## NX-SEC-018 — PTY ownership

`PtyManager.spawn` accepts and records `ownerId`; `list(ownerId)` filters; every route compares
`ownerIdFor(request)` with the session's owner and answers 404 otherwise.

## NX-SEC-019 — Expiry required

`verifyJwt`, `verifyJwtRS256`, `_verifyHs256`: a token without a numeric `exp` is invalid.

## NX-SEC-023 — IPv6 embedded IPv4

In `isPrivateIPv6`: `64:ff9b::/96` → last 32 bits; `2002::/16` → bits 16–47; `::a.b.c.d` and
`::xxxx:xxxx` (IPv4-compatible) → last 32 bits; each through `isPrivateIPv4`.

## NX-FEAT-001 — Security check {#security-check}

One module `apps/api/src/lib/security-posture.ts` exporting a pure
`checkPosture(env, facts): PostureCheck[]` where
`PostureCheck = { id, title, status: "pass" | "warn" | "fail", detail, fix }`. Pure so it is
tested with plain objects. `facts` carries what env alone cannot tell: shared-KV backend in use,
whether the request arrived over https, Docker availability.

Checks (first set): production mode; JWT secret / RS256 keys present and long; audit key;
secrets key; MFA key; `ALLOWED_ORIGINS` set in production; `NEXUS_TRUST_PROXY` set when behind a
proxy (Render and Fly detected from their env); shared KV not in-memory when more than one replica
is possible; `ALLOW_UNSANDBOXED_EXEC` off; `NEXUS_LOCAL_PTY_FORCE` off on a shared server;
`NEXUS_EXEC_MODE` not `trusted` on a shared server; SSO auto-provision has a domain allowlist;
bot webhooks verified when their tokens are set; Libertas exposure with a provider key; database
URL uses TLS; queue dashboard password set when enabled; `PISTON_URL` not public emkc.

Surfaces:

- `GET /api/v1/admin/security/posture` (`requireAdminRole`) → `{ checkedAt, summary, checks }`.
- `nexus security check` in `apps/cli`: calls the endpoint, prints a table, exits 1 on any `fail`.
- Admin page panel listing the checks with their fix text.
- Startup: in production, log each `fail` once at warn level (no new exits; existing fatal checks
  stay as they are).

## NX-FEAT-003 — Security notifications

`lib/security-events.ts` `securityEvent(userId, kind, detail)`: pushes a notification through the
existing per-user notifications store and writes the audit event. Kinds: `signin.new`,
`password.changed`, `email.changed`, `mfa.enabled`, `mfa.disabled`, `token.created`,
`sessions.revoked`. Called from the routes that perform those actions.

## NX-FEAT-004 — MFA recovery codes

Column `users.mfa_recovery_codes` (`text[]` of SHA-256 hex) via a Drizzle migration. Ten codes of
10 base32 characters, shown once on MFA activation and on regenerate
(`POST /mfa/recovery-codes`, requires a current TOTP code). Login accepts a recovery code in place
of the TOTP code; a used code is removed in the same `UPDATE … WHERE … RETURNING`.

## NX-FEAT-005 — Audit coverage

`emitAuditEvent` on: login lockout, MFA enable/disable/recovery-code use, role change, suspend,
restore, delete, session revocations, SSO claim, security-check run.

## NX-FEAT-008 — Advisory gate

`security.yml`: a step `pnpm audit --prod --audit-level high`. Ignored advisories, if ever needed,
go in `pnpm.auditConfig.ignoreGhsas` with a comment naming why.
