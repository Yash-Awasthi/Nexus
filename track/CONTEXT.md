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
- [ ] commit mail-ingest fix (apps/api/src/routes/mail-ingest.ts).
- [ ] optional: gateway force-local when NEXUS_LLM_PROVIDER=ollama (currently prefers groq if key present).
- [ ] optional: remove stale GROQ_API_KEY from .env for truly key-free local.
- [ ] re-sweep GET surface + PATCH/DELETE (only POST fully swept twice; GET swept once early = green).
- Smoke scripts: `track/smoke2.sh` (v1+bridge POST, auto-relogin), results in `/tmp/smoke2.txt`.
