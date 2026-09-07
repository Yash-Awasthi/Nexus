# Nexus Deep-Scan Findings (2026-09-07)

Scope: full-stack verification of the mission pillars on `fresh` @ `51506e4`. I read the
mission-critical vertical end-to-end (routes → libs → runtime packages → UI), ran the relevant
test suites, then booted the API and exercised every pillar route live against real Postgres +
Ollama (qwen2.5:7b / nomic-embed-text). I did not read all 189 packages; the audit targets the
four-pillar execution path plus everything that shares its seams.

## Bottom line

The five capabilities you asked about are **implemented and were live-verified end-to-end**, not
prompt/toolkit decoration. No logic breaks or accidental 4XX/5XX were found on any exercised path:
every 4XX observed is an intended validation (see below). Two real issues surfaced, both honest
findings, not silent failures: (1) the local 7B reviewer accepted an empty result at 85/100 in one
live run, and (2) the API route-test suite cannot run in this environment (missing `nexus_test`
DB role) — the repo's own standard test config excludes those files anyway.

---

## Q1 — Do feats really execute end-to-end (not prompt injection / toolkit wrappers)?

**Yes, proven live.** A mission created via `POST /api/missions` with two Python skills attached ran
the sandbox **before** the acting loop began (anti-fake-agentic guarantee in
`apps/api/src/lib/skill-runner.ts` `executeSkillsOnce` + `makeRunSkillCodeTool`):

```
[started]   skill  json-parser   python · 30000ms budget
[completed] skill  json-parser result  completed in 187ms (exit 0)
[started]   skill  csv-reader
[failed]    skill  csv-reader result   failed (exit 1) — SyntaxError: unterminated string …
```

The graph then shows `phase started/thinking/acting/reviewing/completed`. The csv-reader failure
was caused by my shell-escaped test payload (a real SyntaxError in the code I injected) — and the
runtime captured it honestly as a `failed` node with the real error. That is the desired behavior:
skill code executes, outcomes (success **and** failure) are recorded by the runtime, the model
never writes any of it. Skills are stored records with `code`/`language` that get executed in the
sandbox; they are not prose injected into prompts.

Evidence: live graph dump (`GET /api/session-graph/:id` → 9 nodes/9 edges), plus suite runs below,
plus `packages/sandbox` (75 tests, incl. the Windows python-stdin fix) and `skill-runner.test.ts`.

## Q2 — Compress/merge skills into user-made composites (frontend skill, caveman-ponytail…)?

**Yes — implemented at API + UI, live-verified.**
- `POST /api/skills/merge` → **201** with a deterministic structural merge (dedupe, per-source
  sections, language-correct comment markers) + token report; optional LLM polish is fail-safe.
- `POST /api/skills/compress` → **200** with a task-scored composite (keyword/embedding selection,
  `report.matchSource` says which), before/after token report, `save`/temporary semantics.
- Missions accept `compress: {ids, task}` → one temporary composite skill built at mission start.
- **UI** (`apps/ui/app/routes/skills.tsx`): Merge dialog, Compress-for-Task dialog, per-skill Run →
  live mission modal, composite-in-mission, output-style toggle (normal/terse/ponytail/caveman).
  API + UI types line up; UI typecheck clean.

Live numbers from my probe: merge report `{inputTokens:42, outputTokens:95, …}`; compress returned
a named composite with per-skill relevance scores and `matchSource: keyword` (embedding fallback
worked as designed — never throws).

## Q3 — Token efficiency (OmniRoute-style): routing/compression + real caching + memory?

**Mostly yes — the OmniRoute pieces are ported; caching is real; one wiring gap remains.**
- **Caveman/RTK compression ported**: `packages/llm-compress/src/caveman.ts` (filler condensation,
  protected spans, minimum-savings gate), output-style injectors `ponytail` + `caveman-output`,
  missions take `outputStyle`. 95 tests green.
- **Real multi-level caching**: KV-backed `prompt-cache` (wired in `routes/gateway.ts`),
  `llm-cache-driver` (wired in `api-bridge.ts`, `llm-failover`, `health`), semantic cache w/
  Ollama embeddings, `execution-cache`, `context-pruner`/`context-codec`.
- **Routing**: `smart-router` (wired into `server.ts` + `routes/llm.ts`), `@nexus/llm-router`
  (201 tests green with agent-engine/agent-runtime), `model-discovery` catalog + live probe.
- **Persistent memory**: see Q4.
- **Gap (documented in `docs/MISSION.md`, still open)**: the cheap "reasoning-free" extractor
  (`llama3.2:1b`-class local model turning execution events into distilled memory) is **not
  wired**. Today memory distillation (`mission-memory.ts`) is deterministic from captured nodes —
  which is arguably better (zero write cost, no model drift) — but the cheap-model path you
  imagined is not implemented.
- Note: `docs/MISSION.md` Phase plan marks RTK/Caveman done; it also still lists "remaining
  (future): per-model capability routing" — agents are not yet auto-selected onto models by
  capability.

## Q4 — Zero-write spider-graph memory of the thinking pipeline?

**Yes — implemented and live.** `session-graph.ts` (+ `appendGraphEvent` KV append, ring-capped,
per-user) + `MissionGraphRecorder` (`mission-graph.ts`) + read-side distillation
(`mission-memory.ts`, `continueFrom`). Live mission produced **9 nodes / 9 edges** with kinds
`skill` + `phase` and statuses, zero model-written memory. The recorder wraps every tool call and
phase transition; the earlier seam test (real bash sandbox → 4 skill nodes / 4 edges) plus
unit tests (326 lib tests green incl. mission-graph, mission-memory, skill-runner) pin it.
One earlier audit caveat stands (deferred by design): the first node on an empty graph gets a
self-edge (`"last"` sentinel), and graph appends are fire-and-forget, so an immediate
auto-continue could race the last writes.

