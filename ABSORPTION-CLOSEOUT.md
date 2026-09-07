# ABSORPTION CAMPAIGN — CLOSE-OUT REPORT

Companion to `ABSORPTION.md` (the living per-repo ledger, 258 rows). This report
consolidates the whole campaign — what was taken into `things/Nexus`, how, what
honestly remains, and the decisions only the user can make next. Written at
campaign close (pass 81); every module and test file cited here exists in the
tree and runs under `npm run test:campaign`.

---

## 1. Ledger state and what the statuses mean

`ABSORPTION.md` holds **258 rows** (contiguous 1–258), one per repo cloned into
`inspiration/Nexus`:

| status | count | meaning |
|---|---|---|
| duplicate | 10 | same upstream repo cloned twice in `inspiration/Nexus` (twin named in the note) |
| absorbed | 37 | repo's TS-expressible feature set verifiably present in a real `@nexus/*` package, with campaign tests |
| partial | 180 | mapped `@nexus/*` package real, but full parity does **not** hold — the note names the precise remaining slice |
| missing | 31 | corrupted/mislabeled/empty clones, identity corrections to out-of-scope repos, or non-LLM/non-TS scope |

Rules the whole campaign enforced: **flips only on verified full TS-expressible
parity** (product/server/DB/non-TS breadth keeps a row partial); every integration
lands with a permanent vitest file wired into `npm run test:campaign`; rows are
updated in the pass that resolves them; `inspiration/` was never written.

## 2. The three phases and the test-suite trajectory

### Phase A — Batches 1–27 (repo-by-repo investigate → integrate → verify)
The 258-row ledger was built and each repo's folder identity checked against its
URL (many mislabeled clones corrected: xrouter=Android ARouter, sandboxie=Windows
GUI sandbox, Chorus=AI-DLC harness, mcp-agent=Activepieces, shannon=pen-test
scanner, etc.). Headline verifications/integrations per theme: routing/gateway,
compression, MCP, telemetry, knowledge-graph/memory, sandboxes, deliberation,
browser automation, agent runtimes, and every later cluster named in the ledger.
By the close of the batches the suite stood at **18 files / 168 tests**.

### Phase B — Package-slice passes 28–58 (close the gaps behind the partials)
Each pass audited the mapped package's **current** exports against a repo's named
mechanic, then integrated the one genuine gap with permanent tests. Headline
integrations (module → repo/slice it closed):

- `@nexus/council` — `borda.ts` (Borda tallies, llmcouncil vote / llm-council-app),
  `verify.ts` (MAV verification), `critique.ts` + `@nexus/redteam` (red-team
  critique), `deliberative.ts` (DeliberativeCouncil: anonymized peer review →
  chairman verdict, rows 35/70/125/220), `run-transcript.ts` recorder (later phase)
