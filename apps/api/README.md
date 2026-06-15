<!-- SPDX-License-Identifier: Apache-2.0 -->

# apps/api — NEXUS API Server

Fastify HTTP/SSE gateway. The central entry point for all external and internal communication with NEXUS.

## Routes

All routes under `/v1/` require `Authorization: Bearer <token>` (API key or HS256 JWT — see `@nexus/auth`).

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/health` | Liveness check |
| `GET` | `/v1/health/ready` | Readiness check (DB + Redis) |
| `GET` | `/v1/health/aggregate` | Full component health + SLO status |
| `GET` | `/metrics` | Prometheus scrape endpoint |

### Gateway (LLM streaming)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/gateway/chat` | Streaming LLM inference via SSE — provider routed by `@nexus/llm-router` |
| `GET`  | `/v1/gateway/context` | Current context window contents |

### Agent runtime

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/runtime/run` | Start a multi-step agent run (streamed via SSE) |
| `GET`  | `/v1/runtime/status` | Queue depths, circuit breaker states |
| `POST` | `/v1/runtime/tasks` | Enqueue a discrete task |

### Code execution (sandboxed)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/code-repl/execute` | Execute Python/R/Julia in a Docker REPL sandbox |
| `GET`  | `/v1/code-repl/sessions` | List active kernel sessions |
| `DELETE` | `/v1/code-repl/sessions/:id` | Terminate a session |

### Council

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/council/deliberate` | Submit a question for multi-model deliberation |
| `GET`  | `/v1/council/history` | Past deliberation results |

### Ingest / signals

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/ingest/events` | List ingested events (filterable) |
| `GET` | `/v1/ingest/signals` | List classified signals (type/priority filter + pagination) |
| `GET` | `/v1/ingest/signals/:signalId` | Single signal fetch |

### Domain feeds

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/domain-feeds` | Latest events across all 11 intelligence domains |
| `GET` | `/v1/domain-feeds/:domain` | Events for a specific domain (aviation/climate/cyber/…) |

> Feed data is refreshed by BullMQ repeatable jobs in `apps/worker` — not by this route handler. The route is read-only.

### Prediction market

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/v1/prediction-market/markets` | List active prediction markets (Polymarket CLOB) |
| `POST` | `/v1/prediction-market/orders` | Place an order |
| `GET`  | `/v1/prediction-market/positions` | Current positions |

### Connectors / OAuth

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/v1/connectors` | List registered connectors and their auth state |
| `POST` | `/v1/connectors/:id/oauth/start` | Initiate OAuth 2.0 flow |
| `GET`  | `/v1/connectors/:id/oauth/callback` | OAuth callback handler |

### Knowledge & memory

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/knowledge-graph/query` | Query the entity/relation graph |
| `GET`  | `/v1/corpus-builder/status` | Corpus ingestion job status |
| `POST` | `/v1/corpus-builder/ingest` | Trigger corpus ingestion |

### SSE

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/sse/events` | Server-sent event stream — subscribe to agent/signal/council events |

### Observability & admin

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/v1/audit` | HMAC-chained audit log entries |
| `GET`  | `/v1/governance/approvals` | Pending human-in-the-loop approvals |
| `POST` | `/v1/governance/approvals/:id` | Approve or reject |
| `GET`  | `/v1/obs-providers` | Observability provider status |
| `GET`  | `/v1/feature-flags` | Feature flag values |
| `POST` | `/v1/admin/purge` | Purge stale data (admin only) |
| `GET`  | `/v1/billing/usage` | Token and request usage summary |

### Other

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/v1/context` | Retrieve current context pack for a session |
| `GET`  | `/v1/stm` | Short-term memory contents for a session |
| `GET`  | `/v1/voice/tts` | Text-to-speech synthesis |
| `GET`  | `/v1/chat-suggestions` | Context-aware reply suggestions |
| `GET`  | `/v1/wiki` | Wiki article lookup |
| `GET`  | `/v1/image-gen` | Text-to-image generation |

---

## Development

```bash
# from monorepo root
pnpm --filter apps/api dev
# or
cd apps/api && pnpm dev
```

Server starts on `http://localhost:3000`.

---

## Environment

Key variables (see `../../.env.example` for the full list):

```
DATABASE_URL=postgresql://...
REDIS_URL=redis://localhost:6379
NEXUS_API_KEY=your-secret-api-key
NEXUS_AUDIT_KEY=your-hmac-key
JWT_SECRET=your-jwt-secret
GROQ_API_KEY=...
PORT=3000
LOG_LEVEL=info
```

---

## Architecture notes

- **Streaming** — gateway and runtime routes use Fastify's `reply.raw` to write SSE frames directly; no response buffering
- **Auth** — `@nexus/auth` preHandler hook validates every `/v1/` request; unauthenticated requests get `401` before reaching route logic
- **Context pruning** — `@nexus/context-pruner` trims the context window to the token budget before forwarding to LLM providers
- **Worker hand-off** — routes that trigger async work (deliberation, corpus ingestion) enqueue BullMQ jobs and return a job ID immediately; callers poll `/v1/runtime/status` or subscribe to `/v1/sse/events`
- **Code REPL** — `DockerReplExecutor` is used when Docker is available; falls back to `MockReplExecutor` automatically (no crash)

---

## Testing

```bash
pnpm --filter apps/api test
```

---

## Docker

```bash
docker build -f apps/api/Dockerfile -t nexus-api .
docker run -p 3000:3000 --env-file .env nexus-api
```

Or via Compose from the repo root: `docker compose up api`.
