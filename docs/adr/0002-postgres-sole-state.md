<!-- SPDX-License-Identifier: Apache-2.0 -->
# 0002 — Postgres as Sole State Store

**Status:** Accepted
**Date:** 2026-06-11

## Context
The four absorbed repos use four different persistence strategies:
- workspace → Neon Postgres (5 thin tables)
- Judica → Postgres 16 + pgvector (62 Drizzle schemas, 28 migrations)
- GhostStack → JSONL files
- fin-scrape → SQLite + Cloudflare Durable Objects

Four storage systems means four migration paths, four backup strategies, and four data models that need to stay in sync.

## Decision
One Postgres 16 + pgvector cluster is the sole persistent state store for all NEXUS services. Judica's 62 Drizzle schemas and 28 migrations are the starting point — they are the most complete and production-grade of the four. GhostStack's file-backed implementations (`FileQueueBackend`, `JsonlEventStore`) are retained as `--backend=file` for offline development only and are not supported in production.

## Consequences
- Single migration path, single backup strategy, single schema source of truth.
- pgvector available for memory/RAG workloads without a separate vector DB.
- Offline dev still works via `--backend=file`.
- Redis is used for ephemeral pub/sub and queue brokering only (not persistent state).
