<!-- SPDX-License-Identifier: Apache-2.0 -->

# @nexus/ui

The NEXUS web dashboard — a **React Router 7 SPA** (`ssr: false`) built with Vite and
served as static files by nginx in production. It talks to the `apps/api` Fastify server
over HTTP/SSE; there is no server-side rendering and no edge runtime.

## Architecture

- `react-router.config.ts` → `{ ssr: false }` (SPA mode).
- Dev: Vite on port **5173**, proxying `/api/*` → `http://localhost:3001`.
- Production: nginx serves `build/client/` and proxies `/api/*` → the `apps/api` server.
- Build output: `apps/ui/build/client/` (static SPA bundle).

Because this is SPA mode, route `loader()` / `action()` exports are **not** used — they are
invalid here and break the build. Do all data access with `useEffect` + `fetch("/api/...")`
and client-side state (`useState`, zustand, context). Shared helpers live in `~/lib/*`.

## Commands

```bash
pnpm --filter @nexus/ui dev        # Dev server on :5173 with /api proxy
pnpm --filter @nexus/ui build      # Production build → build/client/
pnpm --filter @nexus/ui typecheck
```

## API surface

All calls go to `apps/api` (Fastify), under two prefixes:

- `/api/v1/*` — the versioned Nexus API (requires auth).
- `/api/*` — the api-bridge (uses server-side env keys).

Selected api-bridge endpoints:

| Method | Path                 | Description                    |
| ------ | -------------------- | ------------------------------ |
| POST   | /api/chat/stream     | Multi-model council SSE stream |
| POST   | /api/gauntlet/stream | Race N models, pick a winner   |
| GET    | /api/providers       | List available drivers         |
| POST   | /api/redteam/analyze | Red-team text transform        |
| GET    | /api/memory/entries  | Memory entries list            |
| GET    | /api/kg/graph        | Knowledge graph nodes          |

## Chat / deliberation

`app/lib/deliberate.ts` is the chat bridge: it POSTs to `/api/chat/stream` and dispatches
events over an `EventTarget` bus. Council members are configured in Settings and stored in
`localStorage` (`nexus_council`); thread history lives under `nexus_threads`.

## Routes & components

100+ routes live in `app/routes/`, registered in `app/routes.ts` and mostly wired to
`/api/*` via `useEffect` + `fetch`. UI primitives are Shadcn (Tailwind v4) in
`app/components/ui/`; icons come from `lucide-react`.

## Dev-server troubleshooting

**Symptom:** after editing an app module (especially under the `~` alias, e.g.
`app/lib/*.ts`), the running page keeps serving the OLD transform — new exports
are missing, imports of them fail, or behavior doesn't match source. The file
on disk is correct and `fetch("/app/<path>")` may even show the new code while
the page still runs the old module (react-router v7's dev plugin keys its
on-demand transform cache by alias-resolved module URLs and doesn't reliably
invalidate it on file change; `node_modules/.vite` prebundle is unrelated —
it only covers dependencies).

**Recipe:** restart the UI dev server — kill the vite process and re-run
`pnpm --filter @nexus/ui dev`. A full browser reload alone is NOT enough once
the stale transform is being served; the server restart clears the cache.
When verifying new UI code headlessly, restart vite first, then reload the page.
