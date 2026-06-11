<!-- SPDX-License-Identifier: Apache-2.0 -->
# apps/web — NEXUS Dashboard

React SPA for monitoring and operating NEXUS. Built with React Router 7, Vite, and Tailwind CSS.

## Pages

| Route | Description |
|---|---|
| `/` | Overview dashboard — queue depths, health, SLO status |
| `/signals` | Signal feed with type/priority filters, real-time SSE updates |
| `/council` | Submit deliberation queries, browse past decisions |
| `/approvals` | Human-in-the-loop approvals — approve or reject pending tasks |
| `/runtime` | Circuit breaker states, crash recovery checkpoints |
| `/audit` | HMAC-chained audit log viewer |

## Development

```bash
# from monorepo root
pnpm --filter apps/web dev
# or
cd apps/web && pnpm dev
```

Dashboard starts at `http://localhost:5173`. Requires the API server running at `VITE_API_URL` (default: `http://localhost:3000`).

## Environment

```
VITE_API_URL=http://localhost:3000   # API server URL
VITE_APP_VERSION=dev                 # Shown in header
```

## Build

```bash
pnpm --filter apps/web build        # outputs to apps/web/dist/
```

The `dist/` directory is served as static files. In production, put it behind nginx or serve from the Fastify static plugin.
