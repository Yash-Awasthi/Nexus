#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# scripts/dev-setup.sh — One-shot local development bootstrap
#
# Run once after cloning:
#   ./scripts/dev-setup.sh
#
# What it does:
#   1. Copies .env.example → .env (if .env is absent)
#   2. Checks required env vars are set
#   3. Installs pnpm dependencies
#   4. Starts postgres + redis via Docker Compose
#   5. Waits until both are healthy (up to 60 s)
#   6. Runs drizzle migrations against DATABASE_URL
#   7. Prints next-step instructions

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[warn] ${NC} $*"; }
error() { echo -e "${RED}[error]${NC} $*"; exit 1; }

# ── 1. .env ───────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  info "Created .env from .env.example"
  warn "Edit .env and set GROQ_API_KEY, DATABASE_URL (or use the local postgres), and NEXUS_API_KEY, then re-run this script."
  exit 0
fi

# Load .env (ignore lines that can't be sourced cleanly)
set -a
# shellcheck disable=SC1091
source .env 2>/dev/null || true
set +a

# ── 2. Check required vars ────────────────────────────────────────────────────
MISSING=()

[ -z "${NEXUS_API_KEY:-}"  ] && MISSING+=("NEXUS_API_KEY")
[ -z "${GROQ_API_KEY:-}"   ] && MISSING+=("GROQ_API_KEY")

# DATABASE_URL can be local postgres (set by compose) or Neon
if [ -z "${DATABASE_URL:-}" ]; then
  warn "DATABASE_URL not set — will use local Docker postgres after containers start."
  USE_LOCAL_DB=1
else
  USE_LOCAL_DB=0
fi

if [ "${#MISSING[@]}" -gt 0 ]; then
  error "Missing required env vars in .env: ${MISSING[*]}\nEdit .env and re-run."
fi

# ── 3. Install dependencies ───────────────────────────────────────────────────
if ! command -v pnpm &>/dev/null; then
  info "pnpm not found — enabling via corepack..."
  corepack enable || npm install -g pnpm
fi

info "Installing pnpm dependencies..."
pnpm install --frozen-lockfile

# ── 4. Start infrastructure ───────────────────────────────────────────────────
info "Starting postgres + redis via Docker Compose..."

if ! command -v docker &>/dev/null; then
  error "Docker not found. Install Docker Desktop or Docker Engine and retry."
fi

docker compose up postgres redis -d

# ── 5. Wait for healthy containers ───────────────────────────────────────────
wait_healthy() {
  local svc="$1" max=60 elapsed=0
  while [ $elapsed -lt $max ]; do
    local status
    status=$(docker compose ps "$svc" --format '{{.Health}}' 2>/dev/null || true)
    if [ "$status" = "healthy" ]; then
      info "$svc is healthy"
      return 0
    fi
    printf "  Waiting for %s (%ss)...\r" "$svc" "$elapsed"
    sleep 2
    elapsed=$((elapsed + 2))
  done
  error "$svc did not become healthy within ${max}s"
}

wait_healthy postgres
wait_healthy redis

# ── 6. Run migrations ─────────────────────────────────────────────────────────
if [ "${USE_LOCAL_DB}" -eq 1 ]; then
  export DATABASE_URL="postgresql://nexus:nexus_dev_password@localhost:5432/nexus"
  info "Using local postgres: $DATABASE_URL"
fi

info "Running drizzle migrations..."
DATABASE_URL="$DATABASE_URL" pnpm --filter @nexus/db db:push

# ── 7. Done ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN} Nexus dev environment is ready${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Start all services (hot-reload):  pnpm dev"
echo "  API:                              http://localhost:3000/health"
echo "  Drizzle Studio:                   make db-studio"
echo ""
echo "  Or use Docker for everything:     make dev-up"
echo ""
