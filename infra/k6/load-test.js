// SPDX-License-Identifier: Apache-2.0
/**
 * k6 load test for NEXUS API
 *
 * Usage:
 *   k6 run infra/k6/load-test.js \
 *     -e BASE_URL=http://localhost:3000 \
 *     -e API_KEY=your-api-key \
 *     --vus 50 --duration 60s
 *
 * Scenarios:
 *   - health:      constant 10 VUs (baseline)
 *   - api_read:    ramp up to 50 VUs (GET tasks, approvals)
 *   - api_write:   ramp up to 20 VUs (POST ingest/events)
 *   - council:     constant 5 VUs (deliberation — expensive)
 *
 * Thresholds (SLO-aligned):
 *   - http_req_duration p99 < 500ms
 *   - http_req_failed < 1%
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const API_KEY = __ENV.API_KEY || "dev-key";

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${API_KEY}`,
};

// Custom metrics
const councilSuccessRate = new Rate("council_success_rate");
const councilDuration = new Trend("council_duration_ms");
const ingestSuccessRate = new Rate("ingest_success_rate");

// ── Scenarios ─────────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    health: {
      executor: "constant-vus",
      vus: 5,
      duration: "60s",
      exec: "healthCheck",
    },
    api_read: {
      executor: "ramping-vus",
      startVUs: 5,
      stages: [
        { duration: "10s", target: 25 },
        { duration: "40s", target: 50 },
        { duration: "10s", target: 0 },
      ],
      exec: "apiRead",
    },
    api_write: {
      executor: "ramping-vus",
      startVUs: 2,
      stages: [
        { duration: "15s", target: 20 },
        { duration: "30s", target: 20 },
        { duration: "15s", target: 0 },
      ],
      exec: "apiWrite",
    },
    council_load: {
      executor: "constant-vus",
      vus: 3,
      duration: "30s",
      startTime: "30s",
      exec: "councilLoad",
    },
  },

  thresholds: {
    // SLO-1: API availability
    http_req_failed: ["rate<0.01"],
    // SLO-2: API latency p99 < 500ms
    http_req_duration: ["p(99)<500", "p(95)<200"],
    // Council-specific
    council_success_rate: ["rate>0.95"],
    council_duration_ms: ["p(99)<8000"],
    // Ingest
    ingest_success_rate: ["rate>0.99"],
  },
};

// ── Scenario functions ────────────────────────────────────────────────────────

export function healthCheck() {
  const res = http.get(`${BASE_URL}/health`);
  check(res, {
    "health: status 200": (r) => r.status === 200,
    "health: status ok": (r) => {
      try { return JSON.parse(r.body).status === "ok"; } catch { return false; }
    },
  });
  sleep(1);
}

export function apiRead() {
  const endpoints = [
    "/api/v1/runtime/tasks?limit=20",
    "/api/v1/governance/approvals?status=pending&limit=20",
    "/api/v1/audit/log?limit=50",
  ];
  const url = endpoints[Math.floor(Math.random() * endpoints.length)];
  const res = http.get(`${BASE_URL}${url}`, { headers });
  check(res, {
    "api_read: status 200": (r) => r.status === 200,
    "api_read: has body": (r) => r.body !== null && r.body.length > 2,
  });
  sleep(0.1 + Math.random() * 0.5);
}

export function apiWrite() {
  const payload = JSON.stringify({
    source: "k6-load-test",
    event_type: "test.ping",
    payload: { timestamp: Date.now(), vus: __VU },
    idempotency_key: `k6-${__VU}-${__ITER}`,
  });

  const res = http.post(`${BASE_URL}/api/v1/ingest/events`, payload, { headers });
  const ok = res.status === 202 || res.status === 200;
  ingestSuccessRate.add(ok);
  check(res, {
    "ingest: accepted": (r) => r.status === 202,
  });
  sleep(0.5 + Math.random());
}

export function councilLoad() {
  const start = Date.now();
  const payload = JSON.stringify({
    proposal: {
      title: `k6 Load Test Proposal ${__VU}-${__ITER}`,
      description: "Automated load test — should a k6 run complete successfully?",
    },
    budgetUsd: 0.05,
  });

  const res = http.post(`${BASE_URL}/api/v1/council/deliberate`, payload, {
    headers,
    timeout: "90s",
  });

  const duration = Date.now() - start;
  const ok = res.status === 200;
  councilSuccessRate.add(ok);
  councilDuration.add(duration);

  check(res, {
    "council: status 200": (r) => r.status === 200,
    "council: has result": (r) => {
      try { return JSON.parse(r.body).ok === true; } catch { return false; }
    },
  });
  sleep(2 + Math.random() * 3);
}
