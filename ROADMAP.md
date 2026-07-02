<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Roadmap

Forward-only execution spec, written for a **low-effort inline executor**: every item names its
exact files, the symbols to touch, an existing pattern to mirror, the exact test command, and a
mechanical Done check. No "decide A or B" is left open; open decisions are resolved below or
listed under **Blocked** / **Not scheduled**. Facts (paths, symbols, shipped state) are verified
against source + git as of **2026-07-02** — **do not re-audit the codebase to confirm them; act
on them.** Read the git log only if an item looks already-done.

> **Nexus is free/open** — no paid tier, no payment provider. "billing"/"quota" below = BYOK
> spend-guards on the user's own keys, never charging for Nexus. SaaS/Stripe items are struck.

---

## Execution protocol (read once, then follow)

**How to work**

- **Inline only. No workflows, no subagents, no parallel fan-out.** Do every item yourself with
  Read / Edit / Bash in the main loop. (Subagent bursts trip the 5-hour spend cap and stall.)
- **One item per commit.** Scope to a single package: `pnpm --filter @nexus/<pkg> typecheck` and
  the item's **Test** command. Never whole-repo unless the item is explicitly cross-cutting.
- Follow **Order of work** below, top-to-bottom; skip a `Blocked`/`Gate` item until its
  precondition is met and move on.
- Build against mocks (`MockTransport`, injectable `TokenHttp`/`fetchFn`). **Any live outbound
  call (provider key, OAuth token exchange, MCP `/test`, live feed probe) is `Gate` — do not run
  it without explicit user go.**
- Before editing a file, read only the region around the named anchor symbols — the anchors in
  each item are current; don't re-read whole 2000-line files to rediscover them.

**Checkpoint = commit** (auto-commit is pre-approved for roadmap items)

1. Item's package `typecheck` + its Test command green → commit immediately.
2. Conventional Commit, scoped, reference the section:
   `feat(api): wire AccountPool into gateway dispatch (§4.1)`.
3. Author = `Yash-Awasthi <yashawasthi12032006@gmail.com>` (author = committer). **No
   `Co-Authored-By` trailer** — add it
   (`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`) **only** for CI
   fixes / error corrections.
4. **Branch off `main`. Never push. Never open a PR.**
5. Stage explicit paths — **never `git add -A`**. **Never stage** `.claude/settings.json` or
   `.directory`.
6. After committing, update PROGRESS.md (format below), then start the next item.

**Build/test rules (save yourself the retries)**

- `pnpm --filter @nexus/<pkg> test` may print "No test files found" — run
  `pnpm exec vitest run packages/<pkg>/tests/<file>.test.ts` from the **repo root** instead.
  Package tests live at `packages/<pkg>/tests/<pkg>.test.ts` (some packages have extra files,
  e.g. billing has `cost.test.ts`, `quota-cost.test.ts`; agent-runtime has `ptc.test.ts`).
- `apps/api` route tests are excluded from the root include:
  `cd apps/api && pnpm exec vitest run tests/routes/<f>.test.ts` (or `pnpm --filter @nexus/api test`).
- `apps/api` + `apps/worker` consume built `dist`. After editing a package's `src`, run
  `pnpm --filter @nexus/<pkg> build` before the app typecheck sees it.
- `turbo` is not on PATH — always `pnpm --filter`.
- **Migrations**: `packages/db/migrations/`, **next free number `0013`** (a duplicate `0010`
  exists — `0010_mcp_servers.sql` + `0010_usage_token_breakdown.sql`; never reuse). Numbers are
  claimed in execution order: use the next free one when you get there. Recipe (mirror
  `0012_oauth_credentials.sql` + `packages/db/src/schema/oauth-credentials.ts`):
  1. Hand-write `packages/db/migrations/00NN_<name>.sql` — SPDX comment header, a
     `-- Migration 00NN: …` line, a `-- Run after 00NN-1_<prev>.sql` line, `CREATE TABLE IF NOT
     EXISTS` with quoted snake_case columns.
  2. Add `packages/db/src/schema/<name>.ts` — drizzle `pgTable` with doc comments.
  3. Append `export * from "./<name>.js";` to `packages/db/src/schema/index.ts`.
  4. **Append a journal entry** to `packages/db/migrations/meta/_journal.json`
     (`idx` = last+1, `version: "7"`, `tag` = filename minus `.sql`, `breakpoints: true`) —
     `pnpm db:migrate` = `drizzle-kit migrate` and it applies **only** journal-listed files.
  **Known gap (fix in the same commit as your first new migration):**
  `0010_usage_token_breakdown.sql` and `0012_oauth_credentials.sql` are missing from the
  journal today, so `db:migrate` silently skips them — append their entries too.
  `drizzle-schema.ts` is the stale drizzle-kit bundle — do not mirror it.
- **UI routes**: files in `apps/ui/app/routes/*.tsx`, registered in `apps/ui/app/routes.ts` via
  `route("path", "routes/file.tsx")` (keep them inside the same `layout(...)` block as their
  siblings). Data via client `fetch("/api/...")` — mirror `costs.tsx` for dashboards,
  `provider-keys.tsx` for CRUD pages.
- New env var → add to `.env.example` with a comment. SPDX `Apache-2.0` header on every new file
  (`pnpm check:headers`). Secrets/tokens never logged.

---

## PROGRESS.md format (the resume file this pairs with — gitignored, overwrite freely)

Keep PROGRESS.md to this shape; rewrite it on each checkpoint. Compact by design.

```markdown
# NEXUS — Progress (resume state; gitignored)
Branch: <feat/...> (off main; committed, never pushed)
Updated: <YYYY-MM-DD>

## Now
<the single item in progress + exactly where you stopped>

## Next (ordered item IDs from ROADMAP "Order of work")
1. <id> <title>
2. ...

## Shipped this session (newest first)
- <hash> <id> — <one line: what + key file>

## Blocked / needs user go
- <item id> — <what external action or decision is required>

## Gotchas (carry forward — only non-obvious ones)
- <build/test quirk that bit you>
```

