# Next Move — Session Handoff

> Read this at session start. Execute the first item on the list immediately.
> Update before every push. This is the autonomous loop.

## Current State (as of fddde59)

*Build: GREEN ✓ | All major pages: STUBBED ✓ | Thread persistence: DONE ✓*

### What shipped this session
| Commit | What |
|--------|------|
| 5bee1ac | Chat web mode banner + STM/TTS/memory/KG 200 stubs |
| fc48e55 | PUT /memory/backend + POST /kg/search + POST /kg/traverse method fixes |
| d12c79e | Thread message persistence in localStorage (survive refresh) |
| a4b5190 | /autotune/optimize SSE stub |
| 192f773 | Deep-research CRUD + SSE stream stubs |
| 64465c1 | Connectors + skills CRUD stubs |
| fddde59 | Knowledge bases + images + tokens stubs |

### Coverage map (judica-compat /api/* endpoints)
| Page | Status |
|------|--------|
| chat.tsx | ✅ Full — SSE streaming, thread persistence, web mode banner |
| settings.tsx | ✅ Full — council save, preferences, analytics |
| memory.tsx | ✅ Full — entries, stats, backend, compact |
| knowledge-graph.tsx | ✅ Full — graph, search (GET+POST), traverse (GET+POST), communities |
| language-models.tsx | ✅ Full — providers list |
| deep-research.tsx | ✅ Stubbed — create/list/stream/get jobs |
| autotune.tsx | ✅ Stubbed — SSE optimize returns original prompt |
| workflows.tsx | ✅ Full CRUD |
| repos.tsx | ✅ Partial (GET stubs, POST/DELETE wired) |
| connectors-onboarding.tsx | ✅ Stubbed CRUD |
| skills.tsx | ✅ Stubbed CRUD |
| evaluation.tsx | ✅ Stubbed |
| knowledge-bases.tsx | ✅ Stubbed CRUD |
| image-gen.tsx | ✅ Stubbed (503 with clear message) |
| costs/* | ✅ Stubbed |
| scrape.tsx | ✅ Stubbed (web-scraping prefix) |
| reasoning.tsx | ✅ Real (uses driver) |

### Deployed API
- `nexus-api.onrender.com` — live but running OLD build (pre-Fastify migration)
- Root `/` → "NEXUS v2" (old Express version)
- Render auto-deploys from main — new build should pick up all commits
- `/api/providers` will work once new deploy completes

---

## Immediate Next Actions (execute in order)

### 1. Wire scrape.tsx to real web-search endpoint
`scrape.tsx` calls `/api/web-scraping/scrape` and `/api/web-scraping/crawl`.
These are in STUB_PREFIXES (501). But `/api/web-search` (POST) IS real.
Add a `/api/web-scraping/scrape` stub that actually calls the web-search driver:
- Take `url` or `query` from body
- Call `driver.webSearch()` if available, else return 503
Check: does `@nexus/web-search` have a `scrape(url)` method? If yes, use it.

### 2. Fine-tune the real deep-research stream
The `/api/research/:id/stream` is a stub. The real `@nexus/researcher` package
exists at `packages/researcher/`. Check if it has a `research(query)` method
that returns async iterable or callback.
If yes: wire it into the research stream endpoint so real research happens.

### 3. Admin pages audit
`admin-users.tsx` and `admin-analytics.tsx` call:
- `GET /api/admin/users` → missing
- `GET /api/analytics/overview` → exists ✅
- `GET /api/admin/audit-logs` → missing
Add minimal stubs returning empty arrays.

### 4. Billing pages
`GET/POST /api/billing/plans` and `GET /api/billing/checkout` missing.
Add stubs returning plan data so billing page renders without error.

### 5. Connect real autotune to settings
The EMA-based autotune (compute sampling params) IS real in `@nexus/autotune`.
Wire a `/api/autotune/compute` endpoint that calls `computeAutoTuneParams()`
so settings can show real optimal params per context type.

---

## Known Gaps
- Thread messages stored in localStorage only — lost if browser storage cleared
- Images: needs OPENAI_API_KEY or REPLICATE_API_KEY in env to work
- KB document upload: returns 202 "indexing" but doesn't actually index
- Research: returns stub result, not real research
- Deployed Render instance on old build — wait for auto-deploy

---

## Commit Log (recent)
- `fddde59` feat(api): kb, images, tokens stubs
- `64465c1` feat(api): connectors + skills CRUD stubs
- `192f773` feat(api): deep-research + autotune stubs
- `a4b5190` feat(api): autotune/optimize SSE stub
- `d12c79e` feat(chat): thread message persistence
- `fc48e55` fix(api): method mismatches

---

## How This Loop Works
1. Session starts → read this file → execute item #1
2. Do work → commit + push after each logical unit
3. Update this file with new state and shift completed items out
4. Push this file with every session-end push
