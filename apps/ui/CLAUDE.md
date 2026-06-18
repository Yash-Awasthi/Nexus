# apps/ui — Agent Quick Reference

## Architecture (as of 2026-06-17)

React Router 7 **SPA mode** (`ssr: false`). Deployed as static files served by nginx.
NOT Cloudflare Workers. NOT SSR. NOT Electron. NOT Durable Objects.

### Key facts
- `react-router.config.ts` → `{ ssr: false }`
- Dev server: Vite on port 5173, proxies `/api/*` → `http://localhost:3001`
- Production: nginx serves `build/client/`, proxies `/api/*` → apps/api Fastify server
- Build command: `pnpm --filter @nexus/ui build`
- Output: `apps/ui/build/client/` (static SPA bundle)

### DO NOT use in this project
- `loader()` / `action()` exports — invalid in SPA mode, will break build
- `window.cloudflare` / Durable Object bindings
- `wrangler` / Cloudflare Workers patterns
- Bun-specific APIs
- `@splinetool/react-spline` (removed, stubbed in splite.tsx)

### VALID patterns
- `useEffect` + `fetch("/api/...")` for all data fetching
- Client-side state management (useState, zustand, context)
- `~/lib/*` utilities for shared logic
- Shadcn UI components in `~/components/ui/`

## API Surface

All API calls go to `apps/api` (Fastify). Two prefixes:
- `/api/v1/*` — versioned Nexus API (requires auth)
- `/api/*`    — api-bridge (no auth, uses server-side env keys)

### Key endpoints (api-bridge, no auth needed)
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/chat/stream | Multi-model council SSE stream |
| POST | /api/gauntlet/stream | Race N models, pick winner |
| POST | /api/godmode/stream | Parallel council race |
| GET  | /api/providers | List available drivers |
| POST | /api/redteam/analyze | Red-team text transform |
| GET  | /api/memory/entries | Memory entries list |
| GET  | /api/kg/graph | Knowledge graph nodes |

## Chat / Deliberation

`app/lib/deliberate.ts` — dual-mode bridge:
- If `window.molecule` exists → Electron IPC path (desktop app)
- Otherwise → web path: POST to `/api/chat/stream`, EventTarget event bus

Council members configured in Settings, stored in `localStorage` under `nexus_council`.
Thread history stored in `localStorage` under `nexus_threads`.

## Routes

100+ routes in `app/routes/`. Most are wired to `/api/*` via `useEffect + fetch`.
See `app/routes.ts` for full list.

## Component Library

Shadcn UI (Tailwind v4). All primitives in `app/components/ui/`.
Icons: `lucide-react@1.x` — `Spider` does NOT exist, use `Bug` instead.

## Commands

```bash
pnpm --filter @nexus/ui dev     # Dev server on :5173 with /api proxy
pnpm --filter @nexus/ui build   # Production build → build/client/
pnpm --filter @nexus/ui typecheck
```
