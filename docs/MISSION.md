# NEXUS — Mission & Gap Ledger

_Resume file. Read this first. Last updated 2026-09-07._

The mission has four pillars. Much of it is already implemented; the gaps below
are what remain. Evidence-backed status per pillar, then a phased plan.

---

## Pillar 1 — Real agent runtime (not fake "agentic")

> Skills must actually execute work end-to-end. Avoid fake "agentic" behavior
> where skills are merely prompts/MCP/tool wrappers. The harness should plan,
> act, inspect results, recover from failures, and continue.

**Status: ✅ core built, ⚠️ skill-execution wiring unproven**

- `@nexus/agent-runtime` — self-loop harness: think → act → spawn → review →
  improve → done, with `RuntimeToolSet` (filesystem read/list/glob/grep,
  edit_file, run_command sandbox-bound, spawn_agent_inline, think_deeply,
  review, best_of_n). Mirrors the CodebuffAI/freebuff self-loop + harness tool.
- `@nexus/agent-engine` — `MissionRunner` (long-horizon runs, reviewer agent
  decides acceptance, phases persisted to KV via `apps/api/src/lib/mission-store.ts`).
- `apps/api/src/routes/missions.ts` — Missions API wired to the runner.
- **Gap:** skills have `code`/`language` fields but are NOT proven to be loaded
  and executed as tool-bearing capabilities inside the runtime. Verify or build
  the skills → runtime execution path (skill as executable unit with tools,
  not just text injected into a prompt). Also add failure → recover → continue
  loops (the runner does review; add explicit retry/repair on tool failure).

## Pillar 2 — Dynamic skill system + skill compression

> Skills are modular. Allow multiple skills to be merged/compressed into a
> task-specific composite skill (e.g. one temporary "frontend" composite
> instead of 8 separate skills). Optimize for context-token reduction, not
> merely filesystem organization.

**Status: ✅ merge exists, ⚠️ context-token optimization missing**

- `POST /api/skills/merge` (`apps/api/src/routes/skills.ts` +
  `apps/api/src/lib/skill-merge.ts`) — deterministic structural merge (dedupe
  imports, section per source) with optional LLM `polish` pass, bounded
  timeout, fallback to deterministic result. Zero-token by default.
- Full merge UI in `apps/ui/app/routes/skills.tsx` (select N skills, name,
  polish toggle, delete-originals toggle).
- **Gap:** merging is a stored-record operation (filesystem organization). The
  mission wants a *runtime* composite: at context-build time, load N relevant
  skills → emit ONE compressed composite skill containing only the capabilities
  needed for the task, to cut context tokens. Needs a skill selector/compressor
  wired into the context builder (`@nexus/context-builder` /
  `@nexus/context-assembly` / `@nexus/context-pack`), plus token accounting
  (before/after, using `estimateTokens`).

## Pillar 3 — Persistent memory + token efficiency

> OmniRoute-style routing/compression as a foundation (RTK/Caveman token
> compression). Real caching at multiple levels. Persistent session/project
> memory. Store useful execution state as structured memory/graphs — captured
> automatically from the runtime, zero manual write cost.

**Status: ✅ strong base, ⚠️ gaps on capture breadth + RTK/Caveman**

- Session spider-graphs: `apps/api/src/lib/session-graph.ts` + routes
  (`/api/session-graph`, `/api/session-graph/:id`) — zero-write-cost capture,
  currently wired from `research.ts` and `threads.ts`.
- Compression: `@nexus/llm-compress` (lossless ANSI/blank-line/dup-fold +
  TOON structured encoding, lossy head/tail opt-in), `prompt-cache`,
  `llm-cache`, `execution-cache`, `context-pruner`, `context-codec`,
  `mcp-compressor`.
- Caching: multi-level already present (KV-backed prompt cache, LLM cache,
  execution cache, semantic cache w/ Ollama embeddings).
