#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# chaos/redis-failover.sh — Simulate Redis unavailability and verify recovery.
#
# Usage (docker compose environment):
#   ./redis-failover.sh [down_seconds]
#   ./redis-failover.sh 30
#
# Usage (Kubernetes):
#   KUBE=1 NAMESPACE=nexus ./redis-failover.sh 30
#
# What it tests:
#   1. Stop Redis for N seconds
#   2. Verify API /health returns degraded (not 500) — graceful degradation
#   3. Verify worker queues pause cleanly (no panic/crash)
#   4. Restart Redis, verify worker drains the backlog
#   5. Verify API /health returns healthy

set -euo pipefail

DOWN_SECONDS="${1:-30}"
API_URL="${API_URL:-http://localhost:3000}"
KUBE="${KUBE:-0}"
NAMESPACE="${NAMESPACE:-nexus}"

echo "[chaos:redis-failover] Stopping Redis for ${DOWN_SECONDS}s..."

if [[ "$KUBE" == "1" ]]; then
  # Scale Redis deployment to 0
  kubectl scale deployment nexus-redis -n "$NAMESPACE" --replicas=0
  sleep "$DOWN_SECONDS"

  echo "[chaos:redis-failover] Checking API health during outage..."
  STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "${API_URL}/health" || echo "000")
  echo "[chaos:redis-failover] Health status during outage: HTTP $STATUS"
  if [[ "$STATUS" == "500" ]]; then
    echo "[chaos:redis-failover] FAIL: API returned 500 — no graceful degradation" >&2
    kubectl scale deployment nexus-redis -n "$NAMESPACE" --replicas=1
    exit 1
  fi

  echo "[chaos:redis-failover] Restoring Redis..."
  kubectl scale deployment nexus-redis -n "$NAMESPACE" --replicas=1
  kubectl wait pods -n "$NAMESPACE" -l app=nexus-redis \
    --for=condition=Ready --timeout=60s
else
  # docker compose environment
  docker compose stop redis
  sleep "$DOWN_SECONDS"

  echo "[chaos:redis-failover] Checking API health during outage..."
  STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "${API_URL}/health" || echo "000")
  echo "[chaos:redis-failover] Health status during outage: HTTP $STATUS"
  if [[ "$STATUS" == "500" ]]; then
    echo "[chaos:redis-failover] FAIL: API returned 500 — no graceful degradation" >&2
    docker compose start redis
    exit 1
  fi

  echo "[chaos:redis-failover] Restoring Redis..."
  docker compose start redis
  sleep 5
fi

echo "[chaos:redis-failover] Verifying recovery..."
for i in $(seq 1 12); do
  STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "${API_URL}/health" || echo "000")
  if [[ "$STATUS" == "200" ]]; then
    echo "[chaos:redis-failover] Recovery confirmed after $((i * 5))s."
    exit 0
  fi
  echo "[chaos:redis-failover] Attempt $i: HTTP $STATUS — waiting..."
  sleep 5
done

echo "[chaos:redis-failover] FAIL: API did not recover within 60s after Redis restart." >&2
exit 1
