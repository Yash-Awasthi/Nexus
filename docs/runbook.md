<!-- SPDX-License-Identifier: Apache-2.0 -->
# NEXUS Operational Runbook

**Version:** 1.0  
**Last updated:** 2026-06-11  
**Owner:** Yash Awasthi  
**Audience:** On-call engineers, DevOps, platform operators

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
- Node 20 LTS (`nvm use 20`)
- pnpm 9 (`npm i -g pnpm@9`)
- Python 3.11 (`pyenv install 3.11`)

### Start everything

```bash
# 1. Clone and install
git clone https://github.com/Yash-Awasthi/Nexus.git
cd Nexus
cp .env.example .env          # fill in GROQ_API_KEY, NEXUS_API_KEY, etc.

# 2. Start infrastructure (Postgres + Redis + OTel collector)
docker compose -f docker-compose.yml up -d postgres redis otel-collector

# 3. Apply DB migrations
pnpm --filter @nexus/db drizzle:migrate

# 4. Start all services (hot-reload)
pnpm dev
# or individually:
pnpm --filter @nexus/api dev           # :3000
pnpm --filter @nexus/worker dev        # background worker
pnpm --filter @nexus/web dev           # :5173
cd services/ingest && uvicorn nexus_ingest.api:app --reload --port 8000
```

### Verify

```bash
curl http://localhost:3000/health          # {"status":"ok"}
curl http://localhost:3000/health/ready    # {"status":"ready","checks":{"db":"ok"}}
curl http://localhost:8000/health          # {"status":"ok","scrapers":[...]}
nexus health                               # ✓ API is ok
```

---

## 2. Deployment targets

### 2.1 Single VM (install script)

```bash
curl -fsSL https://nexus.dev/install.sh | bash
# Installs: Docker, composes all services, creates systemd units
# Data: /var/lib/nexus/{postgres,redis,uploads}
```

### 2.2 Docker Compose (production)

```bash
cp docker-compose.yml docker-compose.prod.yml
# Set NEXUS_API_KEY, DATABASE_URL, REDIS_URL, GROQ_API_KEY in .env
docker compose -f docker-compose.prod.yml up -d
```

### 2.3 Kubernetes (Helm)

```bash
# Add chart repo (once published)
helm repo add nexus https://charts.nexus.dev
helm repo update

# Install with custom values
helm install nexus nexus/nexus \
  --namespace nexus-system --create-namespace \
  --values infra/helm/nexus/values.yaml \
  --set api.env.NEXUS_API_KEY=$NEXUS_API_KEY \
  --set db.url=$DATABASE_URL \
  --set redis.url=$REDIS_URL

# Check rollout
kubectl rollout status deployment/nexus-api -n nexus-system
```

### 2.4 Terraform (Fly.io)

```bash
cd infra/terraform/examples/fly
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan
terraform apply
```

---

## 3. Service topology

| Service | Port | Repo path | Healthcheck |
|---------|------|-----------|-------------|
| `nexus-api` | 3000 | `apps/api` | `GET /health` |
| `nexus-worker` | — | `apps/worker` | Process alive + Redis ping |
| `nexus-web` | 5173 (dev) / 80 (prod) | `apps/web` | Static serve |
| `nexus-ingest` | 8000 | `services/ingest` | `GET /health` |
| `postgres` | 5432 | `infra/docker` | `pg_isready` |
| `redis` | 6379 | `infra/docker` | `PING` |
| `otel-collector` | 4317 (gRPC) / 4318 (HTTP) | `infra/otel` | `/metrics` |

---

## 4. Day-2 operations

### 4.1 Logs

```bash
# Docker Compose
docker compose logs -f nexus-api
docker compose logs -f nexus-worker --since 1h

# Kubernetes
kubectl logs -l app=nexus-api -n nexus-system -f
kubectl logs -l app=nexus-worker -n nexus-system -f --previous  # crashed pod

# Structured log fields (all services emit JSON)
kubectl logs -l app=nexus-api | jq 'select(.level=="error")'
```

### 4.2 Metrics

- **Prometheus:** `http://localhost:9090` → scrapes `nexus-api:3000/metrics`, `nexus-ingest:8000/metrics`
- **Grafana:** `http://localhost:3001` → dashboards: _Overview_, _Council_, _Ingest_, _Queue Depth_
- **Key metrics to watch:**
  - `nexus_api_request_duration_p99` — API latency
  - `nexus_council_deliberation_duration_avg` — council latency
  - `bullmq_queue_waiting{queue="nexus-high"}` — queue depth
  - `nexus_worker_job_failure_total` — job failures

### 4.3 Traces

