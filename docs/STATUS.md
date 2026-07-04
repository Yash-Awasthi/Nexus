# Nexus — Feature Status (local, no paid APIs)

_Last verified 2026-07-04. Stack: Fastify API (`:3000`) + React Router UI (`:5173`) + local Ollama (`:11434`, `qwen2.5:7b` + `nomic-embed-text`) + Neon Postgres + Redis Cloud. Tier gating is OFF — the only gate is login._

**How to test the AI quickly:** register in the UI, then any LLM page works locally. Or curl:
```bash
API=http://localhost:3000
T=$(curl -s -X POST $API/api/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"me@x.io","password":"LocalDev12345!"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
curl -s -X POST $API/api/reasoning/run -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/json' -d '{"question":"hi"}'
# → {"reasoning":"Hello! How can I assist you today?", ...}
```

---

## ✅ Working (verified end-to-end, local)

| Nav item | Notes |
|---|---|
| Dashboard | loads |
| Deliberations | real council: 5 **archetypes** each cast an LLM vote (`packages/council/engine.ts`) |
| Archetypes | roster of the council personas used in Deliberations (not decorative) |
| Workflows | UI loads (lobehub icons fixed); CRUD store — **no run engine yet** (see below) |
| Prompts | Postgres CRUD + versions |
| Skills | store-backed |
| Knowledge Bases | KG-store backed list + ingest |
| Repositories | GitHub API when `GITHUB_TOKEN` set, else empty list |
| Memory | write + embed (Ollama 768-dim) + recall + list |
| Connectors / Add / Sync Status | registry + **sync-jobs now persisted** |
| God Mode | per-member `driver.complete()` |
| Gauntlet | streams; crash-guarded |
| Red Team (prompt-filter) | `@nexus/redteam` |
| STM | transform pipeline |
| Drift | compute/rate/detect |
| Blind Council | identity-hidden council votes |
| Deep Research | scraper (Tavily if key) |
| A/B Arena | `raceModels` |
| Simulation | LLM persona ticks |
| Knowledge Graph | store-backed (`/kg/graph`, `/kg/search`) |
| Agents | librarian/file agents |
| Projects | `/api/v1/projects` CRUD |
| Evaluation | LLM judge + results store |
| Marketplace | plugin registry CRUD |
| Sandbox | JS (Node vm) + Python (Pyodide/WASM) local |
| Image Gen | needs `OPENAI_API_KEY`/Replicate key |
| Moderation | OpenAI moderation or heuristic fallback |
| Semantic Cache | **real Ollama-embedding cosine** + `/store` |
| Fallback Chains | list/run/test (test needs a valid `chainId`) |
| Settings / Profile | preferences store |
| Cost Analytics | from real `_costLog` |
| API Tokens | `nxk_` + sha256, Postgres |
| Provider Keys | AES-256-GCM encrypted, Postgres |
| Standard Answers | persistent + LLM match |
| Web Search | POST `/web-search {query}` — Tavily→SearXNG |
| Scraping | Firecrawl/Exa/basic |
| Rooms | in-mem CRUD |
| Admin → Users | **real Postgres `users` table** |
| Admin → Analytics | **real `gatewayLog.stats()`** (no more random) |
| Admin → Audit Log | **real hash-chained `audit_log`** (populates on register/provider-key) |
| Admin → Traces | gateway log |
| Feature Flags | store-backed |
| Feedback | **real store + reactions signal** + `POST /feedback` |
| Cost / Costs limits | real env + spend/remaining |

## ⚙️ Needs a key/runtime (code is real, just unconfigured)

- **Image Gen / Fine-Tune** → `OPENAI_API_KEY` (or Replicate).
- **Voice transcribe/synthesize** → `GROQ_API_KEY` / `ELEVENLABS_API_KEY`.
- **Repositories** → `GITHUB_TOKEN`.
- **Sandbox Go/Rust/Ruby/etc** → local Piston (`PISTON_URL`); JS + Python already work with nothing.
- **Video transcript** → `YOUTUBE_API_KEY` (honest 503 without it).
- **Language Models leaderboard** → curated static numbers, labeled `measured:false` (intentional, not live-benched).

## 🔧 Has code but needs plumbing (partial — real handler, missing engine/wiring)

- **Workflows run engine** — CRUD + canvas exist; no DAG executor (`/workflows/:id/run`). Draws & saves, doesn't execute.
- **Verifiable pipelines** — `/verifiable/emit,verify,info` exist; the actual verification checks are shallow (no real pipeline runner).
- **KB/KG deep ingest** — list + basic ingest work; large-doc chunked indexing + `jobId` progress is mocked.
- **Repo search** — `/repos/:id/search` returns hardcoded matches (no real index/GH code search).
- **Fine-Tune** — OpenAI files/jobs wired but error handling is thin; export needs ≥10 rated examples.

## ❌ Not built yet (nav item with no real backend)

- **Notifications** — no route/store anywhere. Nav item is dead.
- **Diff rollback** — `/diff/apply` works; `/diff/rollback` missing (no edit history).
- **Billing / subscription** — intentional: Nexus is free + BYOK, checkout is a no-op.
- **Video (search/transcript)** — search works with key; transcript is a stub even with key (needs `youtube-transcript` + STT).

## Known caveats

- **tsc is red repo-wide** from a pnpm dual-drizzle-version dedupe (`pg 8.21` vs `8.22`, `shouldInlineParams`). Pre-existing, hits untouched files (auth-users, workspaces…), does **not** block runtime. Fix = dedupe drizzle-orm/pg in the lockfile.
- **Memory cold-recall** can miss once right after restart (Ollama warm-up); warm calls are reliable.
- **Configuration pages** (Language Models, Settings, Profile, Billing, etc.) previously threw `useRef null` from a duplicated React copy → fixed via `resolve.dedupe: ["react","react-dom"]` in `apps/ui/vite.config.ts`.
