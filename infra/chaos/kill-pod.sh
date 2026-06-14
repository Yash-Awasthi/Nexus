#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# chaos/kill-pod.sh — Randomly kill one pod matching a label selector.
#
# Usage:
#   ./kill-pod.sh [namespace] [label-selector]
#   ./kill-pod.sh nexus app=nexus-api
#   ./kill-pod.sh nexus app=nexus-worker
#
# The script picks a random pod from the matched set and deletes it with a
# 0s grace period, simulating an OOM kill or node eviction.
# It then waits up to 60 s for the deployment to recover (pod back to Running).

set -euo pipefail

NAMESPACE="${1:-nexus}"
SELECTOR="${2:-app=nexus-api}"
GRACE="${GRACE_PERIOD:-0}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-60}"

echo "[chaos:kill-pod] namespace=$NAMESPACE selector=$SELECTOR grace=${GRACE}s"

# Pick a random running pod
POD=$(kubectl get pods -n "$NAMESPACE" -l "$SELECTOR" \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[*].metadata.name}' \
  | tr ' ' '\n' | shuf -n 1)

if [[ -z "$POD" ]]; then
  echo "[chaos:kill-pod] ERROR: no running pods found for selector '$SELECTOR' in namespace '$NAMESPACE'" >&2
  exit 1
fi

echo "[chaos:kill-pod] Killing pod: $POD"
kubectl delete pod "$POD" -n "$NAMESPACE" --grace-period="$GRACE"

echo "[chaos:kill-pod] Waiting up to ${WAIT_TIMEOUT}s for recovery..."
kubectl wait pods -n "$NAMESPACE" -l "$SELECTOR" \
  --for=condition=Ready \
  --timeout="${WAIT_TIMEOUT}s"

echo "[chaos:kill-pod] Recovery confirmed."
