<!-- SPDX-License-Identifier: Apache-2.0 -->

# Architecture, from a security angle

What the system looks like as of the 2026-10-14 baseline, in the terms an attacker or a reviewer
needs: who can reach what, how a caller becomes an identity, where code runs, where requests
leave the server, and where secrets live. `docs/ARCHITECTURE.md` is the general layout; this file
does not repeat it.

## Deployables

| Unit              | Runs                                                         | Reached by                           |
| ----------------- | ------------------------------------------------------------ | ------------------------------------ |
| `apps/api`        | Fastify 5 API; also serves the built UI when `NEXUS_SPA_DIR` | Internet (cloud), loopback (desktop) |
| `apps/worker`     | BullMQ consumers (agent runs, browser tasks, feeds)          | Redis only                           |
| `apps/ui`         | React Router 8 SPA (React 19)                                | Browser                              |
| `apps/desktop`    | Electron 44 shell; boots the API as a child on loopback      | Local user                           |
| `apps/cli`        | `nexus` CLI                                                  | Local user, talks to the API         |
| `apps/extension`  | Browser extension stub                                       | —                                    |
| `services/ingest` | Python FastAPI + Celery scrapers                             | Internal network, port 8000          |

Live cloud deployment: one Render web service (`render.yaml`, image `infra/web/Dockerfile`) that
runs the API with the UI on the same origin, `NODE_ENV=production`, `NEXUS_TRUST_PROXY=uniquelocal`,
open registration, Neon Postgres, no Redis. `vercel.json` proxies `/api/*` to it. `fly.toml` and
`infra/helm` describe alternative deployments (Fly runs two machines, so per-process state is not
shared there).

## Route scopes and how each is authenticated

`apps/api/src/server.ts` mounts four scopes. The authentication rule differs per scope, which is
the single most important fact for reviewing a route:

