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
        migrate migrate-neon db-studio seed build test lint clean

# ── Default target ────────────────────────────────────────────────────────────

help: ## Show available targets
	@printf "Usage: make <target>\n\n"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'

# ── First-time setup ─────────────────────────────────────────────────────────

setup: ## Install deps and copy .env.example → .env (run once)
	@if [ ! -f .env ]; then \
	  cp .env.example .env; \
	  echo "Created .env from .env.example — fill in GROQ_API_KEY and DATABASE_URL"; \
	else \
	  echo ".env already exists — skipping copy"; \
	fi
	pnpm install
	@echo ""
	@echo "Next steps:"
	@echo "  1. Edit .env (set GROQ_API_KEY, DATABASE_URL, NEXUS_API_KEY)"
	@echo "  2. make dev-infra      # start postgres + redis"
	@echo "  3. make migrate        # apply schema"
	@echo "  4. pnpm dev            # start api + worker with hot-reload"

# ── Infrastructure (postgres + redis only) ───────────────────────────────────

dev-infra: ## Start postgres + redis in the background
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

# ── Cleanup ───────────────────────────────────────────────────────────────────

clean: ## Remove all dist/, coverage/, and node_modules/
	pnpm clean