---

## Order of work

Near-term, in priority order (then continue in section order):

1. **§4.1** wire `AccountPool` into dispatch — activates already-written pool + vault + routes.
2. **§8.1** Drive isolation spike (decision gate for all of §8).
3. **§5.1** usage-analytics UI (last piece of the metering loop).
4. **§9.1 → §9.2** extend pinned-fetch to remaining sinks, then clear CodeQL alerts.
5. Then §2 → §3 → rest of §4 → §6 → §7 → rest of §8 → rest of §9 → §10 → §11 → §12 → §13, with
   §14/§15 as long-horizon tracks.

Item legend: **Files** = touch these · **Mirror** = existing pattern to copy · **Do** = the
change, in order · **Test** = exact command · **Done** = acceptance check · **Gate** = needs
explicit user go (live call / external action).

---

## 1. LLM provider breadth

Baseline: `@nexus/llm-drivers` = ~48 native drivers in the single file
`packages/llm-drivers/src/index.ts` (~2.3k lines) + `nexus/omni` sidecar. Core seams:
`LlmDriver` → `BaseDriver` (`sseLines`/`ndjsonLines` stream helpers, `_useDefaultTransport`) →
`OpenAICompatibleDriver` (override `chatCompletionsUrl()` / `authHeaders()`); `HttpTransport`
(real) vs `MockTransport` with `setResponses([...])` (all tests). `DriverRegistry`,
`probeLocalModel`. **Already shipped on this branch — do not redo:** ERNIE tool-calling
(`BaiduErnieDriver`, commit `9f64238`) and the Bailian + Dify base drivers (commit `a4e278d`).
`provider-registry` has the models.dev importer
(`modelsDevToDefinitions`/`registerFromModelsDev`/`fetchModelsDev`).

- **1.2 Dify SSE + threading.**
  Files: `packages/llm-drivers/src/index.ts` (`DifyDriver` — currently blocking-only),
  `packages/llm-drivers/tests/llm-drivers.test.ts`.
  Mirror: any streaming driver in the same file that consumes `this.sseLines(...)`; tests use
  `MockTransport.setResponses([...])` with SSE-formatted bodies like the other streaming tests.
  Do: 1) when `stream: true`, send `response_mode: "streaming"` and parse Dify SSE events
  (`event: message` → text delta; `event: message_end` → usage + `conversation_id`); 2) surface
  `conversation_id` on the response and accept one on the request so a follow-up call threads
  the conversation; 3) add two tests: streamed chunks reassemble to the full text; a second call
  passes the returned `conversation_id` through to the wire request.
  Test: `pnpm exec vitest run packages/llm-drivers/tests/llm-drivers.test.ts`
  Done: both new tests green; blocking mode unchanged.

- **1.3 Aux provider gaps** (one provider = one commit; mirror the sibling adapter in each
  package, add a unit test per provider in that package's `tests/` file).
  - `packages/image-gen/src` — flux, stability, recraft, fal, comfyui (mirror
    `ReplicateProvider`/`OpenAIImageProvider`).
  - `packages/voice/src` — deepgram, cartesia, assemblyai (mirror the ElevenLabs synth + Groq
    transcribe adapters).
  - `packages/retrieval` / `packages/reranker` — voyage, jina, cohere embeddings (mirror the
    existing embedder interface; `reranker` already has BM25).
  - `packages/search-orchestrator/src` — exa, brave, serper (mirror the `SearxNG` strategy;
    Chroma/PgFullText/Hybrid also live there).
  Test: `pnpm exec vitest run packages/<pkg>/tests/<pkg>.test.ts` per package.
  Done: each new provider has a passing unit test against a mocked fetch/transport.

- **1.4 Custom-driver framework.**
  Files: `packages/llm-drivers/README.md` (new) + a template driver example in the README (or a
  compiled `examples/` file if trivial to add to tsconfig).
  Do: document the extension seams so a new driver needs no core edits —
  `OpenAICompatibleDriver` + `chatCompletionsUrl()`/`authHeaders()` overrides,
  `_useDefaultTransport`, registering in `DriverRegistry`, and the `MockTransport` test recipe.
  Done: README exists; the template compiles as a standalone driver (or is a checked, complete
  code block copied from a working one-liner subclass).

- **1.5 models.dev seed** *(fork resolved: DB-backed, no startup network)*.
  Files: next-free migration `packages/db/migrations/00NN_provider_models.sql` +
  `packages/db/src/schema/provider-models.ts` (+ index export) + `apps/cli/src/index.ts` +
  the registry boot path in `apps/api`.
  Mirror: migration recipe in Build/test rules; CLI subcommand style already in
  `apps/cli/src/index.ts` (commander.js).
  Do: 1) `provider_models` table (provider, model id, capabilities/limits/pricing columns per
  `ModelDefinition` in `packages/provider-registry/src/index.ts`); 2) CLI
  `nexus models seed [--file <path>]` → parse with `modelsDevToDefinitions`, upsert rows
  (`--file` mode needs no network; a live `fetchModelsDev` pull is **Gate**); 3) at API boot,
  load rows into the registry via `registerFromModelsDev`-shaped definitions instead of any
  network call.
  Test: `pnpm exec vitest run packages/provider-registry/tests/provider-registry.test.ts` + a
  CLI parse/upsert unit test with a small fixture JSON.
  Done: seed populates the table from a fixture file; boot reads the table; zero network at
  startup.

## 2. Format-translation matrix — `@nexus/llm-translate`

Baseline: canonical hub scaffolded in `packages/llm-translate/src/index.ts` (~300 lines):
`CanonicalRequest`, `normalize`/`denormalize`/`translate`, `Format = "openai" | "anthropic"`,
extension point = the `NORMALIZERS`/`DENORMALIZERS` maps. Request-only, **unwired**. Tests:
`packages/llm-translate/tests/llm-translate.test.ts`.