- **Tempo:** `http://localhost:3001/explore` → data source Tempo
- Trace ID is in every API response header: `X-Nexus-Trace-Id`
- Filter by `service.name=nexus-api` or `service.name=nexus-worker`

### 4.4 Queue management

```bash
# View queue state
nexus tasks list --status queued --limit 20

# View dead-letter queue
redis-cli -n 0 lrange bull:nexus-high:failed 0 -1

# Retry a specific failed job (BullMQ)
# Connect to worker process and call queue.retryJobs() or use Bull Board UI

# Drain DLQ entirely (last resort)
nexus dlq clear
```

### 4.5 Database queries

```bash
# Connect to Postgres
psql $DATABASE_URL

# Pending approvals
SELECT id, action, requestor, created_at FROM approval_requests WHERE status='pending';

# Recent failed tasks
SELECT id, type, error, completed_at FROM runtime_tasks WHERE status='failed' ORDER BY completed_at DESC LIMIT 20;

# Audit log tail
SELECT sequence, entity_type, action, actor, created_at FROM audit_log ORDER BY sequence DESC LIMIT 10;
```

### 4.6 Audit log verification

```bash
nexus audit verify
# ✓ Chain intact — 1247 entries checked

# If verification fails:
curl -s $NEXUS_API_URL/api/v1/audit/log/verify | jq .
# {"valid":false,"first_broken_sequence":842,"message":"Chain integrity violation detected"}
# → Investigate DB access logs for sequence 842
```

---

## 5. Scaling guidelines

| Component | Scale trigger | Action |
|-----------|--------------|--------|
| `nexus-api` | p99 latency > 500ms | Add replicas; set `HPA minReplicas=2` |
| `nexus-worker` | Queue depth > 500 sustained | Add worker replicas; increase `concurrency` |
| `nexus-ingest` | Scrape backlog > 30min | Add ingest replicas; reduce `FINSCRAPE_MAX_ARTICLES` |
| Postgres | CPU > 70%, connections > 80% | Enable PgBouncer; scale to larger instance |
| Redis | Memory > 80% | Increase `maxmemory`; enable cluster mode |

---

## 6. Incident response playbooks

### P1 — API completely down

```
1. Check: curl https://nexus-api-host/health
2. If 502/504: load balancer can't reach the container — check container health
   docker ps / kubectl get pods -n nexus-system
3. If container is crash-looping:
   docker logs nexus-api --tail 50
   kubectl logs nexus-api-<pod> --previous
4. Common causes:
   - DATABASE_URL unreachable → check Postgres / network
   - NEXUS_API_KEY not set → check env vars
   - OOM → increase container memory limit
5. Rollback if recent deploy:
   helm rollback nexus N-1 -n nexus-system
   # or docker-compose:
   docker compose down nexus-api && docker compose up -d nexus-api --no-recreate
```

### P2 — Worker stuck / queue growing

```
1. Check queue depth:
   redis-cli llen bull:nexus-high:wait
   redis-cli llen bull:nexus-medium:wait

2. Check worker health:
   docker ps | grep nexus-worker
   kubectl get pods -l app=nexus-worker

3. Check DLQ for patterns:
   redis-cli lrange bull:nexus-high:failed 0 10

4. If jobs are timing out: check GROQ_API_KEY validity, Groq service status

5. Force drain and restart:
   kubectl rollout restart deployment/nexus-worker -n nexus-system
```

### P3 — Database connection exhaustion

```
1. Check active connections:
   psql $DATABASE_URL -c "SELECT count(*) FROM pg_stat_activity;"

2. Kill long-running idle connections:
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity
   WHERE state = 'idle' AND query_start < now() - interval '10 minutes';

3. Deploy PgBouncer if not already running:
   docker compose -f infra/docker/docker-compose.pgbouncer.yml up -d

4. Reduce pool sizes in nexus-api (DB_POOL_MAX env var, default 10)
```

### P4 — Audit chain broken (T3 incident)

```
1. Confirm via API:
   curl $NEXUS_API_URL/api/v1/audit/log/verify | jq .
   # Records first_broken_sequence

2. Do NOT delete any audit_log rows. Preserve state for forensics.

3. Pull DB access logs for the timestamp of sequence N-1 → N:
   grep "audit_log" /var/log/postgres/postgresql.log | grep "UPDATE\|DELETE"

4. Engage security response per SECURITY.md

5. Export intact portion (sequences 1..N-1) to signed S3 object for evidence preservation

6. Notify affected parties per data breach policy
```

### P5 — LLM cost spike

```
1. Check Groq dashboard for unusual usage

2. Identify runaway deliberations:
   SELECT id, created_at, cost_usd FROM verdicts ORDER BY cost_usd DESC LIMIT 10;

3. Reduce default budget cap:
   NEXUS_COUNCIL_DEFAULT_BUDGET_USD=0.05 (restart api + worker)

4. Block council endpoint temporarily:
   Add route-level circuit breaker in apps/api/src/routes/council.ts
```

