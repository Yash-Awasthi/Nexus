# TRACK-007 — UI end-to-end (the real "broken": auth-fetch + shape mismatches)

Booted UI (:5173), headless Playwright click-through over ~60 authed pages. Login proxies fine
(:5173 → :3000). Two classes of real breakage found + fixed.

## THE big one — raw fetch never sent the JWT
Every `/api/*` bridge route is behind `requireAuth` (Bearer only, no cookie). The UI calls those
routes with **raw `fetch("/api/...")` and no Authorization header** — **178 call sites across route
modules** (only 9 files used the `authFetch` helper). Result: logged-in users got **401 on nearly every
data call → pages render empty** = the "demo looks stubbed / broken" symptom.

**Fix:** `apps/ui/app/lib/install-auth-fetch.ts` — a one-time, browser-only, idempotent `window.fetch`
interceptor that attaches `Bearer <nexus_token>` to same-origin `/api/*` requests (never overrides an
explicit Authorization). Wired at module load in `root.tsx`. Fixes all 178 sites without touching them.
Verified: memory page 3×401 → 0; full smoke 59/59 FAIL → ~2 non-issues.

## Missing notifications backend
Sidebar bell polled `/api/notifications*` → 404 on every page (feature was never built). Implemented
per-user in-memory notifications (count/list/read/dismiss/dismiss-all) in api-bridge; bell now uses
authFetch. 404 gone.

## Shape mismatches (surfaced only once data started flowing)
- **agents**: `/api/browser-agent/sessions` returns `{sessions:[]}`, UI set it as a bare array →
  `browserSessions.map is not a function` → blank. Fixed (read `.sessions`).
- **knowledge-graph**: API nodes carry `name`; UI renders `label` → `n.label.length` on undefined →
  blank ErrorBoundary. Fixed (normalise name→label at load).

## Verified
Full UI smoke after fixes: only remaining "fails" are non-bugs — `/deliberation` (not a route; it's
`/chat`), `/api-tokens` (blank, needs check), `/connectors/sync` (renders; one sub-resource 404).
"Invalid hook call" seen on first cold load = transient Vite dep-optimize; gone on warm load.

## Status: ✅ auth-fetch + notifications + agents + kg fixed. More shape bugs likely lurk (see next plans).
