<!-- SPDX-License-Identifier: Apache-2.0 -->

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

---

## SLO-4: Queue job processing

**SLI:** enqueue-to-completion time, p99
**SLO target:** p99 < 30s for `nexus-medium`, p99 < 10s for `nexus-high`
**Status:** BullMQ does not export to Prometheus in this tree. Read depth from Redis
(`llen bull:nexus-<queue>:wait`) or the BullMQ dashboard.

---

## SLO-5: Audit log chain integrity

**SLI:** `GET /api/v1/audit/log/verify` returns `{ "valid": true }`
**SLO target:** 100% — zero tolerance for chain breaks
**Measurement:** run the verify probe every 5 minutes; the result is not a Prometheus
series, so the alert is a synthetic probe rather than a metric expression.

---

## Error budget tracking

| SLO              | Budget/month       | Burned (track in Grafana) |
| ---------------- | ------------------ | ------------------------- |
| API availability | 3.6 hours          | —                         |
| API latency      | Violations × 5min  | —                         |
| Council success  | Failures / total   | —                         |
| Queue p99        | Violations × 10min | —                         |
| Audit integrity  | 0                  | —                         |

Review error-budget consumption in the weekly ops review.