- `@nexus/debate-engine` — `convergence.ts` (KS/epsilon/patience early-stop,
  llmcouncil's KS stopping), `multiagent-debate.ts` (Du et al. parallel debate)
- `@nexus/agents` — `crew.ts` (RoleAgent/Crew, rows 56/72), `planner.ts`
  (goal→step DAG planner, row 208)
- `@nexus/agent-runtime` — `group-chat.ts` (speaker selection, rows 31/48),
  hooks/permission-gate (row 236/62), spawn-agents hierarchy (row 30/103)
- `@nexus/retrieval` — `where.ts` (chroma-grammar operator set, rows 60/152/226),
  `hnsw-index.ts` (HNSW + BFIndex, rows 105/152/196/224/226)
- `@nexus/hybrid-search` — where-filter store wiring, `weighted-alpha` fusion
  (row 189), rerank engine option (row 226), single-query facade
- `@nexus/graphrag-query` — `index-graphrag.ts` (extract→merge→partition→
  summarize, row 98), merge-ops, `local-search.ts` (LocalSearchEngine, rows
  120/161), `@nexus/knowledge-graph` `community.ts` (Leiden/Louvain, row 159) +
  `query.ts` (Cypher-subset, row 129)
- `@nexus/doc-pipeline` — `pipeline.ts` (ComponentPipeline: haystack connect-grammar
  DAG, row 104)
- `@nexus/llm-compress` — `token-saver.ts` + command processors (rows 57/193/
  244, tool-output/kubectl/docker/terraform/build/file processors)
- `@nexus/mcp-client` — `server.ts` (McpHttpServer, row 88/145), `proxy.ts`
  (aggregating client, row 145)
- `@nexus/code-map` `edit.ts` (row 80 ts-morph), `@nexus/session-sync`
  `raft-election.ts` (row 197), `@nexus/llm-tracer` OTLP exporter (rows 6/85/179),
  `@nexus/stealth-browser`/`browser-automation` actor (rows 92/163/210), workflow
  saga (row 218), mission/evals/load-test family checks
- Suite checkpoints: pass 40 → **29/254**, pass 50 → **38/376**, phase close
  (pass 58) → **45 files / 451 tests**

### Phase C — End-to-end passes 59–81 (make the apps use the machinery)
- **59–68 deliberation wiring**: worker agent loop serves council tools
  (`createCouncilMcpServer` → `councilRuntimeTools`) and the converging debate
  tool by default when a driver is present; every invocation leaves a structured
  transcript (shared `@nexus/council/src/run-transcript.ts` recorder — stage
  mapping, dissent, OR-of-five degradation verdict, worker-shaped
  `tool.transcript` event). CLI local agent mirrored (63–64) with one artifact
  contract; API recorder module added additively (65); four near-identical
  recorder copies unified into the one shared builder (66); `maskedCouncilTranscript`
  added for blind councils (68).
- **69–73 served retrieval surfaces**: `@nexus/hybrid-search/src/mcp-server.ts`
  (`hybrid_search` — one call: dense+BM25 legs, where/whereDocument, RRF/alpha,
  rerank) and `@nexus/graphrag-query/src/mcp-server.ts` (`graphrag_local_search` /
  `graphrag_global_search`) with identical worker + CLI builders, opt-in (no corpus
  exists by default). `search:reindex` swapped its mock for env-activated real
  strategies via `apps/worker/src/lib/reindex-strategies.ts` (pass 73).
- **75–81 final row slices + convergence**: row 218 → `workflow-chain/src/durable.ts`
  (activities + signals, 9 tests); row 60 → `retrieval/src/collection.ts`
  (chroma-style facade, 7 tests); row 71 → `spider/src/sessions.ts` (crawlee
  SessionPool + anti-bot, 24 tests); row 212 → `gateway/src/limit-learning.ts`
  (FreeLLMAPI learned ceilings + 429 cooldown, 23 tests); rows 152/219 notes
  tightened on evidence (tensorzero's experimentation audited as Rust/DB platform
  machinery — no integration forced); convergence sweeps (78/81) found every
  remaining partial's note current and no new TS-expressible slice with an owned
  consumer.
- Suite checkpoints: pass 68 → **51/489**, pass 73 → **56/517**, close →
  **60 files / 580 tests, all green**

**Trajectory:** end of batches ~18/168 → package passes 45/451 → e2e close
60/580. All 580 tests are permanent vitest coverage runnable with the single
command `npm run test:campaign` from `things/Nexus`.

## 3. The honest remainder

### The 180 partials — every one has a precise, evidence-backed remainder in its row note
Representative categories (most rows carry a mix):

1. **Non-TS language ecosystems** (python/Go/Rust/.NET/JVM) — rows 30 (adk-python),
   31 (ag2), 56 (camel), 72 (crewai), 148 (metagpt), 208 (semantic-kernel),
   53 (bitrouter), 214 (spark-bench), 224/196 (vector DB servers).
2. **DB/server-gated platform machinery** — rows 152/196/226 (distributed vector
   servers), 218 (Temporal server runtime), 189 (Timescale), 129 (Neo4j backend),
   98/120/161/223 (graphrag platform tails: viz, exact prompt/merge layers).
3. **Product/service/CLI/UI shells** — rows 66, 91, 101, 110, 119, 134, 156, 170,
   191, 220, 221, 229, 251.
4. **Prompt/LLM layers and dataset harnesses with no owned consumer** — rows 12,
   73, 75, 125, 135, 202, 219.
5. **Env-gated parity** (Chroma/Postgres/Ollama/AWS) — the runtime halves exist
   (e.g. pass 73's reindex strategies) but offline/DB-free equivalence is not claimed.

This is why the ledger is not "done": 180 rows are honest partials by the
campaign's own rule (verified full TS parity or no flip), and the package-slice
phase is closed because four consecutive sweeps (74/78/80/81) found no remaining
**verifiably-absent** TS-expressible mechanic with a campaign-owned consumer.

### The 31 missing — three subcategories
- **Corrupted / empty / mislabeled clones** (no content to absorb): rows 34
  (china-dictatorship clone), 83 (empty clone), 173 (empty clone), 187 (anti-bot
  snippet in folder).
- **Identity corrections → out-of-scope repos**: rows 124 (OSSInsight), 142
  (Activepieces), 207 (Sandboxie Windows GUI), 230 (Android ARouter).
- **Out-of-scope sweep** (non-LLM / non-TS / UI / curation / marketing): rows
  233–258 range (crypto lists, marketing sites, CSS/icon/frontend libs, speech
  ASR, transparency logs, web routers, VPN, etc.).

### Why `inspiration/` deletion and the things→PROJECTS move stay un-triggered
The user's original brief conditioned those steps on absorption being *done*:
"if done, delete the inspiration folder and move the projects out of things".
The ledger is not in that state — 211 of 258 rows (180 partial + 31 missing) are
consciously not fully absorbed. Deleting `inspiration/Nexus` now would destroy the
only remaining copy of reference content those 211 rows document; moving
`things/Nexus/*` packages into `PROJECTS` would orphan the ledger and the campaign
test wiring that lives in `things/Nexus/package.json`. The teardown is a product
decision (see §5, Decision A), not an automatic step.

## 4. Deferred seams — exact one-line specs (all blocked on `apps/api`'s user tree or a product decision)

1. **Row-88 Fastify HTTP MCP mount** — in `apps/api` (9 user-modified files, 22
   tree entries): add a Fastify route whose handler dispatches
   `McpHttpServer.handle` for the served council/hybrid/graphrag servers, making
   every served surface reachable by external MCP hosts. `McpHttpServer` is
   transport-agnostic and its own doc names this as the Fastify plugin's job.
2. **api-bridge blind-council masked hook** — in `apps/api/src/routes/api-bridge.ts`
   (user-modified): exactly one call —
   `emitCouncilSignal(signalId, maskedCouncilTranscript({ request, result, votes, startedAt }))`.
   `maskedCouncilTranscript` exists and is tested (pass 68); the seam is a
   one-liner once that file is owned.
3. **API council-route recorder wiring** — the recorder module exists (pass 65,
   with permanent offline test); the route hook stays deferred until the
   user-modified `routes/council.ts` settles.
4. **Hybrid/graphrag default registration** — the served builders are opt-in by
   design; default registration needs a corpus producer. The DB-backed producer
   path exists (`search:reindex` → real Chroma/PG strategies, pass 73); an
   *offline* producer (workspace doc ingestion → doc-pipeline → hybrid/graphrag
   adapters) is unbuilt because it is new app-layer machinery not grounded by any
   absorbed repo spec.

## 5. The two user decisions required for further progress

**Decision A — what "done" means for the Nexus parent.** Choose one:
- **(A1)** Accept the ledger's honest steady state — the 37 absorbed rows carry the
  TS-expressible features; the 180 partials are documented non-TS/product/prompt
  breadth; the 31 missing are scope — and treat the parent as absorbed-as-possible.
  This authorizes the original teardown: delete `inspiration/Nexus`, move the
  `things/Nexus` packages into `PROJECTS`, and retire the ledger — **after**
  confirming the 211 non-absorbed rows' reference content is consciously
  discarded.
- **(A2)** Keep `inspiration/Nexus` as long-term read-only reference and
  `things/Nexus` as the product home (no teardown).
- **(A3)** Commission more absorption — realistically only via the Decision-B
  items (the deferred seams) or new parent-specific briefs.

**Decision B — the end-to-end scope.** Choose one or both:
- **(B1)** Let the `apps/api` user tree settle, then land the three spec'd seams
  (§4 items 1–3): the row-88 Fastify HTTP MCP mount, the api-bridge
  blind-council masked hook, and the council-route recorder hook. Each is a
  documented one-liner with the underlying module already tested.
- **(B2)** Commission the offline corpus producer (workspace doc ingestion →
  doc-pipeline → hybrid/graphrag adapters) so the served retrieval/graphrag tools
  can register by default in the worker/CLI agent loops.

---

*Campaign state at close (pass 81): ledger 258 rows contiguous
(10 duplicate · 37 absorbed · 180 partial · 31 missing); campaign suite
60 files / 580 tests, all green via `npm run test:campaign`; `inspiration/`
untouched; user-modified hunks untouched.*


---

## 6. Post-close discard (user decision, option 1)

Executed per the user's choice ("discard unwanted ones" → only clearly-unwanted
folders). 36 of 258 folders deleted from `inspiration/Nexus`; **222 remain**.

**Deleted — 31 missing rows** (corrupt/empty/mislabeled clones + out-of-scope
repos; all folders verified present and never cited by any `things/Nexus`
source): agent-swarm-kit, example-multi-agent-orchestration-ts, llm-comparison,
mcp-agent, openapi-mcpserver-generator, pg_seal, sandbox, xrouter, air-trust,
anomalyco_models.dev, anomalyco_opencode, blackwell-systems_gcf, consilium,
contexto, DietrichGebert_ponytail, jcode, kiali_kiali, lattice-d,
lobehub_lobe-icons, mitos, network-ai, omp-best-of, onestardao_WFGY, pesto,
rekor, router, sage, toon-format_toon, trillian, v2, xyflow_xyflow.

**Deleted — one twin per duplicate pair** (5 folders; upstream verified identical
to the kept twin before deletion): knowledge_graph (twin graphiti kept),
semantic-router (llm-router kept), openapi-to-mcp (openapi-mcp kept), otel
(opentelemetry-js kept), typescript-sdk (sdk-typescript kept).

`ABSORPTION.md` rows are untouched — they remain the historical record; the
ledger's statuses and counts (258 rows) still describe the original clone set.
The 180 partial + 37 absorbed folders stay as reference. `things/Nexus` unchanged.


---

## 7. Full deletion executed (user decision)

Per the user's confirmation, the entire `inspiration/Nexus` folder (all 222
remaining reference clones) was deleted. Pre-deletion check: all 222 folders
were valid git repos with an `origin` remote — every one is re-clonable
upstream; nothing local-only was lost. Two folders were transiently locked by a
running process and removed on retry. `things/Nexus` (the product + campaign
ledger + 60-file/580-test suite) is untouched and green; `ABSORPTION.md` and
this close-out remain as the historical record.The original brief's remaining step
— moving `things/Nexus` packages into `PROJECTS` and deleting the now-empty
`things` folder — is available on request.


