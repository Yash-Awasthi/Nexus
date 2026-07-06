# TRACK-000 — Baseline (env + read surface)

Date: 2026-07-06. Goal: establish what actually works before hunting the break.

## Environment
- Ollama: **up** at :11434 — models `qwen2.5:7b`, `nomic-embed-text:latest`, `llama3.2:3b`.
- API: boots clean on :3000. Log: `[startup] ✓ Database reachable`. Neon Postgres + Redis Cloud from `.env`.
- UI: Vite dev server starts on :5173 (React Router v7).
- Known (STATUS.md): `tsc` is red repo-wide from a drizzle/pg dedupe — pre-existing, does NOT block runtime.

## Verified working (baseline green)
- `POST /api/v1/auth/register` → 200, returns `accessToken` (JWT). Login also works.
- **87/87** feature GET endpoints under `/api/*` → 200 (list/config/stats reads). Zero 500, zero 404.
- All 106 tested paths under `/api/v1/*` → 404 for the bridge features (expected: they live under `/api/*`, not v1).
- `POST /api/reasoning/run {"question":"hi"}` → 200, real Ollama answer, 7.6s. Core LLM path OK.
  - NOTE: handler hardcodes `model: "anthropic/claude-3.5-sonnet"` but Ollama driver serves it. Hardcoded model strings across bridge handlers = possible failure source for features whose driver mapping is less forgiving. Flag for later.

## Conclusion
Break is NOT in: boot, auth, or the read (GET) surface. It's in the **POST action layer** (feature runs). → TRACK-001.
