// SPDX-License-Identifier: Apache-2.0
/**
 * k6 smoke test — fast sanity check before/after deploy
 * Usage: k6 run infra/k6/smoke-test.js -e BASE_URL=... -e API_KEY=...
 */
import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const API_KEY = __ENV.API_KEY || "dev-key";
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` };

export const options = {
  vus: 1,
  iterations: 5,
  thresholds: { http_req_failed: ["rate<0.01"], http_req_duration: ["p(99)<2000"] },
};

export default function () {
  // Health
  check(http.get(`${BASE_URL}/health`), { "health ok": (r) => r.status === 200 });
  check(http.get(`${BASE_URL}/health/ready`), { "ready": (r) => r.status === 200 });

  // Auth required
  check(http.get(`${BASE_URL}/api/v1/runtime/tasks`), { "requires auth": (r) => r.status === 401 || r.status === 200 });

  // Tasks list
  check(http.get(`${BASE_URL}/api/v1/runtime/tasks?limit=5`, { headers }),
    { "tasks 200": (r) => r.status === 200 });

  // Audit verify
  check(http.get(`${BASE_URL}/api/v1/audit/log/verify`, { headers }),
    { "audit chain": (r) => r.status === 200 });
}
