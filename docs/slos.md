<!-- SPDX-License-Identifier: Apache-2.0 -->
# NEXUS Service Level Objectives (SLOs)

**Version:** 1.0  
**Review cadence:** Quarterly  
**Owner:** Yash Awasthi

SLIs and SLOs for each production service. Alert rules reference Prometheus metric names.

---

## SLO-1: API Availability

**Service:** `nexus-api`  
**SLI:** `(1 - rate(http_requests_total{job="nexus-api",status=~"5.."}[5m])) / rate(http_requests_total{job="nexus-api"}[5m])`  
**SLO target:** 99.5% over 30-day rolling window  
**Error budget:** 0.5% = ~3.6 hours/month

**Alert rules:**
```yaml
# Warn: burn rate 2x over 1h
- alert: NexusAPIAvailabilityWarn
  expr: |
    (
      rate(http_requests_total{job="nexus-api",status=~"5.."}[1h]) /
      rate(http_requests_total{job="nexus-api"}[1h])
    ) > 0.01
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Nexus API error rate elevated ({{ $value | humanizePercentage }})"

# Page: burn rate 14x over 5min (will exhaust monthly budget in 2h)
- alert: NexusAPIAvailabilityPage
  expr: |
    (
      rate(http_requests_total{job="nexus-api",status=~"5.."}[5m]) /
      rate(http_requests_total{job="nexus-api"}[5m])
    ) > 0.07
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "Nexus API availability SLO breach — immediate action required"
```

---

## SLO-2: API Latency (p99)

**Service:** `nexus-api`  
**SLI:** `histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{job="nexus-api"}[5m]))`  
**SLO target:** p99 < 500ms  
**Measurement window:** 5-minute rolling

**Alert rules:**
```yaml
- alert: NexusAPILatencyWarn
  expr: |
    histogram_quantile(0.99,
      rate(http_request_duration_seconds_bucket{job="nexus-api"}[5m])
    ) > 0.5
  for: 5m
  labels:
    severity: warning

- alert: NexusAPILatencyPage
  expr: |
    histogram_quantile(0.99,
      rate(http_request_duration_seconds_bucket{job="nexus-api"}[5m])
    ) > 1.0
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Nexus API p99 latency > 1s"
```

---

## SLO-3: Council Deliberation Success Rate

**Service:** `nexus-council` (via `nexus-api`, `nexus-worker`)  
**SLI:** Ratio of deliberations completing with `ok: true` within 60s  
**SLO target:** 99% over 7-day rolling window  
**Measurement:** `nexus_council_success_total / nexus_council_attempts_total`

**Alert rules:**
```yaml
- alert: NexusCouncilSuccessRateWarn
  expr: |
    rate(nexus_council_success_total[15m]) /
    rate(nexus_council_attempts_total[15m]) < 0.97
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "Council success rate below 97% ({{ $value | humanizePercentage }})"

- alert: NexusCouncilSuccessRatePage
  expr: |
    rate(nexus_council_success_total[15m]) /
    rate(nexus_council_attempts_total[15m]) < 0.90
  for: 5m
  labels:
    severity: critical
```

---

## SLO-4: Queue Job Processing Latency (p99)

**Service:** `nexus-worker` (BullMQ)  
**SLI:** Time from job enqueue to job completion (p99)  
**SLO target:** p99 < 30 seconds for `nexus-medium`; p99 < 10 seconds for `nexus-high`  
**Measurement:** BullMQ job metrics exported to Prometheus via worker instrumentation

**Alert rules:**
```yaml
- alert: NexusQueueDepthHigh
  expr: bullmq_queue_waiting{queue="nexus-high"} > 100
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "nexus-high queue depth > 100 jobs"

- alert: NexusQueueDepthCritical
  expr: bullmq_queue_waiting{queue="nexus-medium"} > 500
  for: 10m
  labels:
    severity: critical

- alert: NexusDLQGrowing
  expr: increase(bullmq_queue_failed_total[1h]) > 20
  for: 1m
  labels:
    severity: warning
  annotations:
    summary: "DLQ received {{ $value }} jobs in the last hour"
```

---

## SLO-5: Audit Log Chain Integrity

**Service:** All (audit log is system-wide)  
**SLI:** Boolean — `GET /api/v1/audit/log/verify` returns `{ "valid": true }`  
**SLO target:** 100% — zero tolerance for chain breaks  
**Measurement:** Run verify probe every 5 minutes

**Alert rules:**
```yaml
- alert: NexusAuditChainBroken
  expr: nexus_audit_chain_valid == 0
  for: 0m
  labels:
    severity: critical
  annotations:
    summary: "NEXUS audit log chain integrity breach — security incident"
    runbook: "https://github.com/Yash-Awasthi/Nexus/blob/main/docs/runbook.md#p4--audit-chain-broken-t3-incident"
```

---

## Error budget tracking

| SLO | Budget/month | Burned (track in Grafana) |
|-----|-------------|--------------------------|
| API availability | 3.6 hours | — |
| API latency | Violations × 5min | — |
| Council success | Failures / total | — |
| Queue p99 | Violations × 10min | — |
| Audit integrity | 0 | — |

Review error budget consumption in weekly ops review. Freeze feature work if >50% of monthly budget consumed by week 2.