- **Gaps:**
  1. Session-graph capture is not yet wired to **agent/mission executions**
     (the self-loop run transcripts) — the mission wants the thinking pipeline
     stored automatically with zero write cost. Add capture sites in the
     runtime (tool calls, spawns, reviews, iterations) + project-scoped graphs.
  2. RTK/Caveman-style token compression (OmniRoute) is not ported; `llm-compress`
     covers noise-stripping but not word-level/token-level lossy compression.
     Port or reimplement the RTK/Caveman approach into `@nexus/llm-compress`
     as an opt-in lossy stage.
  3. Cheap automatic extraction model ("reasoning-free" small model, e.g.
     `llama3.2:1b` on local Ollama) for turning execution events into memory —
     not yet configured/wired.

## Pillar 4 — Provider/model infrastructure (OpenCode reference)

> Use OpenCode as architectural reference: provider abstraction, model
> discovery, routing, fallback, credentials/configuration, per-model
> capabilities.

**Status: ✅ mostly built, ⚠️ discovery/capabilities depth**

- `@nexus/provider-registry` (provider list + key mgmt), `@nexus/llm-router`
  (routing/fallback), `@nexus/llm-drivers` (Ollama/groq/claude/etc),
  `@nexus/llm-accounts`, `llm-oauth`, `token-budget`, `run-cost`.
- **Gaps:** per-model *capabilities* metadata (context window, max output,
  tool-calling, vision, reasoning tier) and model *discovery* (list + probe +
  health) at OpenCode depth; route skills/agents onto models by capability.
  `apps/api/src/routes/llm.ts` + provider-registry is the home for this.

---

## Phase plan (in priority order)

1. **P1 — Skills execute end-to-end.** ✅ **DONE (2026-09-07)** — see below.
2. **P1 — Runtime composite skills.** ✅ **DONE (2026-09-07)** — see below.
3. **P2 — Execution memory capture.** ✅ **DONE (2026-09-07)** — see below.
4. **P2 — RTK/Caveman compression.** ✅ **DONE (2026-09-07)** — see below.
5. **P3 — OpenCode-depth provider layer.** ✅ **DONE (2026-09-07)** — see below.
   Remaining (future): per-model capability ROUTING (agents auto-selected onto
   models by capability) and the cheap extraction-model wiring (`llama3.2:1b`).

---

## Phase 1 close-out — skills execute end-to-end (2026-09-07)

**What shipped** (see `git diff`; all typechecks + 107 tests green):

- `apps/api/src/lib/skill-runner.ts` (new) — the skills → runtime bridge:
  - `executeSkillsOnce()` — **deterministic harness-side pre-execution**: every
    attached skill's code is run ONCE in the sandbox before the acting loop, so
    the work happens even if the model never emits a tool call (the
    anti-fake-agentic guarantee). Failures are returned, not thrown, and become
    the acting agent's recovery task.
  - `makeRunSkillCodeTool()` — `run_skill_code` runtime tool (re-run/fix loop,
    `{{param}}` substitution, compressed output via `compressForTool`).
  - `composeSkillSystemPrompt()` — acting prompt built from skill records with
    real pre-execution results embedded; instructs plan → run → inspect →
    recover → verify.
- `apps/api/src/routes/missions.ts` — `POST /api/missions` accepts `skillIds`
  (validated, deduped, max 20; unknown ids → 400); skills become executable
  units in the run; op log line per pre-execution.
- `packages/agent-engine/src/mission.ts` — `MissionRecord.skills` refs persisted
  (provenance: which skills actually ran).
- `apps/ui/app/routes/skills.tsx` — **Run** button per skill card + live mission
  modal (poll `GET /api/missions/:id`, phase timeline, review score, token
  usage, final output).
- `packages/sandbox` — **Windows bugfix**: python code now piped via stdin
  (`python3 -`) instead of `-c` argv. The Windows python3.exe app-execution
  alias mangles `-c` args (`\n` → real newline, embedded quotes break), which
  silently corrupted any script with escapes inside string literals.
- Tests: `apps/api/tests/lib/skill-runner.test.ts` (18), mission (14), sandbox (75).

