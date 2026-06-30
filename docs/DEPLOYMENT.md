<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Deployment

Production deployment options and the full environment-variable reference. For local
development see the [README Quick Start](../README.md#quick-start). For day-2 operations
(scaling, incidents, backup/DR) see [`runbook.md`](runbook.md).

## Environment variables

Minimum required to start:

| Variable        | Description                                                |
| --------------- | ---------------------------------------------------------- |
| `NEXUS_API_KEY` | Master API key for all `/api/v1/*` requests                |
| `DATABASE_URL`  | PostgreSQL connection string (with pgvector)               |
| `JWT_SECRET`    | HS256 signing secret for user auth tokens                  |
| `GROQ_API_KEY`  | Server-side default LLM provider (or any other driver key) |

Full reference: [`.env.example`](../.env.example).

For BYOK secret encryption, set `NEXUS_SECRETS_KEY` (64-hex / 32 bytes). The provider-key
store **fails closed** without it — it will refuse to persist rather than store plaintext.

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

## Render + Vercel (recommended free tier)

```
API  → Render   (apps/api, Docker)
UI   → Vercel   (apps/ui, static SPA)
DB   → Neon     (PostgreSQL + pgvector)
KV   → Upstash  (Redis — optional, in-memory fallback included)
```

Set all environment variables from `.env.example` in your Render service. The Vercel UI
proxies `/api/*` to the Render API via `vercel.json` rewrites.

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

Manifests for individual services live in `infra/k8s/`. Terraform modules for GKE/EKS are
in `infra/terraform/`.

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
