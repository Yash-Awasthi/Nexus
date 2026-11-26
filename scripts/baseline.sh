#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# The measured baseline behind docs/STATUS.md. See scripts/baseline.mjs.
#
#   ./scripts/baseline.sh --json       machine-readable snapshot
#   ./scripts/baseline.sh --write      regenerate the block in docs/STATUS.md
#   ./scripts/baseline.sh --check      fail when that block is stale (CI)
#
# --from <dir> reads suite reports written by CI instead of re-running them.
set -euo pipefail
exec node "$(dirname "$0")/baseline.mjs" "$@"