**Verified E2E (local, qwen2.5:7b + Ollama):** skill `report-writer-v2`'s code
actually executed via pre-execution (`report-writer-v2=ok`), wrote
`skill-e2e-report.md` with the proof text; harness loop ran pre-execute → act →
review → improve → completed; skills refs + token usage (3,987) persisted.

**Honest limitation (model quality, not harness):** qwen2.5:7b produces prose
reports and fabricated verification claims; the reviewer rejects them (score 0,
unparseable JSON → honest reject). The loop's integrity is proven — lies don't
pass — but acceptance on a 7B local model requires a stronger model (configure
GROQ/Anthropic for real acceptance runs).

---

## Phase 2 close-out — composite skills + execution memory + compression (2026-09-07)

**P1b — Task-aware composite compression** (`apps/api/src/lib/skill-compress.ts`):
- `compressSkillsForTask()` — deterministic capability-slimming: scores each
  skill against the task (name ×2 / description / code head), keeps only
  relevant sections, dedupes imports, never returns an empty composite
  (fallback documented in the report).
- `POST /api/skills/compress {ids, task, polish?, save?}` — returns the
  composite + before/after token report (kept/dropped skills, saved ratio);
  `save` persists it, default is TEMPORARY (context-build semantics).
- UI: **Compress for Task** button (shares the merge selection) → dialog with
  task input, polish/save toggles, token cards (before → after → saved %),
  kept/dropped badges, code preview.
- Runtime token win: `mergeSkillCodeBodies(skills, execResults)` now stubs
  executed-OK skill bodies to a one-liner (full source stays one
  `run_skill_code` call away) — failed skills keep full bodies for recovery.

**P2a — Execution memory (zero write cost)** (`apps/api/src/lib/mission-graph.ts`):
- `MissionGraphRecorder` wraps every mission tool + every phase transition;
  session-graph kinds extended with `mission` / `tool` (UI graph viewer
  updated: colors, labels, layering).
- Verified live: mission → 5-node graph (started → acting → reviewing →
  improving → completed), tool calls would add call→result node pairs.
- Same fire-and-forget KV append as research/threads — no LLM call, no model
  cooperation, no summarization: the pipeline's execution IS the memory.

**P2b — RTK/Caveman compression** (`packages/llm-compress/src/caveman.ts`):
- OmniRoute *Standard* mode port: filler/phrase condensation (30+ rules),
  protected spans (code blocks, inline code, URLs, paths, JSON) masked before
  rules run, minimum-savings gate (refuses pointless lossy rewrites).
- `PRESETS.caveman` + `makeCavemanFilter()`; output-style injectors
  `ponytail` + `caveman-output` (OmniRoute output-styles parity) added to
  `INJECTORS`; missions accept `outputStyle: normal|terse|ponytail|caveman`
  (`withOutputStyle`), UI Run dialog gets a caveman-ponytail toggle.

## Phase 3 close-out — provider capabilities + discovery (2026-09-07)

- `apps/api/src/lib/model-discovery.ts` — per-model capabilities
  (contextWindow, maxOutput, vision, toolUse, streaming, reasoningTier,
  knowledgeCutoff, costs) from three honest sources: live Ollama probe
  (`/api/tags`, 2s bound), curated catalog (~20 hosted models), declared
  providers with empty-but-honest model lists.
- `GET /api/v1/llm/models` — verified live: 7 providers / 17 models, Ollama
  entries tagged `src=probe` and uninstalled catalog ids dropped.

## Semantic compression + composite-in-mission (2026-09-07, second pass)

- **Semantic selection** (`apps/api/src/lib/skill-embed.ts` + `skill-compress.ts`):
  relevance is now embeddings-based — task + skills embedded via the local
  Ollama `nomic-embed-text` (3s bound, never throws; keyword path is the
  fallback and `report.matchSource` says which ran). Scores are the MAX of an
  absolute hybrid (keyword hits anchor >= 0.35, exact-term matches never
  drop) and a relative min-max view (keyword-presence-dependent floor 0.27 /
  0.15) — calibrated live on nomic's tight similarity band.
  Verified live: "store unique identifiers for rows" over 5 skills kept
  [UUID Gen, CSV Reader] and dropped [JSON Writer, Rate Limiter, Env Loader];
  the keyword path would have kept all 5 (zero word overlap).
