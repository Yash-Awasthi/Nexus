<!-- SPDX-License-Identifier: Apache-2.0 -->

# @nexus/db

Drizzle ORM schemas, migrations, and typed query client for PostgreSQL 16 + pgvector.

The single source of truth for all database structure in NEXUS. Every other package that reads or writes the database imports from here.

## Installation

Internal monorepo package. Consumed by `apps/api`, `apps/worker`, and `services/ingest`.

```ts
import { db, schema } from "@nexus/db";
```

## Schema (7 tables)

| Table                 | File                            | Description                                          |
| --------------------- | ------------------------------- | ---------------------------------------------------- |
| `ingested_events`     | `schema/ingested-events.ts`     | Raw events from all adapters                         |
| `signals`             | `schema/signals.ts`             | Classified, prioritised signal records               |
| `council_transcripts` | `schema/council-transcripts.ts` | Full deliberation transcripts with per-member votes  |
| `verdicts`            | `schema/verdicts.ts`            | Final council decisions bound to a task              |
| `runtime_tasks`       | `schema/runtime-tasks.ts`       | Task lifecycle: queued → running → complete / failed |
| `approval_requests`   | `schema/approval-requests.ts`   | Human-in-the-loop approval queue                     |
| `audit_log`           | `schema/audit-log.ts`           | HMAC-SHA256 chained immutable audit trail            |

## Usage

```ts
import { db, schema } from "@nexus/db";
import { eq, desc } from "drizzle-orm";

// Query signals with Drizzle's type-safe query builder
const signals = await db
  .select()
  .from(schema.signals)
  .where(eq(schema.signals.priority, "critical"))
  .orderBy(desc(schema.signals.createdAt))
  .limit(20);

// Insert a new ingested event
await db.insert(schema.ingestedEvents).values({
  source: "github",
  type: "pull_request",
  payload: { action: "opened", number: 42 },
  adapterVersion: "1.0.0",
});
```

## Migrations

```bash
# Run all pending migrations
pnpm --filter @nexus/db migrate

# Generate a new migration after schema changes
pnpm --filter @nexus/db generate

# Push schema directly to DB (dev only — no migration file)
pnpm --filter @nexus/db push
```

Migrations live in `packages/db/migrations/`. They are run automatically in the Docker Compose `api` service start-up sequence.

## Environment

```
DATABASE_URL=postgresql://user:pass@host:5432/nexus
```

pgvector extension must be enabled:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

## Audit log integrity

The `audit_log` table uses HMAC-SHA256 chaining: each row's `chainHash` is computed over `(prevHash || entry)` signed with `NEXUS_AUDIT_KEY`. Any tampering with a row breaks the chain and is detectable by replaying `verifyChain()` from `@nexus/telemetry`.

Set `NEXUS_AUDIT_KEY` to a secret value and rotate it only during planned maintenance windows.
