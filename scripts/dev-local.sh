#!/usr/bin/env bash
# Load repo .env into the environment and launch Nexus locally.
# Usage: scripts/dev-local.sh [api|ui|both]   (default: both)
set -euo pipefail
cd "$(dirname "$0")/.."

# Load .env safely (quoted export handles & ? = inside URLs — no shell interpretation).
# Only export well-formed KEY=VALUE lines; never abort on a malformed one.
while IFS= read -r line; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
  export "$line" 2>/dev/null || true
done < .env

# UI dev proxy must target the API's actual port (defaults to PORT from .env, else 3000).
export NEXUS_API_URL="http://localhost:${PORT:-3000}"

case "${1:-both}" in
  api) exec pnpm dev:api ;;
  ui)  exec pnpm dev:ui ;;
  both)
    pnpm dev:api &
    pnpm dev:ui &
    wait
    ;;
  *) echo "usage: $0 [api|ui|both]" >&2; exit 1 ;;
esac