- **2.1 Add formats.** **Done this branch.** `Format` union now
  `openai | anthropic | gemini | vertex | responses | ollama`, each with a normalizer+
  denormalizer pair + a golden-shape test and an openai↔X round-trip test (36 tests, all green).
  `gemini` (commit `2a14c8a`), `vertex` (`5f73abc`, thin gemini wrapper — strips URL-bound
  `model`/`stream` from the body), `responses` (`3de2f48`, OpenAI Responses API: flat `input[]` +
  top-level `instructions`, `function_call`/`function_call_output` items, `max_output_tokens`),
  `ollama` (`8ee604f`, `/api/chat`: object-valued tool args, `tool_name` on results, sampling
  under `options.num_predict`/`options.temperature`).
  Do: extend the `Format` union and add a normalizer+denormalizer pair per format — `gemini`,
  `vertex` (same payload as gemini, different envelope/URL-bound model), `responses` (OpenAI
  Responses API), `ollama`. One format per commit is fine.
  Test: `pnpm exec vitest run packages/llm-translate/tests/llm-translate.test.ts`
  Done: golden-file test per format (same logical request → exact expected wire JSON).
- **2.2 Format-agnostic concerns.** **Done this branch (verification — no code change).** The
  translator is request-only; its one format-agnostic request concern is **tool-call mapping**,
  which the §2.1 golden files now cover across all six formats (assistant tool call + tool result
  round-trip openai↔{anthropic,gemini,vertex,responses,ollama}). The remaining listed concerns are
  response-side: **finish-reason** + **usage** already map in the gateway response path
  (`packages/gateway/src/index.ts` `mapStopReason`, usage passthrough) and are exercised there via
  §2.4; **thinking/reasoning** stream blocks land in §2.3; **modality/image blocks** are out of the
  current request-only canonical scope (`CanonicalMessage.content` is text) — deferred until a
  multimodal canonical block type is introduced (not needed for the text+tools path §2.4 wires).
  Do: tool-call mapping, thinking/reasoning, finish-reason,
  usage, modality, image blocks across all formats. Done: covered by the golden files.
- **2.3 Streaming.** **Done this branch (commit `ac3835b`).** Added a response-chunk streaming
  layer to `@nexus/llm-translate`: `CanonicalStreamEvent` (text / thinking / tool_call_start /
  tool_call_args / finish), `normalizeStreamChunk(chunk, from)` parsers for all six formats, and a
  stateful `StreamTranslator(from, to)` that emits to openai + anthropic (the pair the gateway
  transcodes; emit to a parse-only format throws). The Anthropic emitter brackets text/tool_use
  content blocks with start/stop frames and maps stop reasons. Golden tests assert the exact frame
  sequence for openai↔anthropic (text delta + tool-call partial + finish) plus flush + parse spokes
  (42 tests green). Callers own SSE line framing / `[DONE]` / `event:` names.
  Do: chunk translation (SSE deltas, tool-call partials, thinking blocks).
  Done: streaming golden test passes.
- **2.4 Wire into gateway.** **Done this branch (commit `7bb4f47`).** `@nexus/gateway`'s
  `toOpenAIRequest` now delegates to `translate(req, "anthropic", "openai")` (added
  `@nexus/llm-translate` as a workspace dep), overriding only the resolved model — so tool
  calls/results/multi-turn structure survive instead of being flattened away; the dead
  `flattenContent` helper was removed. Note: `apps/api/src/routes/gateway.ts` does NOT use this
  function — that route converts Anthropic→neutral `LlmRequestOptions` via `toDriverRequest` and
  lets each native driver format its own wire payload, so no translate() swap applies there. Built
  llm-translate + gateway; gateway pkg tests 38/38 green (incl. the 7 `toOpenAIRequest` golden
  assertions, unchanged); apps/api `gateway.test.ts`+`gateway-fuzz.test.ts` 25/25 green (lone
  vitest "error" = the pre-existing `nexus_test` PG-auth unhandled rejection, not a test failure).
  Files: `packages/gateway/src`, `apps/api/src/routes/gateway.ts`.
  Do: replace the bespoke Anthropic↔OpenAI translate with `translate()`. Build llm-translate +
  gateway before the api typecheck.
  Test: `cd apps/api && pnpm exec vitest run tests/routes/gateway.test.ts tests/routes/gateway-fuzz.test.ts`
  Done: existing gateway tests pass unchanged.

## 3. Token compression — `@nexus/llm-compress`

Baseline: `packages/llm-compress/src/index.ts` (~400 lines): TOON `encodeStructured`, lossless
filters (`stripAnsi`/`trimTrailing`/`collapseBlankLines`/`dedupConsecutive`), `smartTruncate`,
`compress`/`compressAuto`/`compressForTool`, `TOOL_PROFILES` router, `INJECTORS`. Wired into the
agent hot-path and the gateway proxy (opt-in `x-nexus-compress`).

