#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# scripts/codegen/generate-types.sh
#
# Code generation pipeline for M3 shared substrate.
#
# Reads:
#   packages/contracts/openapi/nexus-api.yaml
#   packages/contracts/asyncapi/nexus-events.yaml
#
# Writes:
#   packages/contracts/src/generated/openapi.d.ts   — TypeScript types from OpenAPI
#   services/ingest/src/nexus_ingest/generated/      — Pydantic models from OpenAPI
#
# Requirements (installed via pnpm scripts or CI):
#   - openapi-typescript  (pnpm add -D openapi-typescript)
#   - @asyncapi/generator  (npm i -g @asyncapi/generator, optional)
#   - datamodel-code-generator  (pip install datamodel-code-generator)
#
# Usage:
#   bash scripts/codegen/generate-types.sh
#   bash scripts/codegen/generate-types.sh --openapi-only
#   bash scripts/codegen/generate-types.sh --python-only

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPENAPI_SPEC="$REPO_ROOT/packages/contracts/openapi/nexus-api.yaml"
ASYNCAPI_SPEC="$REPO_ROOT/packages/contracts/asyncapi/nexus-events.yaml"
TS_OUT="$REPO_ROOT/packages/contracts/src/generated/openapi.d.ts"
PY_OUT="$REPO_ROOT/services/ingest/src/nexus_ingest/generated"

OPENAPI_ONLY=false
PYTHON_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --openapi-only) OPENAPI_ONLY=true ;;
    --python-only)  PYTHON_ONLY=true  ;;
  esac
done

echo "==> Nexus codegen pipeline"
echo "    OpenAPI spec : $OPENAPI_SPEC"
echo "    AsyncAPI spec: $ASYNCAPI_SPEC"
echo ""

# ─── TypeScript types from OpenAPI ────────────────────────────────────────────

if [[ "$PYTHON_ONLY" == "false" ]]; then
  echo "[1/3] Generating TypeScript types from OpenAPI spec..."
  mkdir -p "$(dirname "$TS_OUT")"

  # openapi-typescript v7 — zero-runtime, pure types
  if command -v openapi-typescript &>/dev/null; then
    openapi-typescript "$OPENAPI_SPEC" --output "$TS_OUT"
  else
    pnpm exec openapi-typescript "$OPENAPI_SPEC" --output "$TS_OUT"
  fi

  echo "      Written: $TS_OUT"
  echo ""
fi

# ─── Pydantic models from OpenAPI ────────────────────────────────────────────

if [[ "$OPENAPI_ONLY" == "false" ]]; then
  echo "[2/3] Generating Pydantic v2 models from OpenAPI spec..."
  mkdir -p "$PY_OUT"

  if ! command -v datamodel-codegen &>/dev/null; then
    echo "      SKIP: datamodel-code-generator not found."
    echo "      Install with: pip install datamodel-code-generator"
  else
    datamodel-codegen \
      --input "$OPENAPI_SPEC" \
      --input-file-type openapi \
      --output "$PY_OUT" \
      --output-model-type pydantic_v2.BaseModel \
      --target-python-version 3.11 \
      --use-annotated \
      --use-standard-collections \
      --snake-case-field \
      --field-constraints \
      --strict-nullable \
      --collapse-root-models

    echo "      Written: $PY_OUT/"
  fi
  echo ""
fi

# ─── AsyncAPI docs (optional) ─────────────────────────────────────────────────

echo "[3/3] AsyncAPI generation (optional, requires @asyncapi/generator)..."
ASYNCAPI_OUT="$REPO_ROOT/docs/asyncapi"
mkdir -p "$ASYNCAPI_OUT"

if command -v asyncapi &>/dev/null; then
  asyncapi generate fromTemplate "$ASYNCAPI_SPEC" \
    @asyncapi/html-template \
    --output "$ASYNCAPI_OUT" \
    --force-write
  echo "      Written: $ASYNCAPI_OUT/index.html"
else
  echo "      SKIP: asyncapi CLI not found."
  echo "      Install with: npm i -g @asyncapi/cli"
fi

echo ""
echo "==> Codegen complete."
