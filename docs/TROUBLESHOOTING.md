<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- verified: 8065a84 2026-11-25 -->

# Nexus — Troubleshooting

Common first-run and local-dev issues. If your problem isn't here, check the
[runbook](runbook.md) for operational issues or open an issue.

## Setup

**`docker compose up` fails / "Cannot connect to the Docker daemon"**
Docker isn't running. Start it (`systemctl start docker` on Linux, or launch Docker
Desktop), then retry. The local stack needs Docker for Postgres and Redis.

**`pnpm install` errors about the Node or pnpm version**
The repo pins Node 26 (`.nvmrc`, Node 24 also supported) and pnpm 12. Use
`nvm use` and `corepack enable` so the right toolchain is active. Always use `pnpm`, never `npm` or `yarn` (workspace protocol).

**`pnpm db:migrate` fails or hangs**
Postgres must be up and reachable at `DATABASE_URL` first:
`docker compose up -d postgres redis`. Confirm the URL in `.env` matches the compose
service (default `postgresql://nexus:nexus_dev_password@localhost:5432/nexus`). A fresh
database with a partially-applied migration can need a manual reset of the `nexus` DB.

**API exits with `[startup] FATAL: NEXUS_API_KEY is not set`**
`NEXUS_API_KEY` is required in every environment; the process refuses to start without
it. Set it in `.env` (or the shell) and retry. In production a placeholder or short key
is rejected too, and a missing `NEXUS_JWT_SECRET` / `NEXUS_AUDIT_KEY` is logged as a warning.

## BYOK / provider keys

**Saving a provider key returns 503 "encryption unavailable"**
Set `NEXUS_SECRETS_KEY` to a 64-character hex string (32 bytes). The key store fails
closed by design — it refuses to persist secrets unencrypted.

**Council / God-mode says "No key configured for provider: X"**
User LLM paths are strict: they use the signed-in user's stored key, with no env
fallback. Add the provider's key on the Provider Keys page (`/provider-keys`).

## Dev servers

**UI loads but API calls 404 / fail in dev**
The React Router dev server (`:5173`) proxies `/api/*` to the API at
`NEXUS_API_URL` (default `http://localhost:3000`). Make sure the API is running —
`pnpm dev` starts all services, or `pnpm dev:api` / `pnpm dev:ui` start them
individually.

**Port already in use**
Defaults: API `3000` (dev and Docker host), UI `5173` (dev) / `4173` (Docker),
worker is a background process. The API container listens on `3001` internally and
publishes `3000`. Stop the conflicting process or change `PORT`.

## Build / typecheck

**`tsc` errors in a package you didn't touch**
Turbo builds dependencies first (`dependsOn: ["^build"]`). Run a clean build of the
dependency graph: `turbo run build --filter=@nexus/<pkg>...`. A stale `dist/` can also
cause this — `pnpm clean` then rebuild.

---

## The ten failures that account for most reports

If one line describes your problem, the fix is the linked section above. If none does, run
the diagnostic bundle below and open an issue with it.

| #   | What you see                                               | Why                                                    | Where                          |
| --- | ---------------------------------------------------------- | ------------------------------------------------------ | ------------------------------ |
| 1   | `[startup] FATAL: NEXUS_API_KEY is not set`                | The API refuses to start without a key                 | Setup                          |
| 2   | `503 encryption unavailable` when saving a provider key    | `NEXUS_SECRETS_KEY` is unset or the wrong length       | BYOK                           |
| 3   | `No key configured for provider: X`                        | User paths never fall back to the env key              | BYOK                           |
| 4   | UI loads, every `/api` call 404s                           | The API is not running behind the dev proxy            | Dev servers                    |
| 5   | `EADDRINUSE` on 3000 / 5173                                | Something already holds the port                       | Dev servers                    |
| 6   | `pnpm db:migrate` hangs or fails                           | Postgres unreachable, or a half-applied migration      | Setup                          |
| 7   | `tsc` errors in a package you did not edit                 | A stale `dist/` or an unbuilt dependency               | Build                          |
| 8   | A workflow run finishes `skipped` with "over its … budget" | A hard-stop budget policy is exhausted                 | [`runbook.md` §P5](runbook.md) |
| 9   | `docker compose up` cannot reach the daemon                | Docker is not running                                  | Setup                          |
| 10  | `/status` says `degraded`                                  | An optional dependency (Redis, sandbox, Docker) is out | [`slos.md` SLO-6](slos.md)     |

## Reporting it: the diagnostic bundle

One command collects what a report needs, already redacted:

```bash
nexus doctor --bundle ./report     # writes nexus-bundle.json + a README into ./report
```

The bundle contains the `nexus doctor` rows and, if the API answers, its own `/status` and
`/health` documents — no environment dump, no logs, no session contents. Credentials are removed
on the way in: provider-key shapes (`sk-…`, `gsk_…`, `ghp_…`), JSON web tokens, AWS access keys,
webhook signatures, passwords in a `DATABASE_URL`, and secrets in a query string. The bundle's
README lists what was removed, so a reader can see that a value was taken out rather than
thinking the field was empty. Read the file before you attach it: a credential in a shape the
tool does not recognise is still a credential. Where to send it is in [`SUPPORT.md`](../SUPPORT.md).
