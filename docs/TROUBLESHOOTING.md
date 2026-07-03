<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Troubleshooting

Common first-run and local-dev issues. If your problem isn't here, check the
[runbook](runbook.md) for operational issues or open an issue.

## Setup

**`docker compose up` fails / "Cannot connect to the Docker daemon"**
Docker isn't running. Start it (`systemctl start docker` on Linux, or launch Docker
Desktop), then retry. The local stack needs Docker for Postgres and Redis.

**`pnpm install` errors about the Node or pnpm version**
The repo pins Node 20.x (`.nvmrc`) and pnpm 9.x. Use `nvm use` and
`corepack enable` so the right toolchain is active. Node 21+/22+ may work but is
unsupported. Always use `pnpm`, never `npm` or `yarn` (workspace protocol).

**`pnpm db:migrate` fails or hangs**
Postgres must be up and reachable at `DATABASE_URL` first:
`docker compose up -d postgres redis`. Confirm the URL in `.env` matches the compose
service (default `postgresql://nexus:nexus_dev_password@localhost:5432/nexus`). A fresh
database with a partially-applied migration can need a manual reset of the `nexus` DB.

**API starts but every `/api/v1/*` call returns 401**
Auth is disabled unless a secret is configured. Set `NEXUS_API_KEY` (for API-key auth)
and/or `JWT_SECRET` (for user login tokens). Without either, the auth middleware treats
the API as locked down.

## BYOK / provider keys

**Saving a provider key returns 503 "encryption unavailable"**
Set `NEXUS_SECRETS_KEY` to a 64-character hex string (32 bytes). The key store fails
closed by design — it refuses to persist secrets unencrypted.

**Council / God-mode says "No key configured for provider: X"**
User LLM paths are strict: they use the signed-in user's stored key, with no env
fallback. Add the provider's key on the Provider Keys page (`/provider-keys`).

## Dev servers

**UI loads but API calls 404 / fail in dev**
The Vite dev server (`:5173`) proxies `/api/*` to the Fastify API on `:3001`. Make sure
the API is running — `pnpm dev` starts all services, or `pnpm dev:api` / `pnpm dev:ui`
start them individually.

**Port already in use**
Defaults: API `3001` (dev) / `3000` (docker), UI `5173` (dev) / `4173` (docker),
worker is a background process. Stop the conflicting process or change the port in the
relevant config.

## Build / typecheck

**`tsc` errors in a package you didn't touch**
Turbo builds dependencies first (`dependsOn: ["^build"]`). Run a clean build of the
dependency graph: `turbo run build --filter=@nexus/<pkg>...`. A stale `dist/` can also
cause this — `pnpm clean` then rebuild.