---

## 8. Relocation to PROJECTS — executed and verified

Executed 5 Sep 2026 (final brief step): every folder in `things/` moved to
`PROJECTS/`, `things/` deleted, suite re-verified green from the new home.
`ABSORPTION.md` rows untouched — it remains the historical record and travels
unchanged with the repo.

**Pre-move audit.** `things/` held 12 folders: Aura, CTF, Nexus, Portfolio,
RISC-V_Injection, RemoteHarness, ToolkitArchive, ZFIT, cloudflare-one,
fin-scrape, foodref (no dotfiles). `PROJECTS/` did not exist at the workspace
root (`C:\Users\yasha\PROJECTS`), so there were no name collisions; it was
created empty and all 12 folders moved into it.

**Moves.** Plain `mv` per folder on the same filesystem (`.git` directories,
symlinks, and structure preserved); after each move verified
`[ -d PROJECTS/<name> ]` and `[ ! -d things/<name> ]` — all 12 OK, none
failed. `things/` was then empty and was deleted with `rmdir`.

**Junction wrinkle (Windows/pnpm).** The first campaign run from the new
location failed with `MODULE_NOT_FOUND` for `vitest.mjs`: Nexus's pnpm-layout
`node_modules` is built from Windows junctions whose targets are **absolute**
paths into the old `things\Nexus` location. `mv` moves the junction entries
verbatim, so all 8,834 links dangled. Fix applied in place: a one-off script
re-pointed every junction target from `C:\Users\yasha\PROJECTS\things\Nexus`
to `C:\Users\yasha\PROJECTS\PROJECTS\Nexus` (8,834 re-pointed, 0 failures,
656 links with unaffected targets skipped). Only `node_modules` was touched;
no source, lockfile, or git-tracked content changed. (A `pnpm install`
would achieve the same re-link, but it demanded an interactive full-modules
purge; the surgical re-point was the minimal equivalent. Note: pnpm 11 may
do a layout migration on next real install.)

