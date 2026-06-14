---
id: api-reference
title: API Reference
sidebar_position: 7
---

# API Reference

The NEXUS REST API follows the OpenAPI 3.1 spec at [`packages/contracts/openapi/nexus-api.yaml`](https://github.com/Yash-Awasthi/Nexus/blob/main/packages/contracts/openapi/nexus-api.yaml).

**Base URL:** `http://localhost:3000/api/v1` (local) | `https://api.nexus.internal/v1` (production)

**Authentication:** `Authorization: Bearer <NEXUS_API_KEY>`

---

## Health

### `GET /health`

Liveness probe. Always returns 200 if the process is alive.

**Response:**

```json
{ "status": "ok", "version": "0.1.0", "timestamp": "2026-06-11T00:00:00.000Z" }
```

### `GET /health/ready`

Readiness probe. Checks DB + Redis connectivity.

**Response (ready):** `200 { "status": "ready", "checks": { "db": "ok" } }`  
**Response (not ready):** `503 { "status": "not_ready", "checks": { "db": "error: ..." } }`

---

## Ingest

### `POST /api/v1/ingest/events`

Accept a raw event from any adapter. Writes to DB + publishes to BullMQ.

**Body:**

```json
{
  "source": "github",
  "event_type": "pr.opened",
  "payload": { "repo": "acme/api", "pr": 42 },
  "priority": "medium",
  "idempotency_key": "github-pr-42-open"
}
```

**Response `202`:**

```json
{ "event_id": "uuid", "job_id": "uuid", "status": "accepted" }
```

### `GET /api/v1/ingest/events/:eventId`

Retrieve an ingested event by UUID. Returns `404` if not found.

### `POST /api/v1/ingest/signals`

Create a processed signal from one or more events.

**Body:**

```json
{
  "signal_type": "github.pr-event",
  "source_event_ids": ["uuid"],
  "summary": "PR #42 opened in acme/api",
  "priority": "medium"
}
```

**Response `201`:** Full signal row.

### `GET /api/v1/ingest/signals`

List signals with optional filters.

**Query params:** `signal_type`, `priority`, `limit` (default 50), `offset`

### `GET /api/v1/ingest/signals/:signalId`

Get a signal by UUID.

---

## Council

### `POST /api/v1/council/deliberate`

Run a full multi-model council deliberation. Calls up to 14 Groq LLM archetypes concurrently.

**Body:**

```json
{
  "proposal": {
    "title": "Deploy PR #42 to production?",
    "description": "New auth middleware — reviewed, tests pass"
  },
  "budgetUsd": 0.1,
  "signal_id": "optional-uuid"
}
```

**Response `200`:**

```json
{
  "ok": true,
  "result": {
    "proposalId": "uuid",
    "title": "Deploy PR #42 to production?",
    "outcome": "approved",
    "votes": [
      { "model": "llama-3.3-70b-versatile", "vote": "yes", "confidence": 0.85, "reasoning": "..." }
    ],
    "consensus": 0.78,
    "majority": "yes",
    "summary": "Council approved. 7 YES / 2 NO / 0 ABSTAIN.",
    "totalLatencyMs": 3241
  }
}
```

### `GET /api/v1/council/verdicts/:verdictId`

Get a persisted verdict by UUID.

### `GET /api/v1/council/transcripts/:verdictId`

Get the full deliberation transcript (all archetype turns) for a verdict.

---

## Runtime Tasks

### `GET /api/v1/runtime/tasks`

List tasks with optional filters.

**Query params:** `status` (queued/running/completed/failed/cancelled/awaiting_approval), `priority`, `limit`, `offset`

### `POST /api/v1/runtime/tasks`

Submit a new task for execution.

**Body:**

```json
{
  "type": "github.create-issue",
  "payload": { "owner": "acme", "repo": "api", "title": "Bug: login fails" },
  "priority": "high",
  "idempotency_key": "optional"
}
```

### `GET /api/v1/runtime/tasks/:taskId`

Get a task by UUID.

### `PATCH /api/v1/runtime/tasks/:taskId`

Cancel a queued task.

**Body:** `{ "action": "cancel" }`

---

## Governance

### `GET /api/v1/governance/approvals`

List approval requests. **Query params:** `status`, `limit`, `offset`

### `POST /api/v1/governance/approvals`

Create a new approval request.

### `POST /api/v1/governance/approvals/:approvalId/approve`

Approve a pending request. Automatically unblocks the associated task.

**Body:** `{ "resolved_by": "alice@acme.com", "reason": "optional" }`

### `POST /api/v1/governance/approvals/:approvalId/reject`

Reject a pending request. Automatically cancels the associated task.

---

## Audit

### `GET /api/v1/audit/log`

Paginated audit log. **Query params:** `since`, `until`, `limit`, `offset`

### `GET /api/v1/audit/log/verify`

Re-derives the HMAC chain and verifies integrity.

**Response:**

```json
{
  "valid": true,
  "checked_count": 1247,
  "message": "Chain intact"
}
```

If tampered: `{ "valid": false, "first_broken_sequence": 842, ... }`
