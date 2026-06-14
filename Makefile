# SPDX-License-Identifier: Apache-2.0
# Nexus — developer convenience targets
#
# Usage:
#   make setup          First-time setup (install + copy .env)
#   make dev-infra      Start postgres + redis only (use pnpm dev for Node services)
#   make dev-up         Full Docker dev stack with hot-reload
#   make dev-down       Stop and remove all containers
#   make migrate        Run drizzle migrations against DATABASE_URL
#   make migrate-neon   Push schema directly to Neon (idempotent, no migration files)
#   make build          Build all packages
#   make test           Run all tests
#   make lint           ESLint + Prettier check
#   make logs           Tail all container logs

.PHONY: help setup dev-infra dev-infra-down dev-up dev-down dev-logs \
        migrate migrate-neon db-studio seed build test lint clean \
        finscrape-up finscrape-down ingest-scan

# ── Default target ────────────────────────────────────────────────────────────

help: ## Show available targets
	@printf "Usage: make <target>\n\n"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'

# ── First-time setup ─────────────────────────────────────────────────────────

setup: ## Generate secret keys + create .env, then install deps (idempotent — safe to re-run)
	@if [ -f .env ]; then \
	  echo ".env already exists — skipping key generation (delete it to regenerate)"; \
	else \
	  cp .env.example .env; \
	  sed -i.bak "s|NEXUS_API_KEY=.*|NEXUS_API_KEY=$$(openssl rand -hex 32)|" .env; \
	  sed -i.bak "s|NEXUS_AUDIT_KEY=.*|NEXUS_AUDIT_KEY=$$(openssl rand -hex 32)|" .env; \
	  sed -i.bak "s|NEXUS_INGEST_API_KEY=.*|NEXUS_INGEST_API_KEY=$$(openssl rand -hex 32)|" .env; \
	  rm -f .env.bak; \
	  echo "✓ .env created with generated secrets:"; \
	  printf "  NEXUS_API_KEY        = %s\n" "$$(grep '^NEXUS_API_KEY=' .env | cut -d= -f2)"; \
	  printf "  NEXUS_AUDIT_KEY      = %s\n" "$$(grep '^NEXUS_AUDIT_KEY=' .env | cut -d= -f2)"; \
	  printf "  NEXUS_INGEST_API_KEY = %s\n" "$$(grep '^NEXUS_INGEST_API_KEY=' .env | cut -d= -f2)"; \
	  echo ""; \
	  echo "Copy NEXUS_API_KEY into VITE_API_KEY in .env so the web client can authenticate."; \
	  echo "Then: set GROQ_API_KEY + DATABASE_URL and run:"; \
	  echo "  make dev-infra && make migrate && pnpm dev"; \
	fi
	@command -v pnpm >/dev/null 2>&1 && pnpm install || echo "pnpm not found — run: npm install -g pnpm && pnpm install"

# ── Infrastructure (postgres + redis only) ───────────────────────────────────

dev-infra: setup ## Start postgres + redis (runs setup first so .env always exists)
	docker compose up postgres redis -d
	@echo "Waiting for healthy containers..."
	@docker compose ps postgres redis

dev-infra-down: ## Stop postgres + redis
	docker compose stop postgres redis

# ── Full Docker dev stack (hot-reload) ───────────────────────────────────────

dev-up: ## Build and start full dev stack (api + worker + ingest + infra)
	docker compose \
	  -f docker-compose.yml \
	  -f infra/docker/docker-compose.dev.yml \
	  up --build -d
	@echo ""
	@echo "Stack is up. API → http://localhost:3000  Ingest → http://localhost:8000"
	@echo "Run 'make dev-logs' to tail output."

dev-down: ## Stop and remove all containers + networks
	docker compose \
	  -f docker-compose.yml \
	  -f infra/docker/docker-compose.dev.yml \
	  down

dev-logs: ## Tail logs from all running containers
	docker compose \
	  -f docker-compose.yml \
	  -f infra/docker/docker-compose.dev.yml \
	  logs -f

# ── Database ──────────────────────────────────────────────────────────────────

migrate: ## Run drizzle-kit migrate (uses DATABASE_URL from env / .env)
	@[ -n "$$DATABASE_URL" ] || (set -a; . ./.env; set +a; \
	  DATABASE_URL=$$DATABASE_URL pnpm --filter @nexus/db db:migrate)
	@[ -z "$$DATABASE_URL" ] || pnpm --filter @nexus/db db:migrate

migrate-neon: ## Push schema to Neon DB (idempotent — no migration files required)
	@[ -n "$$DATABASE_URL" ] || (set -a; . ./.env; set +a; \
	  DATABASE_URL=$$DATABASE_URL pnpm --filter @nexus/db db:push)
	@[ -z "$$DATABASE_URL" ] || pnpm --filter @nexus/db db:push

db-studio: ## Open Drizzle Studio in browser (requires DATABASE_URL)
	pnpm --filter @nexus/db db:studio

db-generate: ## Generate a new migration from schema changes
	pnpm --filter @nexus/db db:generate

# ── Build / Test / Lint ───────────────────────────────────────────────────────

build: ## Build all packages via turbo
	pnpm build

test: ## Run all test suites via turbo
	pnpm test

lint: ## Run ESLint + Prettier check across all packages
	pnpm lint && pnpm format:check

typecheck: ## Run TypeScript type-check across all packages
	pnpm typecheck

# ── fin-scrape bridge ─────────────────────────────────────────────────────────

finscrape-up: ## Start ingest-bridge container (profile: finscrape)
	docker compose --profile finscrape up ingest-bridge --build -d
	@echo "ingest-bridge running → http://localhost:8001"

finscrape-down: ## Stop ingest-bridge container
	docker compose --profile finscrape stop ingest-bridge

ingest-scan: ## Trigger a /scan on the running ingest-bridge (flushes fin-scrape output dir)
	@BRIDGE_URL=$${BRIDGE_URL:-http://localhost:8001}; \
	BRIDGE_KEY=$${BRIDGE_API_KEY:-}; \
	if [ -n "$$BRIDGE_KEY" ]; then \
	  curl -sf -X POST "$$BRIDGE_URL/scan" -H "Authorization: Bearer $$BRIDGE_KEY" | python3 -m json.tool; \
	else \
	  curl -sf -X POST "$$BRIDGE_URL/scan" | python3 -m json.tool; \
	fi

# ── Cleanup ───────────────────────────────────────────────────────────────────

clean: ## Remove all dist/, coverage/, and node_modules/
	pnpm clean
