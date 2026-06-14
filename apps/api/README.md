<!-- SPDX-License-Identifier: Apache-2.0 -->

# apps/api — NEXUS API Server

Fastify HTTP/WebSocket gateway. The central entry point for all external and internal communication with NEXUS.

## Routes

| Method | Path                           | Description                                                 |
| ------ | ------------------------------ | ----------------------------------------------------------- |
| `GET`  | `/v1/health`                   | Liveness check                                              |
| `GET`  | `/v1/health/ready`             | Readiness check (DB + Redis)                                |
| `GET`  | `/v1/health/aggregate`         | Full component health + SLO status                          |
| `POST` | `/v1/council/deliberate`       | Submit a question for multi-model deliberation              |
| `GET`  | `/v1/council/history`          | Past deliberation results                                   |
| `GET`  | `/v1/ingest/events`            | List ingested events (filterable)                           |
| `GET`  | `/v1/ingest/signals`           | List classified signals (type/priority filter + pagination) |
| `GET`  | `/v1/ingest/signals/:signalId` | Single signal fetch                                         |
| `GET`  | `/v1/runtime/status`           | Queue depths, circuit breaker states                        |
| `POST` | `/v1/runtime/tasks`            | Enqueue a task                                              |
| `GET`  | `/v1/audit`                    | HMAC-chained audit log entries                              |
| `GET`  | `/v1/governance/approvals`     | Pending human-in-the-loop approvals                         |
| `POST` | `/v1/governance/approvals/:id` | Approve or reject                                           |
| `GET`  | `/metrics`                     | Prometheus scrape endpoint                                  |

All routes under `/v1/` require `Authorization: Bearer <token>` (API key or HS256 JWT — see `@nexus/auth`).

## Development

```bash
# from monorepo root
pnpm --filter apps/api dev
# or
cd apps/api && pnpm dev
```

Server starts on `http://localhost:3000`.

## Environment

Key variables (see `../../.env.example` for the full list):

```
DATABASE_URL=postgresql://...
REDIS_URL=redis://localhost:6379
NEXUS_API_KEY=your-secret-api-key
JWT_SECRET=your-jwt-secret
PORT=3000
LOG_LEVEL=info
```

## Testing

```bash
pnpm --filter apps/api test
```

## Docker

```bash
docker build -f ../../Dockerfile.api -t nexus-api .
docker run -p 3000:3000 --env-file ../../.env nexus-api
```

Or via Compose from the repo root: `docker compose up api`.