---

## 7. Backup and disaster recovery

### 7.1 Postgres backup

```bash
# Automated: runs daily at 02:00 UTC via cron/k8s CronJob
pg_dump $DATABASE_URL | gzip | \
  aws s3 cp - s3://nexus-backups/postgres/$(date +%Y%m%d_%H%M%S).sql.gz

# Verify last backup (run this as part of monitoring)
aws s3 ls s3://nexus-backups/postgres/ | tail -1
```

### 7.2 PITR restore procedure

```bash
# 1. Stop all services that write to Postgres
docker compose stop nexus-api nexus-worker nexus-ingest

# 2. Restore from backup
aws s3 cp s3://nexus-backups/postgres/20260611_020000.sql.gz - | \
  gunzip | psql $DATABASE_URL

# 3. Verify audit chain after restore
curl $NEXUS_API_URL/api/v1/audit/log/verify

# 4. Restart services
docker compose start nexus-api nexus-worker nexus-ingest
```

### 7.3 Redis backup

Redis is ephemeral queue state. On failure:
1. Restart Redis — BullMQ workers will continue from DB-resident state
2. `SignalWorker` polls `ingested_events` and repopulates the queue automatically

### 7.4 Recovery time objectives

| Scenario | RTO | RPO |
|----------|-----|-----|
| API pod crash | < 30s (container restart) | 0 |
| Worker pod crash | < 30s | 0 (jobs persisted in Redis) |
| Redis failure | < 5min | < 5min (in-flight jobs) |
| Postgres failure | < 1hr | < 24hr (daily backup) |
| Full datacenter loss | < 4hr | < 24hr |

---

## 8. Upgrade and rollback

### 8.1 Rolling upgrade (Kubernetes)

```bash
# Pull new image tag
helm upgrade nexus nexus/nexus \
  --namespace nexus-system \
  --set api.image.tag=v1.1.0 \
  --set worker.image.tag=v1.1.0 \
  --wait --timeout 5m

# Monitor rollout
kubectl rollout status deployment/nexus-api -n nexus-system

# If unhealthy:
helm rollback nexus -n nexus-system
```

### 8.2 DB schema migration

```bash
# Always run migrations before upgrading services
pnpm --filter @nexus/db drizzle:migrate

# If migration fails, roll back the migration:
pnpm --filter @nexus/db drizzle:migrate:rollback

# NEVER upgrade services without a corresponding migration
```

### 8.3 Rollback checklist

- [ ] Helm rollback command executed
- [ ] Health check passing on previous version
- [ ] Queue depth normal
- [ ] Audit chain intact
- [ ] No DB schema mismatch errors in logs

---

## 9. Configuration reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | ✅ | — | Postgres connection string |
| `REDIS_URL` | ✅ | `redis://localhost:6379` | Redis connection |
| `NEXUS_API_KEY` | ✅ | — | Bearer token for API auth |
| `NEXUS_AUDIT_KEY` | ✅ | — | HMAC key for audit chain |
| `GROQ_API_KEY` | ✅ | — | Groq LLM provider key |
| `NEXUS_INGEST_API_KEY` | ✅ | — | Key for ingest service |
| `NEXUS_COUNCIL_URL` | ❌ | `http://localhost:3000` | Council service URL |
| `NEXUS_INGEST_URL` | ❌ | `http://localhost:8000` | Ingest service URL |
| `LOG_LEVEL` | ❌ | `info` | `debug`, `info`, `warn`, `error` |
| `PORT` | ❌ | `3000` | API server port |
| `SIGNAL_WORKER_INTERVAL_MS` | ❌ | `5000` | Signal worker poll interval |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | ❌ | — | OTel collector endpoint |
| `ALLOWED_SCRAPE_HOSTS` | ❌ | allowlist | Comma-separated scraper hostnames |
| `NEXUS_COUNCIL_DEFAULT_BUDGET_USD` | ❌ | `0.10` | Default per-deliberation LLM budget |

---

## 10. SLOs and alerts

See `docs/slos.md` for full SLO declarations. Summary:

| SLO | Target | Alert threshold |
|-----|--------|----------------|
| API availability | 99.5% | < 99% over 5min |
| API p99 latency | < 500ms | > 750ms over 5min |
| Council deliberation success rate | 99% | < 97% over 15min |
| Queue job processing rate | < 30s p99 | > 60s p99 over 10min |
| Audit log chain integrity | 100% | Any breach |

Alert destinations: PagerDuty (Critical), Slack `#nexus-alerts` (Warning).
