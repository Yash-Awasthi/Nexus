<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- verified: 8065a84 2026-11-25 -->

# Nexus — Deployment

Production deployment options and the full environment-variable reference. For local
development see the [README Quick Start](../README.md#quick-start). For day-2 operations
(scaling, incidents, backup/DR) see [`runbook.md`](runbook.md).

## Environment variables

Minimum for the hosted deployment:

| Variable                                         | Description                                                                                                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXUS_API_KEY`                                  | Master API key for all `/api/v1/*` requests                                                                                                                                                     |
| `DATABASE_URL`                                   | PostgreSQL connection string (with pgvector); unset falls back to embedded PGlite, which is development only                                                                                    |
| `REDIS_URL`                                      | Redis connection string for BullMQ (in-memory fallback if unset)                                                                                                                                |
| `NEXUS_JWT_SECRET`                               | HS256 signing secret for user auth tokens (default alg)                                                                                                                                         |
| `NEXUS_JWT_ALG`                                  | `HS256` (default, shared secret) or `RS256` (asymmetric key pair)                                                                                                                               |
| `NEXUS_JWT_PRIVATE_KEY` / `NEXUS_JWT_PUBLIC_KEY` | RSA key pair (PEM) — required for `NEXUS_JWT_ALG=RS256`; issuance signs with the private key, verification is alg-pinned to the public key so downstream services never hold the signing secret |
| `NEXUS_AUDIT_KEY`                                | HMAC key for the chained audit log (64-hex / 32 bytes)                                                                                                                                          |
| `NEXUS_SECRETS_KEY`                              | AES key for saved provider keys and connector credentials (64-hex / 32 bytes)                                                                                                                   |
| `NEXUS_WORKSPACE_DIR`                            | Folder @file and @symbol chat mentions may read; unset disables them                                                                                                                            |
| `GROQ_API_KEY`                                   | Server-side default LLM provider (or any other driver key)                                                                                                                                      |

Full reference: [`.env.example`](../.env.example).

> **Runtime reads the `NEXUS_`-prefixed names.** User sign-in / token issuance returns
> `500 "NEXUS_JWT_SECRET is not set"` if you set the bare `JWT_SECRET`/`AUDIT_LOG_KEY`
> names. Always set `NEXUS_JWT_SECRET`, `NEXUS_AUDIT_KEY`, and `NEXUS_SECRETS_KEY`.

For BYOK secret encryption, `NEXUS_SECRETS_KEY` (64-hex / 32 bytes) is required. The
provider-key store **fails closed** without it — it refuses to persist rather than store
plaintext.

OAuth connectors (optional):

| Variable                                                           | Provider                        |
| ------------------------------------------------------------------ | ------------------------------- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`                        | Google Drive + Sign-In          |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`                        | GitHub connector                |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET` | Slack connector                 |
| `OAUTH_REDIRECT_BASE`                                              | Base URL of your API deployment |

> **BYOK model:** users supply their own LLM keys on the Provider Keys page; they are
> encrypted at rest and resolved server-side. `GROQ_API_KEY` is only the server-side
> default for system/internal tasks (e.g. code-agent planning) — not per-user AI spend.

## Render (live deployment)

```
API + UI → Render (one free web service, infra/web/Dockerfile, render.yaml)
DB       → Neon   (PostgreSQL + pgvector)
```

`render.yaml` is a Render Blueprint: the API serves the built UI and runs the worker
loop in-process when `REDIS_URL` is unset. Set the `sync: false` variables in the
Render dashboard; `OAUTH_REDIRECT_BASE` and `ALLOWED_ORIGINS` are the service's own
`https://<name>.onrender.com` URL. Free instances sleep when idle, so the first
request after a quiet spell takes about a minute.

A value set in the dashboard wins over `render.yaml`. Keep `NEXUS_TRUST_PROXY` as the blueprint
lists it (Cloudflare, then Render's edge, then a local hop): a hop count stops the API from
starting, and a shorter list makes every user look like one proxy address to rate limits and
security notices. Set `NEXUS_PUBLIC_URL` to the service URL for passkeys and mail links. When a
deploy does not go live, Render's Events show `update_failed` and the start-up log says why.

> The dashboard talks to two route layers: `/api/v1/*` are the real, DB-backed handlers
> (auth, council, memory, billing, feature-flags, projects, image-gen, voice, scraping). The broader `/api/*` surface is served by an in-memory bridge for
> demonstration and returns synthetic data.

## Offline machine (no Docker, no Ollama, no server database)

Nexus runs on a laptop with Node and nothing else. This is the path for a first look,
a locked-down workstation, or a storage-limited machine where a 4 GB sandbox image and
a model download are out of reach.

```bash
pnpm install
cp .env.example .env        # then set NEXUS_API_KEY to any dev value
pnpm --filter @nexus/cli exec nexus doctor   # says what is missing and what to do
pnpm dev                     # api + ui
curl -s localhost:4000/health | jq .          # { "status": "ok" }
```

What still works: sign-in, threads, missions, notifications, the knowledge base with
its embedded store, the CLI, and the UI. What does not, and why:

| Missing          | Consequence                                          | What the surface says                                           |
| ---------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| A model provider | No chat, no council, no research synthesis           | `/health/ready` reports the provider probe; the UI names it     |
| Docker           | No sandboxed code execution                          | `GET /api/v1/sandbox/status` says `unavailable` with the fix    |
| Ollama           | No local model (a cloud driver key works)            | `nexus doctor` names the install, not an error                  |
| Redis / Postgres | Single process only, data does not survive a restart | `/health/ready` `kv`/`db` legs; `docs/OPS.md` §3 lists backends |

The embedded database (`pglite://`, the default when `DATABASE_URL` is unset) and the
in-process KV fallback are what make that true. `apps/api/tests/lib/offline-mode.test.ts`
boots the server with every network-shaped variable removed and asserts `/health` is
`200` with `{"status":"ok"}`, that readiness answers instead of crashing, and that the
`kv` leg — the only one with no external dependency offline — passes. The `offline boot`
CI job runs that file on a bare runner, so a new import that needs Docker cannot make
"works offline" untrue without turning CI red.

## Docker Compose (local only)

Compose is the local development stack, not a deployment target:

```bash
docker compose -f docker-compose.yml up -d
```

Render is the single supported deployment. The Vercel proxy, the Fly config and the
Helm/Terraform trees were deleted; do not reintroduce a second target.

## Observability stack

Adds Prometheus, Grafana, OTel Collector, and Jaeger to the local stack:

```bash
docker compose -f docker-compose.yml -f infra/docker/docker-compose.observability.yml up
```

| Service    | URL                    |
| ---------- | ---------------------- |
| Grafana    | http://localhost:3010  |
| Prometheus | http://localhost:9090  |
| Jaeger     | http://localhost:16686 |

## Scaling

See [`runbook.md`](runbook.md) for production operations: connection pooling, worker
scaling, observability, and pgvector tuning at scale.

## Free-tier rebuild

Deploy in order: **Neon** (migrate with `pnpm run db:migrate` from `packages/db`) →
**Render** (New → Blueprint, pick this repo; `render.yaml` creates the `nexus` service).
Redis Cloud (raw TCP, eviction `noeviction`) and Browserbase
(`BROWSER_CDP_URL=wss://connect.browserbase.com?apiKey=…`) are optional.

Required variables (exact names — the code reads `NEXUS_*`, not
`JWT_SECRET`/`SCRYPT_SECRET`): `DATABASE_URL`, `REDIS_URL`, `NEXUS_API_KEY`,
`NEXUS_JWT_SECRET`, `NEXUS_SECRETS_KEY`, `NEXUS_AUDIT_KEY`, `NODE_ENV=production`,
plus the LLM keys you use (`GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
`MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `TAVILY_API_KEY`,
`BROWSER_CDP_URL`). Generate the four 64-hex secrets with `openssl rand -hex 32`.

Gotchas already fixed — do not reintroduce: Dockerfiles build with
`pnpm --filter "@nexus/api..."` (topological — don't hand-order packages);
auth needs the `maxmem` scrypt option; the runtime is ESM (`import.meta.url`);
BullMQ needs raw TCP Redis; the worker is optional (chat/auth/browser-agent run
synchronously in the API without it).

Deploy smoke test:

```bash
B=https://<your-service>.onrender.com
curl $B/health                                    # 200
EM="t$(date +%s)@x.co"
TOK=$(curl -s -X POST $B/api/v1/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EM\",\"password\":\"Test12345!\",\"name\":\"t\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
curl $B/api/v1/auth/me -H "Authorization: Bearer $TOK"   # 401-free authed response
```

## Desktop release: signing, feed and verification

The `Release` workflow builds the installers only on a `v*` tag, and the tag must equal
`apps/desktop/package.json` (the job fails otherwise). Signing material lives only in GitHub:

| Kind                | Name                                              | Meaning                                              |
| ------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| Secret              | `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`    | Windows code-signing certificate and password        |
| Secret              | `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`        | Developer ID Application certificate and password    |
| Secret              | `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` | notarisation; absent leaves the app unnotarised      |
| Secret              | `UPDATE_SIGNING_KEY`                              | Ed25519 private key (PEM) that signs `manifest.json` |
| Repository variable | `UPDATE_PUBLIC_KEY`                               | matching public key (PEM or base64 SPKI), baked in   |

Create the update keypair once and keep the private half only in GitHub:

```bash
openssl genpkey -algorithm ED25519 -out update-signing-key.pem
openssl pkey -in update-signing-key.pem -pubout -out update-public.pem
# UPDATE_SIGNING_KEY  = cat update-signing-key.pem, into the repository secret
# UPDATE_PUBLIC_KEY   = cat update-public.pem, into the repository variable
```

The build bakes `NEXUS_UPDATE_FEED_URL` (defaulting to
`https://github.com/<owner>/<repo>/releases/latest/download`) and `UPDATE_PUBLIC_KEY` into
`dist/update-config.json`; without them the tag build fails rather than shipping an app that
cannot update. The feed is the release's own `manifest.json` and `manifest.json.sig`, so a
public repository needs no second bucket. For a private repository or a staged rollout, set
`NEXUS_UPDATE_FEED_URL` to a host that serves those two files and keeps the previous version's
artifacts.

Before tagging, run the static wiring check and, after downloading a release, verify it without
installing:

```bash
pnpm check:release
pnpm release:verify --dir release --public-key update-public.pem
```

### Update-channel compatibility record

Both packaging dependencies are pinned exactly, because a toolchain that moves on its own is a
release that fails without a code change. `node scripts/electron-current.mjs --check` compares
this table with `apps/desktop/package.json` and fails when they disagree; run it with `--online`
to ask the registry, which is a weekly question rather than a per-pull-request one.

| Dependency         | Pinned    | Checked against the registry | Result                                             |
| ------------------ | --------- | ---------------------------- | -------------------------------------------------- |
| `electron`         | `45.4.1`  | `45.4.1` is the latest       | current; no bump to test                           |
| `electron-builder` | `26.18.0` | `26.18.0` is the latest      | current; supports the Electron 45 packaging format |

What "compatible" means here, and what was actually run:

- **Artifact names.** `electron-builder.yml` writes `Nexus-Setup-${version}.${ext}` and the
  macOS `dmg`. The updater's manifest names a URL per platform and arch and verifies `sha256`
  and `size` before installing, so the filename scheme is not load-bearing — a renamed artefact
  still updates, because the manifest carries its own hash. That is why there is no
  channel-name string anywhere in the two to break.
- **Version comparison.** The updater compares the manifest's `version` with the running
  `app.getVersion()` semver-wise, not lexically, so `0.10.0` correctly outranks `0.9.0`.
- **Channel and staged rollout.** The manifest may carry `channel` and
  `rollout: { percentage }`; both are optional, and a manifest without them behaves exactly as
  before (one channel, everybody). When present, the app honours them:
  `describeUpdate()` (`apps/desktop/src/updater.ts`) names the channel in what it reports and
  decides wave membership from a hash of the install id and the version, so a machine cannot
  flip between waves on repeated checks. `NEXUS_UPDATE_CHANNEL` (or a `channel` field in
  `update-config.json`) sets the channel a build follows. The tray's **Check for updates now…**
  reports the channel, the offered version and the rollout state, or the reason there is none —
  "up to date on channel beta" is a different sentence from "up to date on stable", and people
  misread the second when they mean the first.
- **Electron 45 specific.** `app.getVersion()`, `session.setPermissionRequestHandler` and the
  `utilityProcess` API used by the API sidecar are all present in 45; nothing in the shell uses
  a deprecated remote module or `webContents.sendInputEvent` behaviour that changed.
- **Not verified here:** an actual signed install → update → restart cycle needs the code-signing
  certificates and a published release. That is the desktop equivalent of the backup drill: the
  procedure and the guards exist, the run is owed to a machine with the secrets.