- **3.1 Heavy lossy mode** *(fork resolved: opt-in, off by default)*. **DONE.**
  Files: `packages/llm-compress/src/index.ts` + `packages/llm-compress/package.json`.
  Do: 1) gate behind `NEXUS_LLMLINGUA=1` + lazy `import('@atjsh/llmlingua-2')`; 2) list it in
  `optionalDependencies` (not installed by default); 3) document the 57 MB–2.2 GB model download
  in a comment + `.env.example` entry; 4) unit-test the gated path with the import mocked
  (`vi.mock`), and that the default path never touches it.
  Test: `pnpm exec vitest run packages/llm-compress/tests/llm-compress.test.ts`
  Done: gated path tested with mocked import; default path untouched.
  Done-state: added `compressHeavy(input, opts)` — async, `NEXUS_LLMLINGUA=1` (or `opts.enabled`)
  gate; off → returns input unchanged with `enabled:false` and never imports the package/model.
  On → lazy `import('@atjsh/llmlingua-2')` (+ `js-tiktoken`) via non-literal specifiers (so `tsc`
  won't resolve the not-installed optional deps), `LLMLingua2.WithBERTMultilingual`/`WithXLMRoBERTa`
  factory → `promptCompressor.compress_prompt(text,{rate})`; injectable `loadCompressor` seam for
  tests. `optionalDependencies`: `@atjsh/llmlingua-2` + peers `@huggingface/transformers`,
  `@tensorflow/tfjs`, `js-tiktoken` (manifest-only; lockfile intentionally not regenerated — deps
  never installed by default). `.env.example` gained a compression section documenting the gate +
  57 MB–2.2 GB HF model download. 6 new tests (44 total): default-off passthrough + loader-never-
  called, non-"1" env stays off, opts.enabled + env-gate on with injected compressor, `vi.mock`ed
  real loader path, XLM-RoBERTa model-id selection. Drive-by: added the missing
  `eslint-disable no-control-regex` above `ANSI_DETECT` (pre-existing gap; lint-staged would trip
  on it once the file is touched). Package typecheck + build + 44/44 tests + eslint all green.

**§3.2–§3.8 — multi-engine rework** *(added 2026-07-02 after auditing `REF/OmniRoute`; plan file
`/home/yash/.claude/plans/wondrous-imagining-marshmallow.md`)*. The original Microsoft LLMLingua is
Python/PyTorch (needs a causal LM at inference) — not portable to pure-Node BYOK. OmniRoute itself
uses the JS port only as a low-priority optional engine; its real compression is a **pure-TS,
no-model, multi-engine pipeline** we're porting. All engines are additive (existing exports
untouched) and `compressHeavy`/§3.1 stays as the optional `llmlingua` engine. Text-level only;
the message-array context manager is out of scope (belongs to gateway/translate).

- **3.2 Engine core.** **DONE.** `CompressEngine`/`EngineContext`, `ENGINES` registry +
  `registerEngine`, `compressStacked`/`compressStackedAsync` (priority-sorted, fail-open per-engine
  bail-out on error/no-op/inflate/below-min-gain, global inflation guard, per-engine breakdown),
  `extractPreservedBlocks`/`restorePreservedBlocks` (tombstone code/URLs/paths/error lines with
  U+E000/E001 sentinels), `lite` engine (folds `DEFAULT_FILTERS`), `COMPRESSION_MODES` +
  `compressMode`. 13 new tests (57 total). typecheck+build+eslint green.
- **3.3 `ultra` engine.** **DONE.** Heuristic no-model token pruning: `scoreToken` (stopwords 0.1 /
  ≤2-char 0.2, digits/URLs/paths/errors force-kept 1.0, Capitalized 0.8, ≥6-char 0.7) +
  `pruneByScore` (keepRate default 0.5, whitespace-preserving, only drops words below minScore 0.3)
  inside preserved-block extraction. Lossy, opt-in, `ultraEngine` stackPriority 40. 9 new tests
  (66 total). Done: stopwords pruned first; code/URLs/numbers survive; keepRate honored.
- **3.4 `caveman` engine.** Rule-based prose reduction (English), ~30 rules over `lite`/`full`/
  `ultra` intensities (filler/pleasantries, purpose-phrases, verbose connectors, article-drop[full],
  ultra abbreviations), keyword pre-filter, preserved blocks, cleanup+recapitalize, revert-on-mangle.
  Lossy, opt-in, stackPriority 20. Done: filler removed; code/URLs untouched; intensity escalates.
- **3.5 `rtk` engine.** Command/tool-output line filter (drop/keep/collapse + consecutive-dedup +
  head/tail truncate to maxLines/maxChars) with bundled rulesets selected by `ctx.toolName`/content;
  complements `compressForTool`. stackPriority 10. Done: build errors kept; noise dropped; caps hold.
  *(Pause for review after §3.5 before the optional §3.6–§3.8.)*
- **3.6 `headroom` engine** *(optional)*. Detect embedded homogeneous JSON arrays (≥minRows) and
  columnarize via `encodeStructured`/TOON; replace only when strictly smaller; lossless. stackPriority 15.
- **3.7 `ccr` engine** *(optional, reversible)*. `node:crypto` SHA-256 (24-hex) principal-scoped
  bounded in-memory store; replace ≥minChars blocks with `[CCR retrieve …]`; `retrieveBlock()`.
- **3.8 Wire `llmlingua` engine.** Register `compressHeavy` as the async `llmlingua` engine
  (stackPriority 35, gated/optional) so stacked-async pipelines can include semantic pruning.

## 4. Provider OAuth + accounts — `@nexus/llm-oauth`, `@nexus/llm-accounts`

Baseline: framework + AES-256-GCM vault (`AesGcmVault`) + PKCE + dedup refresh
(`TokenRefresher`) + Google Vertex provider (`packages/llm-oauth/src/providers.ts`:
`GoogleVertexAuthProvider`, `DESCRIPTORS` — azure-openai/github-models stubs `supported:false`);
`oauth_credentials` (mig `0012`) + `OAuthTokenStore`/`SealedTokenStore` + drizzle adapter
(`apps/api/src/lib/oauth-token-store.ts`: `DrizzleSealedTokenStore`, `createOAuthTokenStore()` —
needs `NEXUS_OAUTH_VAULT_KEY`, else routes 503); `/llm-oauth/*` login/callback/revoke routes
(`apps/api/src/routes/llm-oauth.ts`, injectable deps, CSRF-state PendingAuth in KV, TTL 600 s);
`AccountPool` (`packages/llm-accounts/src/index.ts`: `pick(provider, opts)`,
`recordSuccess`/`recordFailure`/`recordUsage`, `health()`, tier-ladder sub→cheap→free +
cooldown + circuit-breaker + quota strategies, injectable `now`/`random`, zero network).
Sanctioned third-party OAuth only.