- **Composite-in-mission** (`routes/missions.ts`): `POST /api/missions` now
  accepts `compress: { ids, task }` — the mission builds ONE temporary
  composite (never saved), attaches it as a single executable unit, and
  pre-executes it like any skill. Verified live end-to-end through the UI:
  compress dialog -> "Run as Mission" -> mission runs with the composite
  badge, live polling, pre-execution logged ok.
- **Language-valid markers** (live-found bug): composite/merge headers used
  C-style `//` comments in Python output (`SyntaxError: invalid character
  '\u2014'`). New shared `commentPrefix()` in skill-merge.ts drives `#` vs
  `//` by the composite's picked language; unit-pinned for both.
- 307 API tests green (was 304 + 3 new: embed, semantic selection incl. the
  live-found min-cosine regression, language markers); API + UI typechecks
  clean.

## Mission memory — continue from the diff, not from blank (2026-09-07, third pass)

- **The READ side of zero-write-cost memory** (`apps/api/src/lib/mission-memory.ts`):
  the spider-graphs captured every run, but nothing ever READ them — each
  mission started blank and re-did work the previous run already did (the
  constant qwen rejection loop re-plans from scratch every time).
  `distillMissionMemory(record, graph)` turns the captured record + graph
  into ONE bounded (~1.6k char) prompt block: outcome verdict, review issues
  + suggestions, the last 4 tool calls with FAILED/ok outcomes, and the final
  output excerpt. Deterministic, honest, zero write cost — the model never
  writes this memory; it only reads what the runtime captured.
- **`POST /api/missions` accepts `continueFrom: <missionId>`** — validated
  (per-user, terminal-only; unknown/running → 400 `unknown_or_running_mission`),
  distilled into the acting prompt, and persisted on the new record as
  `memoryFrom: { missionId, outcome }` for provenance.
- **UI**: terminal MissionProgress shows "Continue with Memory" — one click
  re-runs the same goal + attachments with the prior run's memory attached;
  the header shows a "continuing from <id> — REJECTED review reject 0/100"
  badge.
- Verified live: rejected run → continuation started with `memoryFrom` on the
  record and the 1,016-char distilled block logged at mission start; the
  ownership gate rejects unknown ids.
- **Live-found fix — the runner owns the stored record**: patching
  `memoryFrom` onto the record after `createMission` was silently lost because
  `MissionRunner.run()` rebuilds the record from scratch and its first phase
  save overwrites the store. `memoryFrom` now flows through the runner options
  (same path as `skills`) and survives to a completed record — verified live.
  Also hardened the UI against a bare record (`usage?.totalTokens ?? 0`) after
  a transient crash during a mid-run backend restart.
- 317 API tests green (10 new: distill content/bounds, tool-trace marking,
  loader gates); API + UI typechecks clean.

## Wire-up + enterprise notes (2026-09-07)

- All suites green: 338 tests across llm-compress / sandbox / agent-engine /
  skill-runner / skill-compress / mission-graph / model-discovery; API + UI
  typechecks clean.
- Windows sandbox fix (python via stdin) is load-bearing for skill execution
  on this machine — see Phase 1 close-out.
- Everything is uncommitted on `main` (work-in-progress tree); commit when
  the user confirms.

## How to resume the running system

```bash
# Ollama (qwen2.5:7b, nomic-embed-text, llama3.2:3b)
nohup ollama serve > /tmp/ollama.log 2>&1 & disown
# API (:3000) — loads .env
cd PROJECTS/Nexus && nohup bash scripts/dev-local.sh api > /tmp/napi.log 2>&1 & disown
# UI (:5173) — optional
nohup bash scripts/dev-local.sh ui > /tmp/nui.log 2>&1 & disown
```
Token: login `audit@nexus.local` / `LocalDev12345!` → `accessToken` (expires 15 min).
Packages consumed as dist: rebuild with `pnpm --filter <pkg> build` after edits.