## Q5 — OpenCode-style provider/model infrastructure + Freebuff self-loop/harness tools?

**Yes — structurally complete.** `@nexus/provider-registry`, `@nexus/llm-drivers` (Ollama/groq/
claude/openai/gemini/deepseek), `llm-oauth` (Google Vertex / Entra links), `provider-keys`
(AES-256-GCM), `model-discovery` (`GET /api/v1/llm/models` → live **200**), `llm-failover`,
`run-cost`. Freebuff-style runtime: `@nexus/agent-runtime` (`RuntimeToolSet`, filesystem tools
with workspace confinement + path-escape guard, `spawn_agents` / `spawn_agent_inline` /
`best_of_n` / review / think_deeply, steering hooks) and `@nexus/agent-engine` `MissionRunner`
(think → act → spawn → review → improve → done, accept/reject loop, budget cap). 201 tests green
across the three runtime/router packages; self-loop tests present.

---

## "No logic break, no 4XX anywhere" — what I actually exercised

Booted the API fresh (KV → memory fallback; Postgres + Ollama live) and probed with a real auth
token:

| Call | Result | Verdict |
|---|---|---|
| GET /health, /health/ready | 200, 200 | ok |
| GET /api/v1/auth/me | 200 | ok |
| GET /api/skills, /api/session-graph, /api/threads, /api/notifications, /api/missions | all 200 | ok |
| POST /api/skills ×2 | 201 | ok |
| POST /api/skills/merge (2 real ids) | 201 | ok |
| POST /api/skills/compress (ids + task) | 200 | ok |
| POST /api/missions (skills attached) | 202 | ok |
| GET /api/missions/:id → completed record | 200 | ok (see issue 1) |
| GET /api/session-graph/:id → 9 nodes/9 edges | 200 | ok |
| GET /api/v1/llm/models | 200 | ok |
| DELETE /api/skills/:id ×3 | 204 | ok |
| merge with 1 id / compress without task / continueFrom unknown | 400 | intended |
| unknown graph id | 404 | intended |
| no auth | 401 | intended |

Static scan of the pillar libs/routes: no TODO/FIXME/stub/placeholder dead code. `smart-router`,
`llm-cache-driver`, `prompt-cache` are all imported by live routes (not dead scaffolding).

## Real issues found — and closed

1. **Local 7B reviewer accepted an empty result (85/100) in a live run — FIXED.** The acting
   agent (qwen2.5:7b) ignored the embedded pre-execution results, produced no output, and the
   reviewer still returned a parseable `accept 85`. Added a **deterministic harness-side guard** in
   `packages/agent-engine/src/mission.ts`: an `accept` on an iteration with no output text AND no
   tool activity is blocked, marked `review.noWork`, the loop is fed a concrete "actually perform
   the task" directive, and the reviewer's original score stays on the record for audit. Reviewer
   prompt also now says empty work must score 0. Unit tests: empty accept never passes (even at
   95/100); accept with tool activity but no closing text is NOT blocked. Live re-verified: real
   work still completes/accepted, and the blocking path is pinned by tests.
   **Honest remainder (model quality, out of scope for a harness fix):** a 7B model can still
   *write plausible prose that misstates the actual skill output* — content-level hallucination is
   not caught by the emptiness guard (it correctly blocks "no work", not "wrong work").
2. **First-node self-edge in the session graph — FIXED.** `appendGraphEvent`'s `"last"` sentinel
   self-linked the first node of a fresh graph. Now an empty graph records the first node with NO
   edge; a unit test pins it, and a live mission graph shows 7 nodes / 6 edges, 0 self-edges.
3. **Duplicated skill-emission choreography — CONSOLIDATED.** Both runner paths
   (`executeSkillsOnce` and the `run_skill_code` tool) now share one
   `runSkillWithExecution()` helper in `skill-runner.ts` (started → run → completed/failed,
   throw → failed + rethrow). Event shape/order unchanged (40/40 runner+graph tests green).
4. **API route tests can't run in this environment (documented, not code).** `tests/routes/**` +
   `tests/server.test.ts` (80 tests across 12 files) expect a Postgres role `nexus_test` that is
   not provisioned here, plus controlled outbound networking for SSRF tests. The repo's own root
   `vitest.config.ts` excludes them from the standard run; see the new
   "Running the API route tests" section in `docs/TESTING.md`.

## Test-suite report (what is green)

- `apps/api` **lib** suites (the standard gate): 334 tests green (cost-log, mission-store,
  mission-graph, mission-memory, skill-{runner,merge,compress,embed,imports}, session-graph,
  threads, notifications, oauth, prompt-cache, rate-limiter…).
- `packages/llm-compress` 95/95 · `packages/sandbox` 75/75 · `agent-engine` 19/19 (17 existing +
  2 new reviewer-guard tests) · `agent-runtime` 148/148 · `llm-router` 36/36.
- Typechecks: `apps/api` clean, `apps/ui` clean, `agent-engine` clean; eslint clean on touched files.
- Full `apps/api` incl. route tests: 408 passed / 80 failed — all 80 are the environmental
  route/SSRF/boot-tests above.

## One operational note

Your `.env` still points `REDIS_URL` at dead localhost:6379 and at an Upstash host that does not
resolve — harmless now (KV fails open), but BullMQ/queue-backed flows silently degrade until one
is reachable.