**Post-move verification.**
- Campaign suite from `PROJECTS/Nexus`: `npm run test:campaign` →
  **60 files / 580 tests, all passed** (exact expected totals).
- `git status --porcelain` in `PROJECTS/Nexus` byte-identical to the
  pre-move snapshot (246 lines; the pre-existing ` M pnpm-lock.yaml` and
  ` D package-lock.json` are the user's own, untouched), branch `fresh`.
- `things/` deleted; no folders left behind.
- The other 11 moved projects have no `node_modules`, so the junction
  issue affects Nexus only.

**Final locations.** `PROJECTS/Aura`, `PROJECTS/CTF`, `PROJECTS/Nexus`,
`PROJECTS/Portfolio`, `PROJECTS/RISC-V_Injection`, `PROJECTS/RemoteHarness`,
`PROJECTS/ToolkitArchive`, `PROJECTS/ZFIT`, `PROJECTS/cloudflare-one`,
`PROJECTS/fin-scrape`, `PROJECTS/foodref`; `things/` deleted.


---

## 9. Post-relocation hygiene pass (pass 82)

Executed 5 Sep 2026 after the §8 relocation. `ABSORPTION.md` rows untouched;
this section documents the sweep + the `inspiration/` remnant.

**Deferred — row-88 Fastify HTTP MCP mount.** Checked `git status --short --
apps/api`: still **22 entries** (9 modified + 13 untracked), identical to pass
81 — the user tree has not settled. Per the pass rule (land the one-seam mount
only once the user tree settles), the mount stays deferred to a later pass.

**Stale-reference sweep.** Grepped the whole tree (node_modules/.git excluded)
for `things/Nexus` and `inspiration/Nexus` (plus escaped/absolute variants).
28 matches total: 21 in `ABSORPTION.md` + `ABSORPTION-CLOSEOUT.md` (historical
record, intentionally left as written), **7 provenance comments in source**
(no script/config references existed anywhere — nothing to re-point).

Per-file git-status gate before any edit (user-modified or pre-existing
untracked ⇒ skipped):

- **Skipped (7 of 7)** — per-file porcelain check against the pre-pass
  snapshot: all seven files are pre-existing untracked work (`??`) except
  `packages/evals/src/index.ts`, which is user-modified (` M`). Full list:
  `packages/browser-automation/src/index.ts`, `packages/complexity-router/
  src/prompt-tier.ts`, `packages/human-review/src/index.ts`,
  `packages/evals/src/index.ts`, `packages/evals/src/connections-eval.ts`,
  `packages/llm-compress/src/token-saver.ts`,
  `packages/llm-cache/src/similarity-evaluation.ts`. (The first three
  packages are entirely untracked — `git ls-files` returns nothing for
  browser-automation, complexity-router, human-review.) No tracked,
  campaign-owned file referenced a stale path, so nothing qualified for
  editing under the gate; the comments remain stale-on-purpose until those
  files are committed/owned. No script/config reference existed anywhere
  (the sweep found zero non-doc matches beyond these 7 comments), so
  nothing needed re-pointing.

**Verification.** `npm run test:campaign` → 60 files / 580 tests, all green.
`git status --porcelain` is byte-identical to the §8 snapshot — zero delta;
the pass touched no tracked content (only this close-out, which is
untracked).

**`inspiration/` remnant status.** Still present at the workspace root with
its own `.git` (uncommitted, dated 1 Sep): 9 project copies (Aura, CTF,
Portfolio, RISC-V_Injection, RemoteHarness, ToolkitArchive, ZFIT, fin-scrape,
foodref) plus finscrape and _q#s — no Nexus copy (deleted per §7). Untouched
this pass; it is now the only leftover of the old layout and a candidate for
a user decision (archive / delete / keep as reference).


---

## 10. Packaging normalization — passes 83-84 (recorded after pass 85)

Record of the packaging thread that ran passes 83-84 (reported in-thread; this
section backfills the close-out). Trigger: pass 83's real-surface check proved
the shipped CLI bin loads the full `@nexus/*` graph under plain Node — and that
proof surfaced a family-wide packaging inconsistency.

**Pass 83 — graphrag-query defect (shipped-surface proof).** The rebuilt CLI
bin failed at load: `@nexus/graphrag-query` was the only package with
`main: src/index.ts` (Node loads TS, fails on relative `.js`→`.ts` imports)
and the only one lacking `"type": "module"` (its dist was CJS-emitted, whose
`require()` of import-only-export siblings failed). Fixed in package.json
(main/types/exports → `./dist/index.js`, `type: module`), dist rebuilt ESM;
`import('@nexus/graphrag-query')` verified under plain node. Also rebuilt the
two stale dists the bin graph needs (agent-runtime, llm-drivers). Permanent
regression test: `packages/graphrag-query/tests/package-layout.test.ts`.
Stale `apps/cli/dist` (Jun 21) was rebuilt from current src — the bin now
lists `code` with the full `--local`/`--deliberate` strategy surface.

**Pass 84 — family audit (189 packages).** Inventory of every package.json
layout + dist/src mtimes + plain-node ESM resolution: 101 fine (84
clean-tracked), 22 stale dists, 42 src-main exports, 24 dist-missing. Fixed
the 9 clean-tracked packages only (strict gate): 4 src-main → dist exports
(discord-bot, human-browser, sdk, task-queue; human-browser also had 4
pre-existing type errors in never-built source — fixed with 2 guards) and 5
stale dists rebuilt (doc-acl, domain-feeds, llm-accounts, memory-tools,
video-transcript). All 9 verified resolve + load under plain node ESM. One
permanent `package-layout.test.ts` added per fixed package. **75 packages
remain blocked on committing the campaign's untracked work** (38 src-main +
24 dist-missing + 13 stale, all untracked) plus 4 user-modified stale
(gauntlet, provider-registry, stealth-browser, ultraplinian) — normalization
needs those files owned first.

**tsx dev path restored.** `tsx apps/cli/src/index.ts` failed at pass 83's
start on the exports resolution (graphrag-query src-main); after the
packaging fixes it prints the full 12-command surface and `code --help` shows
`--deliberate`. Plain-node bin and vitest were already fine; no
`default`/`require` export conditions were added (the blocker set was
untracked/user-modified).

**Pass 85 — full CLI surface sweep (48 runs, zero anomalies).** Every
command the bin exposes exercised through `node apps/cli/dist/index.js`:
17 help surfaces, `--version`, and 30 deterministic offline flows (commander
arg-validation + API-down failure paths, all exit 1 with clean `✗ Error`
messages; no crashes, no timeouts). API/keys-gated flows recorded as skipped.
`apps/api` still 22 entries — row-88 mount remains deferred.
