# CONTEXT — resume file (read this first after a context clear)

**Task:** Fix "Nexus broken". Method: sweep every route → find 500s/bugs → fix one by one → verify.
**Branch:** `ollama` (user override of main-only). Commit as we go. Full audit log = `track/README.md` + `TRACK-00x`.

## Runtime (bring it up)
```
nohup ollama serve > /tmp/ollama.log 2>&1 & disown          # qwen2.5:7b, nomic-embed-text
cd /home/yash/Desktop/PROJECTS/Nexus
nohup bash scripts/dev-local.sh api > /tmp/napi.log 2>&1 & disown   # :3000, loads .env
```
Token: `T=$(curl -s -X POST localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' -d '{"email":"audit@nexus.local","password":"LocalDev12345!"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')`
Token expires 15min. Re-login. tsx watch hot-reloads apps/api/src. **packages/* need `pnpm --filter <pkg> build`** (consumed as dist).

## Core root cause (learned)
TWO LLM stacks: `@nexus/llm-drivers` (has Ollama, works) vs `@nexus/llm-router` (groq/claude only, no Ollama → 500 local). Fix pattern = when `NEXUS_LLM_PROVIDER=ollama`, add `OpenAIProvider({apiKey:"ollama",baseUrl:OLLAMA_BASE_URL+"/v1",providerName:"ollama"})` first + alias→ollama. `.env` has stale `GROQ_API_KEY` that forces the broken groq path.

## DONE (committed on `ollama`)
- 000 baseline: boot/auth/GET/reasoning green.
- 001: 7 unguarded `.slice()` on missing field → 400 (honesty/hallucination/citations).
- 002: nlp/kg routed groq→404; now local Ollama. Fixed groq baseUrl `/openai/v1`.
- 003: `/llm/complete` 502 → local Ollama.
- 004: 8 Class B/C 500s (DB NOT-NULL, uuid-cast, undefined.map) → 400.
- 005: **council fully key-free on Ollama** (deliberate/stream/trigger 200, votes labeled ollama).
- `_getPool` sentinel bug: `_pgPool=null` init made pool never build → ALL raw-pg api-bridge routes DB-dead (prompts couldn't save, GETs silent-empty). Fixed → undefined init. HIGH impact.
- mail-ingest/start 500→503 (needs IMAP key; matched /poll guard). **UNCOMMITTED — commit next.**

## Verified: full POST sweep (130 routes) = 0 × 500 (except needs-key honest ones now 503).

## NOT bugs (by design)
- `/api/*` auth 501 = api-bridge stubs. gateway 200 (has ollama fallback, prefers groq if key). 503 = needs key (images/exa/scim/fine-tune/video). code-agent 200 but Piston remote exec whitelist-only (Sandbox uses Pyodide local instead).

## TODO / next
- [x] mail-ingest fix committed.
- [x] `_getPool` sentinel fixed (raw-pg routes live).
- [x] DB migrated 0007→0013 (drizzle-kit migrate) — billing/orchestration/agent-sessions/oauth/mcp tables now exist.
- [x] GET surface swept twice → 0×500 (242 routes). POST swept twice → 0×500 (130).
- [ ] optional: gateway force-local when NEXUS_LLM_PROVIDER=ollama (skipped — not erroring, risky).
- [ ] optional: remove stale GROQ_API_KEY from .env for truly key-free local.
- [ ] not yet swept: PATCH/DELETE verbs (low risk, mostly store ops).
- Migrate cmd: `DBURL=$(grep ^DATABASE_URL= .env|cut -d= -f2-); DATABASE_URL="$DBURL" pnpm --filter @nexus/db exec drizzle-kit migrate`

## Status: whole GET+POST API surface = 0×500. Remaining non-2xx expected (501 stubs, 503 needs-key, 400 validation, 403 tier, 404 artifact).

## UI (TRACK-007) — the REAL "broken"
- **Root cause:** UI raw `fetch("/api/...")` (178 sites) sent NO token → `/api/*` requireAuth → 401 → pages empty.
- **Fix:** `apps/ui/app/lib/install-auth-fetch.ts` global fetch interceptor (attaches nexus_token), wired in root.tsx.
- Notifications backend added (bell was 404). agents + knowledge-graph shape-crash fixed.
- UI smoke: 59/59 FAIL → ~2 non-bugs. Playwright: `node track/ui-smoke.mjs` (needs UI on :5173).
  Chrome: `/home/yash/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`. Use `playwright-core`, run FROM repo root.
- Boot UI: `nohup bash scripts/dev-local.sh ui > /tmp/nui.log 2>&1 & disown`

## Commits on `ollama`: 10. Clean tree.

## ═══ NEXT PLANS (do in order) ═══
1. **Full UI crash sweep** — `track/ui-smoke.mjs` catches blank/ErrorBoundary but ~90 pages exist and only
   agents+kg checked deeply. Now that data flows, MORE shape-mismatch crashes likely (array-vs-{key:[]},
   name-vs-label class). Expand PAGES list to all routes, run warm (2x each), fix each `.map/.length on undefined`.
2. **/api-tokens** page → blank (len 82). Investigate (real crash or route).
3. **PATCH/DELETE verb sweep** — never swept. Extract via python (multiline regex), hit with dummy ids, capture 500s.
4. **Notifications are empty** — store exists but nothing emits. Wire real events (or leave as honest empty).
5. Optional: gateway force-local (NEXUS_LLM_PROVIDER=ollama); drop stale GROQ_API_KEY from .env.
6. Optional: replace 178 raw fetches with authFetch explicitly (interceptor covers them, but explicit is cleaner + SSR-safe).
7. Merge `ollama` → main when satisfied (user override put us on ollama; confirm before merge).
