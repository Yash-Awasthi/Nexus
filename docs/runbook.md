<!-- SPDX-License-Identifier: Apache-2.0 -->

# Nexus Operational Runbook

**Version:** 1.1  
**Last updated:** 2026-11-23  
**Owner:** Yash Awasthi  
**Audience:** On-call engineers and operators

---

## Table of contents

1. [Quick-start (local dev)](#1-quick-start-local-dev)
2. [Deployment targets](#2-deployment-targets)
3. [Service topology](#3-service-topology)
4. [Day-2 operations](#4-day-2-operations)
5. [Scaling guidelines](#5-scaling-guidelines)
6. [Incident response playbooks](#6-incident-response-playbooks)
7. [Backup and disaster recovery](#7-backup-and-disaster-recovery)
8. [Upgrade and rollback](#8-upgrade-and-rollback)
9. [Configuration reference](#9-configuration-reference)
10. [SLOs and alerts](#10-slos-and-alerts)

---

## 1. Quick-start (local dev)

### Prerequisites

- Docker 25+ and Docker Compose v2
- Node 24+ (`.nvmrc` pins 26)
- pnpm 12 (`npm i -g pnpm@12`)
- Python 3.11 only if you run `services/ingest`

### Start everything

```bash
git clone https://github.com/Yash-Awasthi/Nexus.git
cd Nexus
cp .env.example .env          # set NEXUS_API_KEY and one LLM key

pnpm install
docker compose up -d postgres redis
pnpm db:migrate
pnpm dev                      # API :3000, UI :5173, worker
```

Or the whole stack in Docker:

```bash
docker compose up --build     # API :3000, built UI :4173
```

### Verify

```bash
curl http://localhost:3000/health          # {"status":"ok"}
curl http://localhost:3000/health/ready    # database and KV status
pnpm --filter @nexus/cli exec nexus health # ✓ API is ok
```

---

## 2. Deployment targets

### 2.1 Render (the supported hosted deployment)

`render.yaml` describes one Docker web service running `infra/web/Dockerfile`,
which serves the API and the built UI. The API runs the worker loop in-process
when no queue is configured. Secrets are set in the Render dashboard, not in the
blueprint; `render.yaml` marks them `sync: false`.

`autoDeploy: true` follows `master`. The health check is `/health/ready`, which
answers only after the database and KV are usable.

### 2.2 Docker Compose

`docker-compose.yml` is the full local stack. For a server, run the same file with
real secrets in `.env`:

```bash
docker compose up -d --build
docker compose ps
```

`migrate` runs to completion before `api` starts. There is no install script, no
Helm chart and no Terraform tree; a second orchestration target is deliberately
not maintained.

---

## 3. Service topology

| Service          | Port                      | Repo path         | Healthcheck                |
| ---------------- | ------------------------- | ----------------- | -------------------------- |
| `api`            | 3000 (host) → 3001        | `apps/api`        | `GET /health/ready`        |
| `worker`         | —                         | `apps/worker`     | Process alive + Redis ping |
| `ui`             | 4173 (host) → 80          | `apps/ui`         | Static serve               |
| `ingest`         | 8000                      | `services/ingest` | `GET /health`              |
| `postgres`       | 127.0.0.1:5432            | compose           | `pg_isready`               |
| `redis`          | 127.0.0.1:6379            | compose           | `PING`                     |
| `otel-collector` | 4317 (gRPC) / 4318 (HTTP) | `infra/otel`      | Collector self-metrics     |
| `jaeger`         | 16686                     | compose profile   | UI reachable               |

`ui-dev`, `sandbox` and the observability services are opt-in profiles.

---

## 4. Day-2 operations

### 4.1 Logs

```bash
docker compose logs -f api
docker compose logs -f worker --since 1h
docker compose logs -f ingest

# Errors only (all services emit JSON)
docker compose logs api | jq 'select(.level=="error")'
```

On Render, use the service's log stream; the same JSON fields apply.

### 4.2 Metrics

- **Prometheus:** `http://localhost:9090` scrapes `api:3001/api/v1/metrics` and the
  OTel collector. Local dev sets `METRICS_NO_AUTH=true`; production scrapes with a
  bearer token.
- **Grafana:** `http://localhost:3010`, pre-provisioned with the _Nexus overview_ and
  _Provider health_ dashboards.
- **Exported series:** `nexus_gateway_requests_total`, `nexus_gateway_latency_ms`,
  `nexus_gateway_tokens_total`, `nexus_gateway_cost_usd_total`,
  `nexus_memory_entries_total`, `nexus_drive_*`, `nexus_alert_events_total`,
  `nexus_slo_availability`, `nexus_slo_error_rate`, `nexus_slo_p99_latency_ms`,
  `nexus_slo_total_requests`.
- Queue depth is not exported yet; read it from Redis (below) or the BullMQ dashboard.

### 4.3 Traces

- **Jaeger:** `http://localhost:16686` (observability profile).
- The trace id is returned as `X-Nexus-Trace-Id`.
- Filter by `service.name=nexus-api` or `service.name=nexus-worker`.

### 4.4 Queue management

```bash
# Queue lengths
redis-cli llen bull:nexus-high:wait
redis-cli llen bull:nexus-medium:wait

# Failed jobs
redis-cli lrange bull:nexus-high:failed 0 10

# Runtime tasks through the CLI
pnpm --filter @nexus/cli exec nexus tasks list --status queued --limit 20
```

There is no `nexus dlq clear` command. Retry from BullMQ or drain the failed set
explicitly after inspecting it.

### 4.5 Database queries

```bash
psql "$DATABASE_URL"

# Pending approvals
SELECT id, action, requestor, created_at FROM approval_requests WHERE status='pending';

# Recent failed tasks
SELECT id, type, error, completed_at FROM runtime_tasks
WHERE status='failed' ORDER BY completed_at DESC LIMIT 20;

# Audit log tail
SELECT sequence, entity_type, action, actor, created_at
FROM audit_log ORDER BY sequence DESC LIMIT 10;
```

### 4.6 Audit log verification

```bash
pnpm --filter @nexus/cli exec nexus audit verify

curl -s "$NEXUS_API_URL/api/v1/audit/log/verify" \
  -H "Authorization: Bearer $NEXUS_API_KEY" | jq .
# {"valid":false,"firstBrokenSequence":842,...}
# → investigate database access at that sequence
```

---

## 5. Scaling guidelines

| Component | Scale trigger                | Action                                                 |
| --------- | ---------------------------- | ------------------------------------------------------ |
| `api`     | p99 latency > 500ms          | Raise the Render instance count or plan                |
| `worker`  | Queue depth > 500 sustained  | Add worker replicas; raise BullMQ `concurrency`        |
| `ingest`  | Scrape backlog > 30min       | Add ingest replicas; lower `FINSCRAPE_MAX_ARTICLES`    |
| Postgres  | CPU > 70%, connections > 80% | Raise the Neon compute size; use the pooled connection |
| Redis     | Memory > 80%                 | Raise `maxmemory`; move to a managed instance          |

---

## 6. Incident response playbooks

### P1 — API completely down

```
1. Check: curl https://<host>/health/ready
2. 502/504: the platform cannot reach the container — check the service status.
   Render: dashboard events and logs.
   Compose: docker compose ps
3. Crash loop:
   docker compose logs api --tail 50
4. Common causes:
   - DATABASE_URL unreachable → check Postgres / Neon
   - NEXUS_API_KEY not set → check env vars
   - OOM → raise the instance memory
5. Roll back the deploy (Render: previous deploy; compose: rebuild the previous tag).
```

### P2 — Worker stuck / queue growing

```
1. Queue depth:
   redis-cli llen bull:nexus-high:wait
   redis-cli llen bull:nexus-medium:wait
2. Worker health: docker compose ps worker
3. Failed jobs: redis-cli lrange bull:nexus-high:failed 0 10
4. If jobs time out: check the provider key and the provider's status page.
5. Restart: docker compose restart worker
```

### P3 — Database connection exhaustion

```
1. Active connections:
   psql "$DATABASE_URL" -c "SELECT count(*) FROM pg_stat_activity;"
2. Idle sessions older than ten minutes:
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity
   WHERE state = 'idle' AND query_start < now() - interval '10 minutes';
3. Use the pooled Neon connection string on the server.
4. Lower the API pool size if the client is the source.
```

### P4 — Audit chain broken (T3 incident)

```
1. Confirm: GET /api/v1/audit/log/verify, or `nexus audit verify`.
2. Do NOT delete audit_log rows. Preserve state for forensics.
3. Pull database access logs for the timestamp of sequence N-1 → N.
4. Engage security response per SECURITY.md.
5. Export the intact portion (sequences 1..N-1) as evidence.
6. Notify affected parties per the breach policy.
```

### P5 — LLM cost spike

```
1. Check the provider dashboard for unusual usage.
2. Identify expensive deliberations:
   SELECT id, created_at, cost_usd FROM verdicts ORDER BY cost_usd DESC LIMIT 10;
3. Lower the per-request budget with the `budgetUsd` field on the council call.
4. Disable the offending provider key or model in Provider Keys.
```

---

## 7. Backup and disaster recovery

### 7.1 Postgres backup

The hosted deployment uses Neon, which keeps continuous backups and point-in-time
restore. For a self-hosted Postgres:

```bash
pg_dump "$DATABASE_URL" | gzip > nexus-$(date +%Y%m%d_%H%M%S).sql.gz
```

### 7.2 Restore procedure

```bash
# 1. Stop writers
docker compose stop api worker ingest

# 2. Restore
gunzip -c nexus-20261123_020000.sql.gz | psql "$DATABASE_URL"

# 3. Verify the audit chain after restore
curl -s "$NEXUS_API_URL/api/v1/audit/log/verify" \
  -H "Authorization: Bearer $NEXUS_API_KEY" | jq .

# 4. Restart
docker compose start api worker ingest
```

### 7.3 Redis backup

Redis holds queue state and the shared KV. BullMQ jobs also exist in Postgres-backed
records, and `SignalWorker` repopulates from `ingested_events`, so a Redis restart is
recoverable. The shared KV is the exception: without persistence, threads,
notifications and the usage log lose their Redis copy. Use a managed Redis with
persistence in production.

### 7.4 Recovery time objectives

| Scenario         | RTO                      | RPO                         |
| ---------------- | ------------------------ | --------------------------- |
| API restart      | < 30s (platform restart) | 0                           |
| Worker restart   | < 30s                    | 0 (jobs persisted in Redis) |
| Redis failure    | < 5min                   | < 5min (in-flight jobs)     |
| Postgres failure | Neon PITR                | Per Neon retention          |

---

## 8. Upgrade and rollback

### 8.1 Render

Push to `master`; `autoDeploy` rolls the service. If the new version is unhealthy,
use **Rollback** on the previous deploy in the Render dashboard.

### 8.2 Docker Compose

```bash
git pull
docker compose up -d --build   # migrate runs before api
```

### 8.3 DB schema migration

```bash
pnpm db:migrate
```

Migrations run before the API starts in compose and in the Render image. Do not
upgrade services without the matching migration.

### 8.4 Rollback checklist

- [ ] Previous image or deploy restored
- [ ] `/health/ready` passing
- [ ] Queue depth normal
- [ ] Audit chain intact
- [ ] No schema mismatch errors in logs

---

## 9. Configuration reference

| Variable                      | Required | Default                  | Description                                 |
| ----------------------------- | -------- | ------------------------ | ------------------------------------------- |
| `DATABASE_URL`                | ✅       | —                        | Postgres; unset falls back to PGlite in dev |
| `REDIS_URL`                   | ❌       | `redis://localhost:6379` | Redis; unset uses in-process KV             |
| `NEXUS_API_KEY`               | ✅       | —                        | Bearer token for API auth                   |
| `NEXUS_AUDIT_KEY`             | ✅       | —                        | HMAC key for the audit chain                |
| `NEXUS_SECRETS_KEY`           | ✅       | —                        | 64 hex chars; encrypts provider keys        |
| `NEXUS_JWT_SECRET`            | ✅       | —                        | HS256 signing secret                        |
| `GROQ_API_KEY`                | ❌       | —                        | One LLM provider is enough                  |
| `NEXUS_INGEST_API_KEY`        | ❌       | —                        | Key for the ingest service                  |
| `LOG_LEVEL`                   | ❌       | `info`                   | `debug`, `info`, `warn`, `error`            |
| `PORT`                        | ❌       | `3000`                   | API server port                             |
| `NEXUS_API_RATE_LIMIT`        | ❌       | `300`                    | Requests/minute per IP                      |
| `NEXUS_SANDBOX_IMAGE`         | ❌       | —                        | Enables skill/mission/shell code            |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | ❌       | —                        | OTel collector endpoint                     |
| `ALLOWED_SCRAPE_HOSTS`        | ❌       | allowlist                | Comma-separated scraper hostnames           |

---

## 10. SLOs and alerts

See `docs/slos.md` for the full declarations. Summary:

| SLO                               | Target    | Alert threshold    |
| --------------------------------- | --------- | ------------------ |
| API availability                  | 99.5%     | < 99% over 5min    |
| API p99 latency                   | < 500ms   | > 5s over 3min     |
| Council deliberation success rate | 99%       | < 97% over 15min   |
| Queue job processing rate         | < 30s p99 | Queue depth rising |
| Audit log chain integrity         | 100%      | Any breach         |

Grafana is the alert destination in the bundled stack. Point its contact points at
your pager or chat service if you want notifications off the box.
