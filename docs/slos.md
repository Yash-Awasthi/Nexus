<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- verified: 8065a84 2026-11-25 -->

# Nexus Service Level Objectives (SLOs)

**Version:** 1.1  
**Review cadence:** Quarterly  
**Owner:** Yash Awasthi

SLIs and SLOs for the hosted deployment. The API exports these series at
`/api/v1/metrics`; Grafana is pre-provisioned against them. Where a signal is not
instrumented, the table says so rather than inventing a metric.

---

## SLO-1: API availability

**SLI:** `nexus_slo_availability` (gauge, 0–1) and `nexus_slo_error_rate`
**SLO target:** 99.5% over a 30-day rolling window
**Error budget:** 0.5% ≈ 3.6 hours/month
**Measurement point:** the `nexus_slo_availability` gauge is computed inside the API process
by `SloTracker` (`apps/api/src/routes/metrics.ts`, 5-minute window) and scraped from
`GET /api/v1/metrics`. A probe against `/health` measures the process, not this number: an
instance can answer `/health` while every route it serves is failing, so availability is read
from the recorded responses, never from a health probe.

```yaml
- alert: NexusAPIAvailabilityWarn
  expr: nexus_slo_availability < 0.995
  for: 5m
  labels:
    severity: warning

- alert: NexusAPIAvailabilityPage
  expr: nexus_slo_availability < 0.99
  for: 2m
  labels:
    severity: critical
```

---

## SLO-2: API latency (p99)

**SLI:** `nexus_slo_p99_latency_ms` (gauge)
**SLO target:** p99 < 500ms
**Measurement window:** 5-minute rolling
**Measurement point:** `nexus_slo_p99_latency_ms` is computed by the same `SloTracker` from
response timings recorded per request and reset every 5 minutes, so the number is the server's
own latency for the window it is scraped in. It measures the HTTP response, which for a
streaming route means the time to the response, not the time to the last token; a slow provider
is SLO-3's problem, not this one's.

```yaml
- alert: NexusAPILatencyWarn
  expr: nexus_slo_p99_latency_ms > 500
  for: 5m
  labels:
    severity: warning

- alert: NexusAPILatencyPage
  expr: nexus_slo_p99_latency_ms > 5000
  for: 3m
  labels:
    severity: critical
```

---

## SLO-3: Council deliberation success rate

**SLI:** successful council completions ÷ attempts
**SLO target:** 99% over a 7-day rolling window
**Status:** not exported as a dedicated series. Council outcomes are in the
per-request transcript and the audit log; use `nexus_gateway_requests_total{status="error"}`
as a coarse proxy until a council counter exists.
**Measurement point:** the audit log's `council` rows (append-only, hash-chained), counted over
the window by `/api/v1/audit/log/verify`'s companion query. Deliberately not a Prometheus
series: a series that lives in the same process as the thing it measures reports "100%" for
every crash.

---

## SLO-4: Queue job processing

**SLI:** enqueue-to-completion time, p99
**SLO target:** p99 < 30s for `nexus-medium`, p99 < 10s for `nexus-high`
**Status:** BullMQ does not export to Prometheus in this tree. Read depth from Redis
(`llen bull:nexus-<queue>:wait`) or the BullMQ dashboard.
**Measurement point:** each job writes `finishedOn - processedOn` into its BullMQ result, so the
histogram comes from completed jobs in Redis (`bull:nexus-<queue>:completed`), not from the API.

---

## SLO-5: Audit log chain integrity

**SLI:** `GET /api/v1/audit/log/verify` returns `{ "valid": true }`
**SLO target:** 100% — zero tolerance for chain breaks
**Measurement:** run the verify probe every 5 minutes; the result is not a Prometheus
series, so the alert is a synthetic probe rather than a metric expression.

---

## SLO-6: Dependency status

**SLI:** the `status` field of `GET /status` (`ok` / `degraded` / `down`)
**SLO target:** `ok` for 99.9% of the time, and never `down` for more than 5 minutes unnoticed
**Error budget:** any `down` is an incident; a sustained `degraded` is a task
**Measurement point:** `/status` probes Postgres, Redis, the provider registry, the sandbox and
Docker, one row each, and reports what it measured (never a host, a key or a version). It
caches a healthy answer for 30 minutes and a broken one for 15 seconds, so a public status page
cannot keep a free database awake. `degraded` is a `200` and `down` is a `503`, exactly like
`/health/ready`, so a status page can watch it without pulling the instance out of rotation.

```yaml
- alert: NexusStatusDegraded
  expr: probe_success{job="nexus-status"} == 1 and nexus_status_rows{ok="false"} > 0
  for: 15m
  labels:
    severity: warning

- alert: NexusStatusDown
  expr: probe_success{job="nexus-status"} == 0
  for: 2m
  labels:
    severity: critical
```

---

## Error budget tracking

| SLO               | Budget/month       | Burned (track in Grafana) |
| ----------------- | ------------------ | ------------------------- |
| API availability  | 3.6 hours          | —                         |
| API latency       | Violations × 5min  | —                         |
| Council success   | Failures / total   | —                         |
| Queue p99         | Violations × 10min | —                         |
| Audit integrity   | 0                  | —                         |
| Dependency status | 5 min of `down`    | —                         |

Review error-budget consumption in the weekly ops review.
