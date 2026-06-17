# Next Move — Session Handoff

> Read this at session start. Execute the first item on the list immediately.
> Update before every push. This is the autonomous loop.

## Current State (as of 29e44b9)

*Build: GREEN ✓ | Chat: WORKS IN BROWSER ✓*

### What shipped this session
- `apps/ui/CLAUDE.md` — rewrote from Cloudflare/SSR fiction to real SPA/nginx architecture
- `apps/api/src/routes/judica-compat.ts` — added `POST /api/chat/stream` (multi-model SSE fan-out)
- `apps/ui/app/lib/deliberate.ts` — web fallback: EventTarget bus + /api/chat/stream, threads in localStorage
- `CLAUDE.md` (platform) — added next_move.md to startup, Autonomous Work Rules

### Architecture now
| Layer | Status |
|-------|--------|
| apps/api (Fastify) | deployed, /api/v1/* + /api/* judica-compat |
| apps/ui (React Router 7 SPA) | builds green, nginx deploy |
| Chat deliberation | works in browser — no Electron needed |
| Multi-model streaming | /api/chat/stream fans out to N models |

---

## Immediate Next Actions (execute in order)

### 1. Wire the Settings page to actually save council members
`apps/ui/app/routes/settings.tsx` — verify the council settings UI saves to localStorage correctly.
The deliberate.ts web path reads council from localStorage via `loadCouncilMembers()`.
If Settings doesn't persist properly, chat will always use default (likely empty) council.
Fix: ensure Settings → Council tab calls `saveCouncilMembers()` from `~/lib/council`.

### 2. Add a "web mode" banner to chat.tsx
When `!isMolecule()` (browser mode), show a subtle info banner:
"Web mode — configure API keys in Settings → Council to enable multi-model chat."
This tells users why chat might show empty if they haven't set up council members.

### 3. Wire language-models.tsx to real /api/v1/models endpoint
`apps/ui/app/routes/language-models.tsx` currently shows 4 fetch calls.
Check what URL it hits. If it's calling a dead endpoint, update to `/api/v1/gateway/models`
or `/api/providers` (judica-compat).

### 4. Wire memory.tsx to real /api/memory/entries
Memory page has 6 API calls — verify they hit `/api/memory/entries` and the response
format matches what the component expects. Fix any field name mismatches.

### 5. Wire knowledge-graph.tsx to /api/kg/graph
Has 10 API calls. Verify endpoint URLs and response shapes match.

### 6. STM and TTS stubs in judica-compat.ts
chat.tsx calls:
- POST /api/stm/history (best-effort, non-blocking)
- POST /api/tts (text-to-speech)
Add 200 OK stubs for both so chat doesn't log errors. TTS can return empty audio for now.

---

## Known Issues / Watch List
- Browser-mode council members (ChatGPT, Gemini, Claude web) are skipped in web mode
  → they require Electron. This is expected. API-mode members work fine.
- Thread history in web mode is localStorage-only — lost on clear. Backend persistence is TODO.
- `/api/stm/history` and `/api/tts` return 404 — non-fatal (best-effort calls) but noisy in logs.

---

## Commit Log (recent session)
- `29e44b9` docs(ui): rewrite CLAUDE.md
- `36c6eb8` feat(chat): web-native deliberation — no Electron required
- `44be94e` docs: add next_move.md session handoff loop
- `0bba9ab` fix(ui): build green — 3 build blockers

---

## How This Loop Works
1. Session starts → read this file → execute item #1
2. Do work → commit + push after each logical unit
3. Update this file with new state and shift completed items out
4. Push this file with every session-end push