- **4.1 Wire `AccountPool` into dispatch.** **Shipped this branch (commit `211e41c`) — do not
  redo.**
  Files: `apps/api/src/routes/gateway.ts` (anchors: `buildDriverRegistry()`, `resolveAlias()`,
  the POST `/gateway/messages` dispatch), `apps/api/src/lib/oauth-token-store.ts`.
  Mirror: pool behavior is already fully unit-tested in
  `packages/llm-accounts/tests/llm-accounts.test.ts` — wire, don't reimplement.
  Do: 1) construct one `AccountPool` beside the driver registry, seeded from the same env/DB
  account sources; 2) in dispatch, `pool.pick(provider)` → if the account is OAuth-backed,
  `store.resolveFresh(userId, provider)` → `toDriverCredentials()` → driver (vertex first);
  3) call `recordSuccess`/`recordFailure` (+ `recordUsage` with token counts) around the driver
  call so cooldown/breaker engage; 4) unit-test with `MockTransport`: a failing account trips
  the breaker and the next pick skips it; OAuth creds resolve to the vertex driver.
  Test: `cd apps/api && pnpm exec vitest run tests/routes/gateway.test.ts`
  Done: dispatch picks a healthy account; cooldown/breaker exercised in a test; OAuth creds
  reach the vertex driver.

- **4.2 More OAuth providers.**
  Files: `packages/llm-oauth/src/providers.ts` (`DESCRIPTORS`).
  Do: add `azure-openai` / `github-models` **only** when a documented third-party auth path
  exists; else keep `supported:false` with a TODO reason.
  Test: `pnpm exec vitest run packages/llm-oauth/tests/llm-oauth.test.ts packages/llm-oauth/tests/store.test.ts`
  Done: catalog matches reality; nothing half-built.

- **4.3 OAuth live E2E** *(Gate)*.
  Do: unit coverage of `completeLogin`/`refresh`/`revoke` with mocked `TokenHttp` already lives
  in `packages/llm-oauth/tests/` — extend there if gaps. A live run needs the operator's
  registered OAuth app + redirect URI (external, one-time) — do not attempt without user go.
  Never log token-exchange bodies.

## 5. BYOK spend-guard & usage metering — `@nexus/billing`

Baseline: cost model (`packages/billing/src/cost.ts`: `computeCost`/`estimateMaxCost`/
`BillingLedger`) + `QuotaChecker` (`quota.ts`: `check`/`recordUsage`/`monthToDateCostUsd`) +
priced `usage_events` (mig `0010`) + `api_keys.monthly_cost_cap_usd` (`api-keys.ts`, `nxk_`
keys, SHA-256). Gateway path is metered (`_resolveBillingKey` → `check(estimateMaxCost)` →
`recordUsage`). API already serves `/billing/plan`, `/billing/current-period`, `/billing/keys`
(CRUD), `/billing/quota`, `/billing/usage/:tenantId` from `apps/api/src/routes/billing.ts`,
which already aggregates `usageEvents` with drizzle `sql` sums.

- **5.1 Usage-analytics UI.** **Shipped this branch (commit `3dbb33b`) — do not redo.**
  Files: `apps/api/src/routes/billing.ts` (extend), new `apps/ui/app/routes/usage.tsx`,
  `apps/ui/app/routes.ts` (register next to `route("costs", "routes/costs.tsx")`).
  Mirror: API — the `/billing/current-period` handler's `usageEvents` aggregate; UI — the
  `costs.tsx` pattern (513 lines: parallel client `fetch("/api/...")` + cards/tables).
  Do: 1) add `GET /billing/usage/by-model-day` — `usageEvents` grouped by model + day (tokens +
  cost), month-to-date, scoped to the caller; 2) `usage.tsx` renders month-to-date cost against
  `monthly_cost_cap_usd` (from `/billing/quota`) + the per-model/day split; 3) register the
  route.
  Test: `cd apps/api && pnpm exec vitest run tests/routes/` (billing tests) +
  `pnpm --filter @nexus/ui typecheck`
  Done: page shows the breakdown against the cap.

## 6. Multi-agent orchestration — `@nexus/agent-orchestrator`

Baseline: `packages/agent-orchestrator/src/index.ts` (167 lines): `orchestrate()` = worktree
fan-out → score (`scoreByConfidence`) → winner-merge, `GitWorktreeManager`; merge is OFF (the
handler forces `merge:false`). Worker handler:
`apps/worker/src/handlers/orchestration-handler.ts` (112 lines, `handleOrchestrationJob`,
runner = `handleAgentRunJob`, scorer = `handleCouncilJob`).

- **6.1 Persist state.**
  Files: next-free migration + `packages/db/src/schema/orchestration-runs.ts` (+ index export) +
  `apps/worker/src/handlers/orchestration-handler.ts`.
  Mirror: schema/migration recipe in Build/test rules (`agent-sessions.ts` is the closest table
  shape: id, status, jsonb payloads, timestamps).
  Do: 1) `orchestration_runs` (id, status, task, candidates jsonb, scores jsonb, winner,
  created/updated); 2) handler writes a row per stage transition through an injectable store
  (constructor/dep param — keep the handler unit-testable with a fake store); 3) on worker boot,
  re-enqueue non-terminal runs.
  Test: `pnpm exec vitest run packages/agent-orchestrator/tests/orchestrator.test.ts` + a
  handler test with a fake store simulating restart.
  Done: a run survives a simulated restart.

- **6.2 Compare/merge UI.** Files: new `apps/ui` route (register in `routes.ts`). Do: diff per
  candidate; manual or scored winner select; merge stays opt-in. Done: candidates diffed,
  winner selectable.
- **6.3 Checkpoint/resume + gate.** Do: durable checkpoints + evidence-first verification gate
  before merge. Done: resume-from-checkpoint test; merge blocked until the gate passes.

## 7. Coding-agent harness — `@nexus/agent-runtime`

