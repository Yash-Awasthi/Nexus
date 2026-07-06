# Nexus Repair Track — Index

Persistent log of the "nexus is broken" audit. Resume from here any time.
Procedure per issue: **inspect → check if fix exists elsewhere → fix → re-verify → next.**
Work directly on `main`, edit in place (no branches/worktrees).

## How to resume the running system
```bash
# 1. Ollama (LLM + embeddings)
nohup ollama serve > /tmp/ollama.log 2>&1 & disown        # models: qwen2.5:7b, nomic-embed-text, llama3.2:3b
# 2. API (:3000) — loads .env
cd /home/yash/Desktop/PROJECTS/Nexus
nohup bash scripts/dev-local.sh api > /tmp/napi.log 2>&1 & disown
# 3. UI (:5173) — optional
nohup bash scripts/dev-local.sh ui > /tmp/nui.log 2>&1 & disown
# token for smoke tests:
cat /tmp/nexus-token.txt   # audit@nexus.local / LocalDev12345!
```

## Route layers (critical context)
- `/api/v1/*` — real DB-backed handlers (auth-users, council, memory, etc.). server.ts registers route modules under this prefix.
- `/api/*` — **api-bridge.ts** (~7900 lines, 158 GET + 162 POST). This is where MOST feature actions live. Auth-gated (requireAuth).
- `/api/v1/gs/*` — conductor orchestration.
- api-bridge route idiom: `app.post<{ Body: ... }>("/path", handler)` — generics between method and `(`.

## Symptom being chased
User: "a specific feature returns an error (500 / wrong data)". Sign-in works. Boot works.

## Track files
| # | Title | Status |
|---|-------|--------|
| 000 | Baseline — env, boot, auth, GET+reasoning green | ✅ done |
| 001 | 6+1 unguarded `.slice()` on required body → 500→400 | ✅ done |
| 002 | Class A: llm-router→groq 404 → route to local Ollama (nlp, kg) | ✅ done |
| 003 | llm/complete 502 → local Ollama; council/gateway reviewed (no bug) | ✅ done |
| 004 | Class B (DB-insert 500s) + Class C (undefined-access 500s) | ✅ done |
| 005 | Council runs fully key-free on local Ollama (+ correct provider label) | ✅ done |

## Branch
Work is on branch **`ollama`** (user override of main-only rule, for this effort).

## Full POST sweep result (131 routes): 11 × 500, 3 classes
- **A (fixed):** nlp/entities, nlp/relationships, knowledge-graph/ingest — groq 404, now local Ollama.
- **B (DB):** council/trigger, governance/approvals, ingest/events, ingest/signals, runtime/tasks — bad-input → DB error → 500 (should 400).
- **C (undefined):** scraping/bulk, godmode/stream (`.map` of undefined), negation/add (`patterns is not iterable`).

## Findings log (one line each, newest last)
- 000: API boots clean, DB reachable, auth OK, 87/87 GET features → 200, `POST /api/reasoning/run` → 200 (Ollama, 7.6s). No 500s in read surface.
- 001: `/api/*` POST sweep (135 routes) → only 6 × 500, all `undefined.slice()` on a missing required field (citations/hallucination/honesty cluster). Fixed w/ standard 400 guard (+confidence-calibrate, same class). NOT UI-reachable (UI sends fields), so not the user's observed break. Fixed anyway.
- 002: Full sweep of 131 untested POSTs (multiline-registered routes my first extractor missed) → 11 × 500 in 3 classes. **Class A = the real break:** nlp/kg route via `@nexus/llm-router` whose only providers are groq/claude — no Ollama. `.env` stale `GROQ_API_KEY` forced groq, which 404s (base URL missing `/v1`), no fallback → hard 500. Fixed: route `nexus/fast`→local Ollama (`OpenAIProvider`→`/v1`) when `NEXUS_LLM_PROVIDER=ollama`; fixed groq base URL. Verified 200/201 local.
- 004: Class B (5 DB-insert/cast 500s) + Class C (3 undefined-access 500s) all hardened to 400. Regression: all 11 formerly-500 routes now 0×500.
- 003 (open): `/llm/complete`→502 and council/gateway may degrade to null locally — same groq root cause, same Ollama-first fix applies. In progress.