| Prefix                                       | Scope-wide hook                                            | Consequence                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/api/v1/*`                                  | `enterUserContext` only (resolves identity, never rejects) | **Each route must add its own `preHandler`.** A route without one is public.                 |
| `/api/*`                                     | `requireAuthWithTier` + IP rate limit                      | Everything authenticated (`api-bridge.ts` and the modules it registers, `org*`, `local-pty`) |
| `/v1/*`                                      | `requireAuthWithTier`                                      | OpenAI-compatible surface, authenticated                                                     |
| `/health*`, `/openapi.json`, `/admin/queues` | none / opt-in password                                     | Public by design                                                                             |

Public `/api/v1` routes as of the baseline: auth register/login/refresh/logout/reset/verify,
OAuth/OIDC/SAML entry and callbacks, SCIM discovery, `/libertas*`, `/bots/*`, `/org/hooks/:hookId`
(HMAC-verified), `/mcp/info`, `/oauth/providers`, `/llm-oauth/providers`, `/drive/file` (signed
link). Re-run the route census in [security-findings.md](security-findings.md) after adding
routes.

## Identity resolution

`apps/api/src/middleware/auth.ts`.

- **Credentials accepted:** master `NEXUS_API_KEY` (no user identity, treated as admin by
  `authenticate`, but `requireAdminRole` needs a user so admin routes refuse it); user JWT
  (HS256 with `NEXUS_JWT_SECRET`, or RS256 with `NEXUS_JWT_PUBLIC_KEY`, 15-minute expiry, claims
  `sub`, `role`, `tier`, `exp`, `iat`, no `jti`); personal access tokens `nxk_*` (SHA-256 in
  `api_keys`, scopes enforced by `lib/pat-scopes.ts`); any other `api_keys` row.
- **Two verifiers.** `requireAuth` → `@nexus/auth` `authenticate()` verifies signature, expiry and
  the revocation registry, then `resolveIdentity`. `resolveIdentity` alone (used by
  `enterUserContext` on every `/api/v1` request) verifies the JWT signature and expiry with its
  own HS256 routine and **does not** consult revocation. Routes that only call `requireUserId`
  (governance, MCP servers, provider credentials in the bridge) rely on this second path.
- **Admin.** `requireAdminRole` (`routes/admin-users.ts`) re-reads the role from Postgres on each
  request, so a demotion is immediate for admin routes. Other role checks read the JWT `role`.
- **Sessions.** Refresh tokens: 32 random bytes, SHA-256 at rest (`refresh_tokens`), 30 days,
  rotated on use, cookie `nexus_refresh` (`HttpOnly; SameSite=Strict; Path=/api/v1/auth`) for
  browsers, body for API clients. Revocation of access tokens: `@nexus/auth`
  `SessionRevocationRegistry`, held in process memory (`lib/auth-hardening.ts`), and at the
  baseline never written to by any route.
- **Brute force.** `LoginThrottle` keyed `email|ip`, in process memory; IP rate limits through the
  shared KV.
- **SSO.** Google, GitHub, Slack (`routes/oauth.ts`), generic OIDC (`routes/oidc.ts`), SAML
  (`routes/saml.ts`, `@node-saml/node-saml`, InResponseTo always validated). All link to an
  existing account by email. OIDC and SAML create accounts only under `NEXUS_SSO_AUTO_PROVISION`
  plus a domain allowlist; Google, GitHub and Slack always create.
- **MFA.** TOTP (`routes/mfa.ts`), secret encrypted with `NEXUS_MFA_KEY` when set, plaintext
  otherwise; checked inside `/auth/login`.

## Where code runs

All executing surfaces go through `lib/exec-guard.ts` → `@nexus/exec-policy`
(`NEXUS_EXEC_MODE`, allow/deny rules, approvals). Surface defaults: `pty` asks, `sandbox`,
`repl` and `tool` run, on the reasoning that the runtime is the control. That reasoning holds
only where the runtime really isolates:

| Surface / path                         | Runtime                                                                                                                                       | Isolation                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `/api/sandbox/execute` JavaScript      | `lib/untrusted-js.ts`: child Node, `--permission`, empty env, sockets and DNS stubbed, 64 MB, deadline                                        | Good                                                           |
| `/api/sandbox/execute` Python          | `runViaPyodide` in `routes/sandbox.ts`: Pyodide **inside the API process**, one shared interpreter, no deadline                               | **None** (NX-SEC-001)                                          |
| Code agent build/run (Python)          | same `runViaPyodide`                                                                                                                          | **None** (NX-SEC-001)                                          |
| `/api/sandbox/execute` other languages | Piston at `PISTON_URL` (self-hosted)                                                                                                          | Piston's container                                             |
| Programmatic tool calling              | `@nexus/agent-runtime` `ptc-sandbox.ts`: child Node, permission model                                                                         | Good                                                           |
| Drive shell `/api/v1/drive/exec`       | Docker (`runOnDrive`), tmpfs sized to quota, gVisor/Kata optional; host shell only with `ALLOW_UNSANDBOXED_EXEC=true` and never in production | Good                                                           |
| Python/R/Julia kernels                 | `@nexus/code-repl` Docker REPL                                                                                                                | Container                                                      |
| Host PTY `/api/local/pty`              | `@nexus/pty`, loopback-only (or `NEXUS_LOCAL_PTY_FORCE`), inherits server env                                                                 | By design a host shell; sessions not owner-scoped (NX-SEC-018) |
| Skills                                 | `lib/skill-runner.ts` → `@nexus/sandbox` child process; gated as `pty`                                                                        | Approval / admin on shared servers                             |
| Org CLI runtimes                       | `lib/org-cli-adapters.ts`; exec policy once per agent and command; no inherited env                                                           | Policy                                                         |
| Workflow `transform` expressions       | `new Function` in the API process                                                                                                             | Desktop only; refused on shared servers                        |

## Where requests leave the server

- `@nexus/runtime` `pinnedFetch`: resolves, refuses private/reserved addresses
  (`security-utils.ts` `isPrivateAddress`), and pins the socket to the checked address, so DNS
  rebinding fails at connect time. Does not follow redirects.
- `apps/api/src/lib/public-url.ts`: `unsafeUrlReason` (string check), `callerFetch` (pinned off
  the desktop), `fetchPublic` (pinned, re-checks every redirect hop, at most 5).
- Stealth browser routes every page request through `pinnedFetch`.
- MCP servers, connectors, OIDC discovery, org HTTP runtime, KB crawl, scraping: pinned.
- Raw `fetch` to fixed vendor URLs (Google, GitHub, Slack, Groq, Tavily, Semantic Scholar,
  Upstash, Sentry): fine. Raw `fetch` to a URL a user influences: the model catalogue probe in
  `api-bridge.ts` (NX-SEC-015) and the Teams reply URL (NX-SEC-005).

## Untrusted text reaching models

Web pages, KB passages, webhook payloads and tool output pass through `screenUntrusted`
(`@nexus/shared`) and sit under `UNTRUSTED_NOTE` (documented invariant in `docs/STATUS.md`).
Org members' text is labelled as information, not instruction. Prompt injection is mitigated, not
prevented; the exec gate and approvals are the backstop for anything an agent tries to run.

## Secrets

| Secret                                           | Where                                                  |
| ------------------------------------------------ | ------------------------------------------------------ |
| `NEXUS_API_KEY`, `NEXUS_JWT_SECRET` / RS256 keys | env; startup refuses placeholders in production        |
| `NEXUS_SECRETS_KEY`                              | env; per-user secret store refuses to write without it |
| `NEXUS_AUDIT_KEY`                                | env; HMAC chain of `audit_log`                         |
| `NEXUS_MFA_KEY` / `OAUTH_ENCRYPTION_KEY`         | env; TOTP secret encryption (plaintext fallback)       |
| Provider keys (operator)                         | env (`GROQ_API_KEY` …)                                 |
| Provider keys (users)                            | Postgres, AES-256-GCM (`lib/provider-keys.ts`)         |
| Connector credentials                            | Postgres, encrypted                                    |
| OAuth client secrets, bot tokens                 | env                                                    |

Every one of these is readable by any code that runs inside the API process, which is why
NX-SEC-001 is critical.

## State that matters for security

- Postgres (Drizzle; Neon in the cloud, PGlite on desktop): users, refresh tokens, reset and
  verification tokens, API keys, provider credentials, audit log.
- Shared KV (`lib/shared-kv.ts`): Redis when `REDIS_URL`, else Upstash REST, else Postgres
  (`nexus_kv`), else memory. Holds rate-limit counters, OAuth state, notifications, many stores.
  The right home for any security state that must survive restarts and be shared by replicas.
- Process memory: login throttle, session revocations, sandbox results, PTY sessions, PAT cache
  (hydrated from Postgres on boot).

## Desktop shell

`apps/desktop`: `contextIsolation`, `sandbox`, no `nodeIntegration`; one `contextBridge` object;
navigation away from the renderer origin is cancelled and handed to `shell.openExternal`, as are
`window.open` targets (any scheme at the baseline, NX-SEC-013). Session sealed with `safeStorage`;
the renderer gets the access token in memory only. The local API runs on a free loopback port
with per-install generated keys.