Baseline: `packages/agent-runtime/src/index.ts` (~2.2k lines): tool-use loop + full
`RuntimeToolSet` bridges (fs/edit/run_command/mcp), `classifyTool`/`AUTO_ALLOWED_TOOLS`/
`ActionTier`, `PermissionGate`, `AgentRuntime`/`ToolAgentRuntime`; compaction pieces exist —
`DEFAULT_TOKEN_BUDGET=200_000`, `COMPACTION_THRESHOLD=0.8`, `RECENT_TURNS_TO_KEEP=10`,
`IMAGE_TOKEN_COST=1_600`, `compactMessages`, `estimateContextTokens`. `agent.run` job +
worker→API SSE relay (`agent-events.ts` → Redis → `agent-events-bridge.ts`/`sse.ts`) + PTC
Worker-thread sandbox (`ptc-sandbox.ts`) + `nexus code` CLI. `agent_sessions` table = mig
`0011`. Tests: `packages/agent-runtime/tests/{agent-runtime,fs-tools,mcp-tools,ptc}.test.ts`.

- **7.1 Sessions/permissions/compaction** — mostly **wiring, not writing**: the pieces exist.
  Files: `packages/agent-runtime/src/index.ts`, `apps/worker/src/handlers/agent-handler.ts`.
  Anchors: `PermissionGate` is a **callback type** already accepted as the `permissionGate?`
  option and consumed via `tierFor()` (`tool.tier ?? classifyTool`); `compactMessages` +
  `estimateContextTokens` are complete functions; `SessionStatus` is a union + factory
  (active/closed/crashed/reloaded/compacted/rateLimited/error); `agent-handler.ts` already
  reads/upserts `agentSessions.messages` (select + onConflict insert near the top of the file).
  Do: 1) supply a real `permissionGate` in the worker: read-only tools auto-allow
  (`AUTO_ALLOWED_TOOLS`), mutating tools route through `GovernanceEngine`
  (`packages/governance`) on the event bus; 2) call `compactMessages` in the run loop when
  `estimateContextTokens` crosses 80% of budget (hard stop @95%, keep last 10 turns, images
  ≈1.6k — constants exist); 3) persist/resume keyed by `SessionStatus` against the existing
  `agent_sessions` reads/writes.
  Test: `pnpm exec vitest run packages/agent-runtime/tests/agent-runtime.test.ts`
  Done: gate blocks an unapproved mutating tool; compactor trims at threshold; session resumes.

- **7.2 Full PTC wiring.**
  Files: `packages/agent-runtime/src/{ptc-sandbox,index}.ts`.
  Do: bridge the tool layer into the sandbox child over local RPC; only stdout returns to
  context.
  Test: `pnpm exec vitest run packages/agent-runtime/tests/ptc.test.ts`
  Done: a PTC script calls a tool via RPC and only stdout re-enters context.

- **7.3 Forked learning loop.** Do: propose `MEMORY.md` / skill updates off a warm cache/digest.
  Done: emits a diff proposal; applies nothing without approval.
- **7.4 CLI `--local`** *(Gate)*. Files: `apps/cli/src/index.ts`. Do: in-process agent loop over
  the `RuntimeToolSet`. Needs a live provider key — gated.

> g0dm0d3 is AGPL — ideas only, clean-room, never copy source.

## 8. Nexus Drive — per-user sandboxed CLI + storage (flagship)

**Spec (locked, do not re-decide):** Firecracker microVM primary; fallback order gVisor →
Docker-limits. FS-level 512 MB quota (loopback ext4 or XFS project quota) at `/workspace`;
soft-warn ~90% (~460 MB) + bounded grace, then hard-block. 30-day idle reclaim (warn first;
track `lastActiveAt`). User supplies their own LLM key via `.env` in `/workspace` (NOT BYOK
injection); seed `.env.example`; never log it; exclude from backups/exports. Persistent volume +
ephemeral compute; per-sandbox CPU/RAM/PID/wall-clock caps; egress policy-gated.
Baseline: `@nexus/sandbox` (`packages/sandbox/src/index.ts`, 442 lines: `executeCode`,
`defaultRunner`, `buildSafeEnv`, `buildDockerArgs` — already `--network=none`, `--cap-drop=ALL`,
`--pids-limit`, `no-new-privileges`, mem/cpu caps — `createDockerRunner`) + `/drive/*` routes
(`apps/api/src/routes/drive.ts`, 362 lines: `safeResolve` path guard, app-level
`QUOTA_BYTES = 512MB`, status/exec/ls/upload-with-413/delete, Docker exec fallback) behind
auth + rate limits.

- **8.1 Isolation spike** *(Gate — do FIRST in §8; decision gate for the rest; recorded Blocked
  in PROGRESS — needs a dev host with `/dev/kvm` present).* Do: boot a
  Firecracker microVM + prove FS-level 512 MB quota end-to-end on the dev host (`/dev/kvm`
  present). Throwaway; record outcome in PROGRESS. If Firecracker fails documented KVM/jailer
  checks → gVisor systrap; Docker-limits is the interim. No production isolation code until it
  passes.
- **8.2 FS-level quota.** Files: `apps/api/src/routes/drive.ts` + sandbox mount. Do: replace the
  app-level `QUOTA_BYTES` accounting with loopback-ext4/XFS-project quota. Done: a write past
  512 MB hard-fails at the FS layer (`cd apps/api && pnpm exec vitest run tests/routes/drive.test.ts`).
- **8.3 Schema.** Files: next-free migration + `packages/db/src/schema/drive-workspaces.ts`
  (userId, volumePath, quotaBytes, lastActiveAt, state) per the recipe. Done: provision/teardown
  persists a row.
- **8.4 Lifecycle worker.** Files: extend `apps/worker/src/handlers/drive-handler.ts`
  (107 lines — today exec-jobs only, `handleDriveExecJob`) + `workspace-manager.ts` (554 lines —
  `WorkspaceManager`, `runScriptBounded`, TOML `NexusSettings`). Do: BullMQ job for provision +
  30-day idle-reclaim cron (warn first) + quota sweep; Prometheus metrics; backup/export
  endpoint. Done: reclaim + sweep run on schedule.
