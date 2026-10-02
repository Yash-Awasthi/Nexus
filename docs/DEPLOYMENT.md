<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Deployment

Production deployment options and the full environment-variable reference. For local
development see the [README Quick Start](../README.md#quick-start). For day-2 operations
(scaling, incidents, backup/DR) see [`runbook.md`](runbook.md).

## Environment variables

Minimum required to start:

| Variable                                         | Description                                                                                                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXUS_API_KEY`                                  | Master API key for all `/api/v1/*` requests                                                                                                                                                     |
| `DATABASE_URL`                                   | PostgreSQL connection string (with pgvector)                                                                                                                                                    |
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

> The dashboard talks to two route layers: `/api/v1/*` are the real, DB-backed handlers
> (auth, council, memory, connectors, billing, feature-flags, projects, image-gen, voice,
> scraping). The broader `/api/*` surface is served by an in-memory bridge for
> demonstration and returns synthetic data.

## Docker Compose (production)

```bash
docker compose -f docker-compose.yml up -d
```

## Kubernetes

```bash
helm upgrade --install nexus infra/helm/nexus \
  --set image.tag=latest \
  --set env.DATABASE_URL="$DATABASE_URL" \
  --set env.NEXUS_API_KEY="$NEXUS_API_KEY"
```

Terraform modules for GKE/EKS are in `infra/terraform/`.

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

See [ROADMAP.md](../ROADMAP.md#14-production-multi-tenant-hardening) for production
hardening — connection pooling, worker scaling, observability, and pgvector tuning at scale.

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
curl $B/api/v1/drive/status -H "Authorization: Bearer $TOK"   # 401-free authed response
```
