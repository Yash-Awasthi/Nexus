---
id: spectre
title: SPECTRE
sidebar_position: 4
---

# SPECTRE — Signal Without Noise

SPECTRE is a multi-model AI chat interface built on top of the Nexus platform. It lives at `apps/spectre/` in the monorepo and is served as a Vite+React SPA.

## Running SPECTRE

```bash
# With the Nexus API already running on port 3000:
VITE_API_URL=http://localhost:3000 VITE_API_KEY=your-key pnpm dev:spectre
# → http://localhost:5174
```

Or via Docker:

```bash
docker compose --profile spectre up spectre
# → http://localhost:5174
```

## Modes

### CHAT

Standard multi-model chat with session history stored in `localStorage`. Features:

- Session sidebar with auto-titling (first 42 chars of first message)
- 6 model presets: nexus/smart, nexus/fast, Claude 3.5, GPT-4o, Gemini Flash, Grok 3
- Sessions persist across browser reloads — no account required

### PHANTOM

5 original model+prompt combos race in parallel via `Promise.allSettled`. Each combo fires simultaneously; cards resolve live as responses arrive. Winner is crowned by signal density (response length as proxy).

| Combo           | Model                            |
| --------------- | -------------------------------- |
| 👻 PHANTOM-1    | anthropic/claude-3.5-sonnet      |
| ⚡ PHANTOM-2    | x-ai/grok-3                      |
| 🔮 PHANTOM-3    | google/gemini-2.5-flash          |
| 🌑 PHANTOM-4    | openai/gpt-4o                    |
| 💀 PHANTOM-FAST | meta-llama/llama-3.1-8b-instruct |

### ULTRAPLINIAN

Powered by `@nexus/gauntlet`. Select a tier, send a query — all models in that tier race in parallel waves (12 models/wave, 150ms stagger). Results are scored 0–100 on substance, directness, and relevance. Winner displayed prominently; full ranked table collapsible below.

| Tier        | Approx models |
| ----------- | ------------- |
| ⚡ FAST     | ~12           |
| 🎯 STANDARD | ~24           |
| 🧠 SMART    | ~35           |
| ⚔️ POWER    | ~45           |
| 🔱 ULTRA    | ~51           |

### PARSELTONGUE

Powered by `@nexus/redteam`. Input perturbation for red-teaming research:

- Live preview of perturbed output as you type
- 6 techniques: LEET, UNICODE, ZWJ, MIXCASE, PHONETIC, RANDOM
- 3 intensities: LIGHT / MEDIUM / HEAVY
- Custom trigger list (comma-separated)
- Sends perturbed text through the Nexus gateway

## Themes

Themes are applied via CSS variables and persisted to `localStorage` (key: `spectre_theme`):

| Theme | Aesthetic                                        |
| ----- | ------------------------------------------------ |
| VOID  | Deep green terminal — `#080808` bg, `#00ff88` fg |
| EMBER | Red/orange hacker — `#0a0605` bg, `#ff6600` fg   |
| NEON  | Purple glyph — `#07000f` bg, `#bf80ff` fg        |
| GHOST | Minimal light — `#f5f5f5` bg, `#1a1a2e` fg       |

## Easter egg

Type the Konami code (`↑↑↓↓←→←→BA`) at any time. A full-screen ASCII skull with flicker animation will appear. Click to dismiss.

## Architecture

```
apps/spectre/src/
  App.tsx              ← shell, theme, mode routing, Konami listener
  theme.ts             ← CSS variable sets + localStorage persistence
  lib/
    nexus.ts           ← NexusClient singleton (reads VITE_API_URL + VITE_API_KEY)
    storage.ts         ← localStorage chat history helpers
  components/
    Header.tsx         ← ASCII SPECTRE banner
    ModeSelector.tsx   ← CHAT / PHANTOM / ULTRAPLINIAN / PARSELTONGUE tabs
    ThemeSwitcher.tsx  ← VOID / EMBER / NEON / GHOST buttons
    MessageBubble.tsx  ← Chat message renderer
    ChatInput.tsx      ← Textarea + send button
  pages/
    Chat.tsx           ← Session sidebar + multi-model chat
    Phantom.tsx        ← 5-combo parallel race
    Ultraplinian.tsx   ← Tier race + results table
    Parseltongue.tsx   ← Perturbation UI
```

SPECTRE calls the Nexus API via `@nexus/client`. `@nexus/redteam` is imported directly (pure TypeScript, no API call) for the live perturbation preview.

## Deployment

SPECTRE is a static SPA. The `Dockerfile` produces an nginx image:

```bash
docker build -t nexus-spectre -f apps/spectre/Dockerfile .
docker run -p 5174:80 \
  -e VITE_API_URL=https://your-nexus-api.com \
  -e VITE_API_KEY=your-api-key \
  nexus-spectre
```

For cloud deployment, SPECTRE is included in `render.yaml` as `nexus-spectre` (web service, auto-deploy).