- **8.5 UI.** Files: `apps/ui/app/routes/sandbox.tsx` (exists, 554 lines). Do: terminal + drive
  panel; seed `.env.example` into fresh workspaces; quota meter with soft-warn. Done: file ops +
  quota meter work.
- **8.6 Hardening.** Do: clear the drive/sandbox CodeQL alerts in `.cleanup-alerts.txt`
  (path-injection, command-injection, http-to-file + insecure-temp at `drive.ts:317`,
  missing-rate-limiting); egress allowlist (deny by default); never log `.env`; runaway limits.
  Done: those alerts cleared; egress denied by default.

## 9. Security hardening

Baseline: SSRF filter + resolve-then-pin (`packages/runtime/src/security-utils.ts`:
`isSafeUrl`/`safeLookup`/`makeSafeLookup`) + `apps/api/src/lib/pinned-fetch.ts` (90 lines:
`createPinnedFetch(lookup)`, `pinnedFetch` — socket pinned to the validated DNS answer; used by
MCP `/test`) + identity-keyed per-user rate limiting. `.cleanup-alerts.txt` = 48 CodeQL alerts.

- **9.1 Extend pinned-fetch.** **Shipped this branch — do not redo.** Converted 3 sinks:
  `routes/connectors.ts` OAuth token-exchange (commit `b65f638`), `routes/api-bridge.ts`
  webhook-trigger delivery (commit `4160944` — the only user-supplied-URL sink among that
  file's 14 `fetch(` sites), `routes/oidc.ts` discovery/JWKS/token-exchange (commit `35862a4`).
  Every other native-`fetch` file (audited 2026-07-02) was justified-safe rather than
  converted — no earlier validate-then-use gap for DNS rebinding to land in, because the URL
  is a hardcoded literal or env-fixed infra host with no per-request variability:
  `routes/{researcher,bots,obs-providers,mail-ingest,gateway,llm-oauth,oauth,geoip,libertas}.ts`,
  `lib/{sentry-reporter,rate-limiter,shared-kv}.ts` (`lib/cf-adapter.ts` has no real fetch call,
  docstring only). Full reasoning in PROGRESS.md's 2026-07-02 "Now" section.
  Test: `cd apps/api && pnpm exec vitest run tests/routes/mcp-servers.ssrf.test.ts
  tests/routes/connectors.ssrf.test.ts tests/routes/api-bridge.webhooks-ssrf.test.ts
  tests/routes/oidc.ssrf.test.ts` — 27/27 pass.
  Done: an outbound call to a host resolving to a private IP is rejected.

- **9.2 Clear CodeQL alerts.** **Shipped this branch (commit `5433da5`) — do not redo.**
  Audited all 48 `.cleanup-alerts.txt` entries 2026-07-02. Real fix needed and shipped: 6
  `api-bridge.ts` routes (`/v1/projects/:id/files`, `/stm*`) were missing `bridgeRL` —
  added after the June 24 scan, sibling routes already had it; plus a dead
  `modelOptions` const in `archetypes.tsx` (js/unused-local-variable). Every other alert
  (path-injection/command-injection/http-to-file/insecure-temp/resource-exhaustion/
  unreachable-statement in `drive.ts`, command-injection in `sandbox/index.ts`,
  file-system-race in `scaffold.ts`, xss-through-dom in `scrape.tsx`, the rest of
  missing-rate-limiting in `sse.ts`/`oauth.ts`, unvalidated-dynamic-method-call in
  `provider-keys.ts`, bad-tag-filter/reflected-xss in `api-bridge.ts`) was already fixed by
  commit `7b9877e` ("fix(deploy,ci): Railway deploy, CodeQL alerts...", 2026-06-26) — which
  landed *after* the scan that produced the alert list, so the list itself is stale, not the
  code. Verified each by reading the current file at the flagged (or line-drifted) location.
  `js/insufficient-password-hash` (`crypto-utils.ts:11`): confirmed false positive as noted
  below — already documented in-code; dismiss in the CodeQL UI, no code change.
  Done: every alert traces to a real fix (this branch) or already-fixed code; the alert list
  itself needs a GitHub-side re-scan to empty (external action, not a code change).

- **9.3 Rate-limit remaining route groups.** Mirror: `makeRateLimitPreHandler`/
  `makeUserRateLimitPreHandler` usage in `apps/api/src/server.ts`. Done: each authenticated
  group buckets by identity.

- **9.4 Docker sandbox hardening.**
  Files: `packages/sandbox/src/index.ts` (`buildDockerArgs`).
  Do: add seccomp profile (`--security-opt seccomp=<profile.json>`, profile file checked in),
  read-only rootfs (`--read-only` + tmpfs for scratch), user-namespace remapping.
  Test: `pnpm exec vitest run packages/sandbox/tests/sandbox.test.ts` (assert the args array).
  Done: container runs with all three.

- **9.5 apps/api baseline.** Do: output sanitize + prompt-injection guard. Done: guard rejects
  a known injection payload in a test.

## 10. UI surfaces over existing backends

Baseline: backends complete; `@xyflow/react` installed. Register every new page in
`apps/ui/app/routes.ts`; CRUD pages mirror `provider-keys.tsx` (321 lines), dashboards mirror
`costs.tsx`. The prompts + build-tasks APIs live inside `apps/api/src/routes/api-bridge.ts`
(`/prompts` + `/prompts/:id/versions` ~line 9032+; `/build/tasks` + steal/claim/release/submit
~line 8889+). **Already shipped — do not redo:**
**10.1 prompt version drawer** (`prompts.tsx` has the drawer; restore creates a new version via
POST `/api/prompts/:id/versions`) and **10.2 build-task DAG** (`components/build-graph.tsx` +
Board↔Graph toggle in `build.tsx`; orphan `parentId` → root with an orphans banner;
`TaskDetailPanel` is defined in `build.tsx`).

- **10.3 MCP servers UI.** Files: new `apps/ui/app/routes/mcp-servers.tsx` modeled on
  `provider-keys.tsx`, over the existing API `apps/api/src/routes/mcp-servers.ts` (324 lines:
  `mcp_servers` CRUD + `/test`, which already goes through `pinnedFetch`; mig `0010`).
  `/test` is a live outbound call — **Gate** to exercise for real, mock it in tests. Done:
  CRUD + test-connection work.
- **10.4 Workflow picker polish.** Files: `apps/ui/app/routes/workflows.tsx` (864 lines) +
  `@lobehub/icons` (new dep — not yet in `apps/ui/package.json`). Do: provider/model icons;
  feed models.dev metadata (§1.5 table) into the picker. Done: icons render.
- **10.5 Medium-term pages** (each its own item; backends already mature): voice (`voice.tsx`),
  image-gen Sandbox tab, knowledge-graph viz, prediction-markets dashboard, gauntlet benchmark,
  RLHF thumbs → `rlhf-pipeline`, eval-runner UI.

## 11. Memory upgrade — `packages/memory` (library-only)

Baseline: `packages/memory/src/index.ts` (~2.3k lines): `MemoryManager`, `IMemoryStore`
(`InMemoryStore`, `PgVectorStore`, `TurboQuantStore`), `IEmbedder` (`GroqEmbedder`,
`FixedEmbedder` — use `FixedEmbedder` + `InMemoryStore` for deterministic tests),
`cosineSimilarity`/`normalize`. Tests: `packages/memory/tests/{memory,pg-vector-store}.test.ts`.

- **11.1** Do: entity linking + temporal reasoning + multi-signal fusion (BM25+vector+entity,
  single-pass) à la mem0; self-editing typed blocks (human/persona/scratch) à la letta — extend
  `MemoryManager`, keep `IMemoryStore` implementations interchangeable.
  Test: `pnpm exec vitest run packages/memory/tests/memory.test.ts`
  Done: fusion retrieval + typed-block edit unit-tested (deterministic embedder).

## 12. MCP breadth + A2A (last / optional)

Baseline: `packages/mcp-client/src/index.ts` (336 lines): `McpClient`, `McpTransport` /
`McpHttpTransport`, typed tool/resource defs, injectable `FetchFn` (test seam),
`McpClientError`. No A2A package exists yet.

- **12.1** Cherry-pick missing MCP tools (sandboxed, no unscoped capability) — extend
  `McpClient`/`packages/agent-runtime/src/mcp-tools.ts` (92 lines).
- **12.2** A2A JSON-RPC-over-SSE (authn'd, no impersonation) — greenfield package.
- **12.3** Optional `mcp-compressor` to shrink tool manifests 60–95%.

## 13. Domain feeds — `@nexus/domain-feeds`

Baseline: `packages/domain-feeds/src/index.ts` (~3.3k lines): abstract `FeedAdapter<T>` + ~26
adapters (`MaritimeFeed`, `AviationFeed`, `CyberFeed`, …) + `FeedRegistry`/`FeedCache` +
standalone fetchers (`NgaNavWarningFeed`, `SecEdgarFeed`, …). Tests:
`packages/domain-feeds/tests/domain-feeds.test.ts` (mocked fetch).

- **13.1 Port-congestion source.** Do: verify a live keyless source (**Gate** — live probe),
  then add the adapter mirroring `MaritimeFeed`. Done: adapter + mocked-fetch test.
- **13.2 AIS vessel-name enrichment.** Files: `MaritimeFeed`. Do: enrich via Digitraffic
  `/vessels` (live probe = **Gate**; test with mocked fetch). Done: names attached to incidents.
- **13.3 Dark-web sources** *(Gate — legal review before any code).*

## 14. Production multi-tenant hardening (mostly external infra; scaffolding in `infra/`)

Each done when its infra is provisioned + configured (many are Blocked, see table): DB
(PgBouncer, read replicas, PITR, encryption at rest); Auth (RS256 JWT multi-service, OAuth
device flow for CLI, session revocation + audit, brute-force backoff); Observability (OTel
tracing, SLO dashboards, alerting, per-tenant cost attribution); Infra (K8s HPA `infra/k8s`,
multi-AZ PG/Redis, CDN, edge DDoS); Compliance (SOC2, GDPR residency + deletion,
no-LLM-data-logged); Coverage (tests → 80%+ across `council`, `memory`, `runtime`).

## 15. Long-term / ambitious

~~Multi-tenant SaaS / Stripe~~ (struck). Plugin marketplace (`plugin-sdk` → hosted registry,
Deno-isolate sandbox), federation (cross-instance delegation, federated council, CRDT KG sync,
OIDC/SAML), fine-tuning pipeline (SFT via `sft-tagger` + `corpus-builder`), agentic browser
(`stealth-browser`), desktop (Electron + offline worker), mobile (React Native + push).

---

## Blocked on external infra (not solvable in code)

| Task                      | Blocker                                                       |
| ------------------------- | ------------------------------------------------------------ |
| Firecracker microVM spike | ~~KVM host~~ — `/dev/kvm` present on dev host; doable locally |
| gVisor fallback testing   | Linux host with `runsc`                                      |
| Docker sandbox e2e        | Docker daemon on the worker host                             |
| Redis cluster rate-limit  | Upstash / managed Redis                                      |
| PgBouncer pooling         | DB admin                                                     |
| K8s HPA deploy            | K8s cluster (chart in `infra/k8s/`)                          |
| Grafana dashboards        | Grafana instance (configs in `infra/grafana/`)               |
| Provider OAuth app reg    | Google/GitHub dev consoles for client IDs                    |

## Not scheduled (revisit only if the blocker clears)

- **GCF encoder** (§3) — no defined spec/acronym; nothing to build until one exists.
- **Bailian native `/api/v1` envelope** (§1) — only needed for Qwen-only extras;
  OpenAI-compatible mode covers current use.

## Reference note

`nexus/omni` can front any self-hosted OpenAI-compatible router to inherit a large provider
catalog with zero native driver work. Fine for dev/self-host; for production prefer native ports
(§1–§3) over shipping the sidecar as a silent hard dependency.
