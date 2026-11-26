<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- verified: c6e5d6c 2026-11-24 -->

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
11. [Rotating a credential (drill)](#11-rotating-a-credential-drill)

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

### 7.5 The drill: restore a dump into a clean instance and prove it is the same system

A dump nobody has restored is a file, not a backup. `scripts/db-backup-drill.sh` runs
the whole loop and reports the timings §7.4 needs to stay honest:

```bash
DATABASE_URL="$DATABASE_URL" \
SCRATCH_DATABASE_URL="postgres://user:pass@host/nexus_restore" \
  scripts/db-backup-drill.sh
```

`SCRATCH_DATABASE_URL` must be a **different, throwaway** database: the script drops
and recreates it before restoring, so point it at something whose loss costs nothing.
It refuses to run when the two URLs are equal — restoring over the source is how a
drill becomes an incident.

What it checks, in order:

1. `pg_dump --no-owner --no-privileges` into a gzipped file, timed.
2. `DROP DATABASE` then `CREATE DATABASE` the scratch database, so the restore proves
   the dump is self-sufficient instead of leaning on whatever was already there.
3. `psql -v ON_ERROR_STOP=1` on the gunzip'd dump — a restore that needs more than the
   dump to succeed is a restore that will fail when it is needed.
4. Every `public` base table's row count compared between the source and the restored
   copy; a single mismatch fails the drill with the table named.
5. The restored `audit_log` — the chain is what makes the log evidence, so a restore
   that keeps the rows but breaks the HMAC chain is a restore of a different system.
   Verify it against the copy:
   `DATABASE_URL="$SCRATCH_DATABASE_URL" pnpm --filter @nexus/cli exec nexus audit verify`,
   or `GET /api/v1/audit/log/verify` from an API pointed at the copy.
6. With `RUN_SUITE=1`, the API suite runs against the restored copy (the wrapper sets
   `PG_URL` and `DATABASE_URL` to scratch) — the half that takes minutes rather than
   seconds.

The retention values in §4 of `docs/OPS.md` are a floor on what a restore can contain:
a restored copy of a database whose oldest thread is 30 days old has no threads older
than 30 days, and that is expected rather than a failed restore.

Drill record — an `_unrun_` row means it has not been done:

| Date    | Restore wall time | Total wall time | Dump size | Rows restored | Who | Anything that went wrong |
| ------- | ----------------- | --------------- | --------- | ------------- | --- | ------------------------ |
| _unrun_ | —                 | —               | —         | —             | —   | —                        |

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
| Dependency status                 | 99.9% ok  | Any `down` over 2m |

Grafana is the alert destination in the bundled stack. Point its contact points at
your pager or chat service if you want notifications off the box.

### 10.1 Every alert, and what to do first

Each alert names its playbook, so the first action is never "investigate". "Paged?" is
who hears about it when nobody is looking at a dashboard.

| Alert                       | Meaning                                                   | First action                                                                 | Playbook | Paged? |
| --------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- | -------- | ------ |
| `NexusStatusDown`           | `GET /status` said `down`: a critical dependency is out    | `curl $NEXUS_URL/status` — the failing row names the dependency and the probe | P1       | yes    |
| `NexusStatusDegraded`       | A non-critical row failed: Redis, sandbox or Docker       | Read the row: Redis → queue drain is at risk; Docker → image languages only  | P2       | no     |
| `NexusAPIAvailabilityPage`  | Real requests are failing, `/health` may still be green   | Roll back the last deploy before diagnosing                              | P1       | yes    |
| `NexusAPILatencyPage`       | p99 over 5s for 3 minutes                                 | Check `/status`: a slow dependency, not a slow route                     | P1       | yes    |
| Queue depth rising          | The worker is not draining (or providers are slow)        | `llen bull:nexus-high:wait`, then `docker compose ps worker`              | P2       | yes    |
| Audit chain breach          | `audit/log/verify` is false                               | Stop writes; preserve rows; treat as T3                                  | P4       | yes    |
| Cost spike                  | Spend above the day's expectation                         | Find the dearest verdicts, then lower `budgetUsd`                         | P5       | no     |
| Dead webhook delivery       | A receiver refused five deliveries; the hook is `dead`    | Inspect `/webhooks/:id`, fix the receiver, `POST .../deliveries/:id/retry` | —        | no     |
| Update feed 5xx             | `/updates/latest.json` is unreachable for autoupdate      | Check the CDN; clients answer "feed unreachable" and keep running         | P1       | no     |

A `degraded` status is a task, not a page: the product still answers. A `down` status is a
page, because it cannot.

### 10.2 Who is told, and how to reach the owner

- **Paging:** the P1 rows above go to the on-call rotation in the bundled Grafana contact
  point. Escalation after 15 minutes of no acknowledgement is to the owner below.
- **Owner:** Yash Awasthi (maintainer). Security incidents additionally follow `SECURITY.md`.
- **Support path for users:** `SUPPORT.md` — a bug report goes to the issue tracker, a
  vulnerability goes to the private advisory channel and never to the tracker. A user who is
  reading this runbook because something broke should be sent to the status page
  (`GET /status`) first, then to `SUPPORT.md` if the report is theirs to file.
- **What is never published:** no runbook step, status row or public page names a provider,
  a key, a host or a dependency version. If a step needs one, it takes it from the environment.

---

## 11. Rotating a credential (drill)

A credential you cannot rotate on demand is a credential you will keep after it
leaks. This is the procedure, and it doubles as the drill: run it on a quiet
system, start a stopwatch at the first step, and write the wall time in the table
at the end. Two halves — one key Nexus stores **for** a user, one secret Nexus
**holds** for an OAuth client. Doing both is the point: they fail differently.

### 11.1 Provider key (BYOK) — stored, encrypted, per user

The old key must stop resolving and the new one must work, without the old value
being readable anywhere. Three minutes is the target.

1. Note the current prefix (never the value):

   ```bash
   curl -s -H "authorization: Bearer $NEXUS_TOKEN" \
     "$NEXUS_URL/api/user/provider-keys" | jq '.keys[] | {provider, keyPrefix, label}'
   ```

2. Make the old key invalid at the provider console first — revoke it there. A
   rotation that leaves the old key alive at the provider is a copy, not a
   rotation.

3. Store the replacement. Posting the same `provider` again is the rotation: the
   previous row is soft-deleted, the audit log records `provider_key.rotate`, and
   the cached driver for that user is dropped.

   ```bash
   curl -s -X POST -H "authorization: Bearer $NEXUS_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"provider":"groq","apiKey":"gsk_…new…","label":"rotated 2026-11-24"}' \
     "$NEXUS_URL/api/user/provider-keys" | jq '{provider, keyPrefix}'
   ```

4. Check all four, in order:

   - [ ] `GET /api/user/provider-keys` shows one row for that provider, with the new `keyPrefix`
   - [ ] No response body anywhere contains the raw key (they are prefix-only by contract)
   - [ ] The audit log has the rotation event:
         `curl -s -H "authorization: Bearer $NEXUS_TOKEN" "$NEXUS_URL/api/admin/audit-logs" | jq '.logs[] | select(.action=="provider_key.rotate")'`
   - [ ] `pnpm --filter @nexus/cli exec nexus audit verify` still reports a valid chain
   - [ ] A real request through that provider succeeds (the key is resolved server-side,
         so a list check alone proves storage, not use)

5. Rollback: store the previous key again. The old row is still there, soft-deleted,
   for exactly this reason.

### 11.2 OAuth client secret — env only, never stored

The client secret is not in the database: `packages/llm-oauth/src/providers.ts`
declares it as `requiredEnv` for each provider. Rotating it is a console change, an
env change, and a restart — and the stored refresh tokens must survive all three.

1. Rotate the secret in the provider console (Google Cloud, Azure AD, GitHub App).
2. Update the value where the deployment reads env: Render environment, or `.env`
   for compose, as `GOOGLE_OAUTH_CLIENT_SECRET` / `AZURE_OAUTH_CLIENT_SECRET` /
   `GITHUB_OAUTH_CLIENT_SECRET`.
3. Redeploy or restart the API (`docker compose up -d api`, or the Render deploy).
   The old secret keeps working in the console only as long as the provider allows
   overlap — close that window once step 4 passes.
4. Check, in order:

   - [ ] `/health/ready` is passing and the API logged no `requiredEnv` warnings
   - [ ] A fresh sign-in round trip completes (authorize → callback → token exchange)
   - [ ] A token stored **before** the rotation still refreshes: the vault that seals it
         (`NEXUS_OAUTH_VAULT_KEY`) was not touched, so it must still open
   - [ ] The provider console shows the old secret revoked

5. Rollback: restore the previous secret in the console and the deployment env, then
   restart. Nothing else in the system depends on the value.

### 11.3 Do not rotate these in the same drill

`NEXUS_SECRETS_KEY` seals every stored provider key, and `NEXUS_OAUTH_VAULT_KEY`
seals every stored OAuth token. Changing either one makes every existing ciphertext
unreadable — the rows survive, the plaintext does not. Rotating an **at-rest** key is
a different procedure (re-encrypt under the new key while the old one is still
configured) and is deliberately out of scope here; mixing it into a credential drill
is how a rotation becomes an outage.

### 11.4 Drill record

Fill this in after a real run; an empty row means the drill has not been done.

| Date    | Half                | Wall time | Who | Anything that went wrong |
| ------- | ------------------- | --------- | --- | ------------------------ |
| _unrun_ | provider key (BYOK) | —         | —   | —                        |
| _unrun_ | OAuth client secret | —         | —   | —                        |
