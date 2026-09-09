<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Roadmap (canonical plan)

**This file is the single source of truth for what is done, what is next, and what is
blocked.** `docs/STATUS.md` tracks verified feature state; `docs/design/*.md` hold the
Tier-3 specs. Shipped work stays listed (marked _✓ shipped_) with its acceptance evidence,
because every item below was written against this file's spec.

Legend: _✓ shipped_ (done, evidence inline) · **Files** = touch these · **Mirror** = pattern
to copy · **Done** = acceptance check · **Gate** = needs a live/external action (provider
key, OAuth app, live probe, host-mutating install) · **Blocked** = waiting on infra/decision.

> **Nexus is free/open** — no paid tier, no payment provider. "billing"/"quota" below = BYOK
> spend-guards on the user's own keys, never charging for Nexus.

Conventions for new work: build against mocks (`MockTransport`, injectable
`fetchFn`/`TokenHttp`); every live outbound call is a **Gate**; new env vars go in
`.env.example`; every new file carries the SPDX `Apache-2.0` header (`pnpm check:headers`);
migrations follow the `packages/db/migrations/` recipe (next free number, add a
`meta/_journal.json` entry or `db:migrate` skips the file); UI routes register in
`apps/ui/app/routes.ts` and mirror `provider-keys.tsx` (CRUD) or `costs.tsx` (dashboards).

---

## 1. LLM provider breadth

- **1.2 Dify SSE + threading** _✓ shipped_ — `DifyDriver.stream()` (`response_mode:
"streaming"`, delta reassembly, `message_end` usage + conversation_id, typed LlmError);
  `conversationId` on `LlmRequestOptions`/`LlmResponse`. llm-drivers 283/283.
- **1.3 Aux provider gaps** _✓ shipped (all four slices)_
  - image-gen: flux, stability, recraft, fal, comfyui — suite 92/92.
  - voice: deepgram, cartesia, assemblyai — suite 104/104.
  - embedders: voyage, jina, cohere in `packages/memory` — suite 181/181.
  - search: exa, brave, serper — suite 38/38; wired into `_webSearch()` + researcher.
- **1.4 Custom-driver framework** _✓ shipped_ — `packages/llm-drivers/README.md`.
- **1.5 models.dev seed** _✓ shipped (2026-09-08; importer completed 2026-09-09)_ — migration
  `0014_provider_models.sql` + journal + `provider-models.ts` schema; CLI `nexus models seed
[--file]` (fixture default, `ON CONFLICT (id) DO UPDATE`); API boot hydrates the registry
  from the table, zero startup network, fail-open. 2026-09-09: the package's models.dev
  importer is real (catalogue types, `modelsDevToDefinitions`, `fetchModelsDev` with
  injectable fetch, `registerFromModelsDev` with curated-keep/overwrite), the registry grew a
  flattened-model surface (`has`/`getModel`/`listModels`/`estimateCost`/…), and
  `globalRegistry` ships the curated defaults statically. provider-registry + billing 87/87;
  legacy red suite fixed. **Gate:** live `fetchModelsDev` pull (injectable fetch makes the
  eventual live pull a one-liner).

## 4. Provider OAuth + accounts

- **4.3 OAuth live E2E** _(Gate)_ — unit coverage exists in `packages/llm-oauth/tests/`;
  a live run needs the operator's registered OAuth app + redirect URI. Never log
  token-exchange bodies.

## 8. Nexus Drive — per-user sandboxed CLI + storage (flagship)

**Spec (locked):** Firecracker microVM primary; fallback gVisor → Docker-limits. FS-level
512 MB quota at `/workspace`; soft-warn ~90% + bounded grace, then hard-block. 30-day idle
reclaim. User supplies their own LLM key via `.env` in `/workspace` (never logged; excluded
from backups/exports). Baseline: `@nexus/sandbox` + `/drive/*` routes already in place.

- **8.1 Isolation spike** _(Gate — decision-gates §8.2–§8.6)._ `firecracker`/`jailer` not
  installed. Throwaway live spike: boot a microVM, prove a 512 MB FS quota hard-fails a
  write. **Researched procedure:** KVM preflight (`lsmod | grep kvm`, setfacl on /dev/kvm) →
  static binary from GitHub releases → kernel+rootfs from CI S3 (`unsquashfs`, inject ssh
  key, `mkfs.ext4 -d` on a 512 MB loopback with project quota) → run VMM with api socket →
  PUT `/boot-source`, `/drives/rootfs`, optional netif, `InstanceStart` → SSH in and
  `dd if=/dev/zero of=/workspace/big bs=1M count=600` (PASS = FS-level hard fail) → reboot
  teardown. Nothing committed. Fallback: gVisor `runsc`; Docker limits interim.
- **8.2 FS-level quota** — replace app-level accounting in `drive.ts` with real quota.
  Done: a write past 512 MB hard-fails at the FS layer. **Blocked on 8.1.**
- **8.3 Schema** — migration + `drive-workspaces.ts` (userId, volumePath, quotaBytes,
  lastActiveAt, state). Done: provision/teardown persists a row. **Blocked on 8.1.**
- **8.4 Lifecycle worker** — BullMQ provision job + 30-day idle-reclaim cron + quota sweep;
  Prometheus metrics; backup/export. **Blocked on 8.1.**
- **8.5 UI** — `sandbox.tsx`: terminal + drive panel, quota meter with soft-warn.
  **Blocked on 8.1.**
- **8.6 Hardening** — egress deny-by-default; never log `.env`; runaway limits.
  **Blocked on 8.1.**

## 13. Domain feeds — `@nexus/domain-feeds`

- **13.1 PortCongestionFeed** _✓ shipped (2026-09-08)_ — adapter in
  `packages/domain-feeds` (IMF PortWatch ArcGIS FeatureServer; count-then-paginate
  `resultOffset` 5000-row pages; epoch-ms dates; `portCongestionSignal` derives
  congestion/closure/underutilized severity; mock fallback on malformed payloads; honest
  empty on count 0). 96/96. **Route exposure shipped (2026-09-08):**
  `GET /api/v1/domain-feeds/intel/port-congestion` (`?limit=&where=&includeNormal=`) runs a
  direct feed fetch; appears in `/intel/brief` + `/intel/:domain` via the registry.
  **Gate:** live ArcGIS probe (field names/dates may drift). Worker polling + Telegram
  alert routing shipped via §16.1.
- **13.3 Dark-web sources** _(Gate — legal review before any code)._

## 14. Production multi-tenant hardening

- **14.1 RS256 wiring** _✓ shipped_
- **14.3 Brute-force / revocation** _✓ shipped_ (Redis-backed store Blocked on managed Redis)
- **14.4 GDPR erasure route** _✓ shipped_
- **14.5 Coverage → 80%** _✓ shipped_ (council 92.8%, memory 92.2%, runtime 80.5%)
- **14.6 DB / Infra provisioning** _(Blocked — see infra table)._

## 15. Long-term / ambitious

- **15.1 Plugin marketplace** — partial:
  - _✓ shipped_ manifest slice (typed manifest + capability grants, fails closed).
  - _✓ shipped (2026-09-08)_ registry transport (`PluginRegistryClient`: list/get/publish/
    install, wire manifests re-validated fail-closed, 404→NOT_FOUND, 409→CONFLICT) +
    sandbox contract (`CapabilityGate` execution-time deny-by-default;
    `DenoPluginRunner` with injectable runner seam; `SandboxUnavailableError` when the
    `deno` binary is missing — never a misleading capability denial). plugin-sdk 50/50.
  - _✓ done (2026-09-08)_ server-side registry `/api/v1/registry/plugins`
    (list/get/publish/install, manifest-validated, PersistentStore-backed) — and the
    legacy `_mpItems` store is collapsed: the marketplace is a UI projection over the
    registry (§16.2). `PluginRegistryClient` defaults to the same mount (§16.2).
  - **Gate:** real `deno` binary for actual isolate execution.
- **15.2 Federation** — partial:
  - _✓ shipped (2026-09-08)_ delegation orchestration on `@nexus/a2a`: `delegate()`
    (sends `blocking: true`; verifies terminal state, polls `tasks/get` when a peer returns
    `working`), `delegateWithRetry` (backoff; retries transport failures only, never a
    peer-failed task), `delegateFanOut`, `A2ADelegationCoordinator`. a2a 30/30.
  - _✓ shipped (2026-09-08)_ **federated council**: `aggregateCouncil` scores
    `delegateFanOut` outcomes into a consensus decision (quorum + agreement). a2a 39/39.
  - **Open:** CRDT KG sync, OIDC/SAML federation.
- **15.3 Fine-tuning pipeline** _✓ shipped (2026-09-08)_ — `@nexus/finetune-pipeline`
  (corpus docs + conversations → tagged/scored/filtered → OpenAI chat-completions JSONL;
  ≥10-example precondition as `FinetuneExportError`; tool turns skipped) + API route
  `POST /api/v1/sft/pipeline/export` returning **pure JSONL** (counts ride
  `X-Dataset-Count`/`X-Dataset-Lines` headers) + legacy `/fine-tune/*` hardened
  (AbortSignal timeouts; export enforces ≥10 with 422). Training runs **Blocked**
  (infra/GPU). Eval entries now capture the real assistant `response` at rating time
  (§16.4) — exports use it, falling back to labeled placeholders only for legacy entries.
- **15.4 Agentic browser** — spec written: `docs/design/agentic-browser.md`. Code waits on
  the scaffolding decisions in that spec (Playwright image, session host, TaskScript scope).
- **15.5 Desktop** — spec written: `docs/design/nexus-desktop.md` (Electron + PGlite
  offline worker; signing/notarization = Gates).
- **15.6 Mobile** — spec written: `docs/design/nexus-mobile.md` (Expo RN + push;
  developer accounts = Gates).
- **15.7 Per-model capability routing** _✓ shipped_ — `GET /api/v1/llm/route`.
- **15.8 Cheap extraction model** — enhancement, not a hole; deterministic distillation
  works today. Backlog.

---

## 16. Rectification backlog (audit findings — fix before new features)

Found by a four-dimension audit (2026-09-08) of the §13.1/§15.x passes. Ordered by value.

- **16.1 PortCongestionFeed observability** — _✓ done (2026-09-08)_: `GET
/api/v1/domain-feeds/intel/port-congestion` + registry registration + **worker polling
  job** (BullMQ repeatable `feeds:port-congestion`, 15-min cadence, Telegram alert on
  `critical` closures — worker suite typecheck-clean; live Redis run = Gate).
- **16.2 Marketplace: one owner** — _✓ done (2026-09-08, both sides)_:
  `routes/plugin-registry.ts` serves `/api/v1/registry/plugins` (list/get/publish/install)
  backed by `validatePluginManifest` + a `PersistentStore`, matching `PluginRegistryClient`'s
  wire contract (404→NOT_FOUND, 409→CONFLICT, publish requires auth; 7 route tests).
  **Client side fixed**: `PluginRegistryClient` now defaults `baseUrl` to `/api/v1/registry`
  (same-origin Nexus API mount) and its path template is `/plugins` — the wire contract
  now matches the server exactly (previously the client called `/v1/plugins` and the
  server served `/plugins`, so a default client 404'd). **Marketplace reconciled**: the
  api-bridge `_mpItems` demo store is gone — the marketplace is now a UI projection over
  the registry (routes/marketplace.ts): the six built-in showcase items are seeded as
  real manifests, publishes are registry publishes, installs bump the registry's
  download counter, and UI-only extras (category/price/rating/tags/stars) live in a
  separate `marketplace_ui` store. Registry-published plugins appear in the marketplace
  automatically. 9 marketplace route tests. **Per-user identity shipped (2026-09-08):**
  stars/installs are keyed on `request.nexusUserId` (JWT `sub` / api_keys) — the `"anon"`
  bucket remains only the dev-bypass fallback — `view()` is actor-scoped, and
  `GET /api/marketplace/me` returns the caller's own installed/starred plugin ids.
  +5 auth-enabled route tests (two-user isolation, unstar/uninstall scoping).
- **16.3 a2a delegate blocking semantics** — _✓ done (2026-09-08)_: sends `blocking: true`
  and polls `tasks/get` to a terminal state. **Federated council also shipped**:
  `aggregateCouncil` (quorum/consensus scoring over `delegateFanOut` outcomes) — a2a 39/39.
- **16.4 Fine-tune export data** — _✓ done (2026-09-08)_: `EvalEntry.response` (optional,
  backward compatible) is captured at rating time — `POST /evaluate` accepts a `response`
  field and `POST /evaluation/results` stores it when present — and `/fine-tune/export`
  emits the real assistant text, falling back to a clearly-labeled quality-metadata
  placeholder only for legacy entries. The whole surface lives in `routes/finetune.ts`
  (single owner).
- **16.5 Sandbox runtime single owner** — _✓ done (2026-09-08)_: `CapabilityGate` is the
  single enforcement point; missing `deno` reports `SandboxUnavailableError`.
- **16.6 domain-feeds monolith** — _✓ done (2026-09-08)_: infrastructure layer (helpers,
  FeedEvent/FeedPage, FeedAdapter, FeedCache/Registry, Sweep, DeltaEngine, TelegramAlerter)
  extracted to `src/base.ts`; **all 22 per-domain adapters now live in `src/feeds/*.ts`**
  grouped by domain: `aviation-climate-conflict.ts`, `economy-displacement-cyber-health.ts`,
  `seismo-wildfire.ts`, `maritime.ts` (incl. §13.1 PortCongestion), `market-intel.ts`,
  `research-legal.ts` (XML-seam feeds). `index.ts` is the barrel (3.0k → 1.2k lines):
  domain event types + `createDefaultRegistry` + legacy services, re-exporting the feeds.
  Public API identical — 96/96 tests, typecheck + build clean.
- **16.7 api-bridge monolith** — _✓ done (2026-09-08)_: fine-tune surface extracted to
  `routes/finetune.ts`; **marketplace surface extracted to `routes/marketplace.ts`**
  (registry-backed, §16.2); **costs surface extracted to `routes/costs.ts`**
  (`/costs/*` ×7, byte-identical shapes; pricing table `MODEL_PRICES` moved to
  `lib/cost-log.ts`, shared by the recording path and the reporting path; +7 hermetic
  route tests; live e2e 79/79); **sandbox surface extracted to `routes/sandbox.ts`**
  (`/sandbox/*` ×3, byte-identical shapes; `runViaPiston`/`runViaPyodide` exported for
  the code-agent build/run path, `_dockerReady` injected; +9 hermetic route tests);
  **repos surface extracted to `routes/repos.ts`** (`/repos/*` ×4, byte-identical shapes;
  GitHub listing TTL-cache + code search; +6 hermetic route tests incl. stubbed-fetch
  coverage of the token paths; legacy-dead tree-fallback branch flagged for cleanup);
  **bridge connectors surface extracted to `routes/connectors-bridge.ts`**
  (`/connectors/*` ×10 incl. sync jobs + schedules; 3 PersistentStores + seed moved
  with the block; +6 hermetic route tests; distinct from the v1 `routes/connectors.ts`);
  **tokens surface extracted to `routes/tokens.ts`** (`/tokens` ×3, raw `nxk_` value
  returned only at creation, sha256 stored; +5 hermetic route tests); **rooms surface
  extracted to `routes/rooms.ts`** (`/rooms` ×3; +3 hermetic route tests); **workflows
  surface extracted to `routes/workflows.ts`** (`/workflows` CRUD + `/:id/run`;
  `getDefaultDriver`/`buildChatRegistry` injected — no circular import; +6 hermetic
  route tests incl. a hermetically-run passthrough fn step); **KB surface extracted to
  `routes/kb.ts`** (whole /kb surface: listing, CRUD, documents, KG-ingestion alias;
  `getKG` injected; `getDocTypeFromName` moved; +5 hermetic route tests; the ingest
  alias's inert default extractors flagged — returns zero entities by design);
  **bridge memory surface extracted to `routes/memory-bridge.ts`** (8 routes incl.
  compact + delete-all; `getMemory` injected — embedder warmup stays bridge-owned;
  +7 hermetic route tests running on InMemoryStore + FixedEmbedder; distinct from the
  v1 `  routes/memory.ts`); **KG surface extracted to `routes/kg.ts`** (`/kg/*` ×7 incl.
  graph/search/extract/traverse/communities; the shared `getKGStore`/`getKG` moved
  to `lib/knowledge-graph-store.ts` — the four /symbolic/* consumers in api-bridge
  re-import from there, byte-identical; +7 hermetic route tests on the in-memory
  store; inert default extractors flagged).
  api-bridge keeps no local copy of any of the twelve.
  Rule stands: no new code lands in api-bridge (12.7k → 10.8k lines and falling).
- **16.9 Inert KG/KB ingest — tracked (2026-09-08)**: `POST /kg/extract`, `POST /kb/:id`
  (ingestion alias) and `/symbolic/ingest` return **zero entities by design** —
  `@nexus/knowledge-graph` defaults to null extractors. Pinned as current behavior in
  tests and the e2e (which asserts the empty-array shape deliberately, not a substring),
  NOT a bug to "fix" silently: wiring real extractors is a separate spec decision.
  Enhancement candidate: `@nexus/nlp-utils` extractor wiring + chunked ingestion.
- **16.8 Test-environment honesty** — _✓ done (2026-09-08)_: `tests/setup.ts` sets a fake
  `DATABASE_URL` + no-op `pg` stub (plain functions, not `vi.fn()` — `restoreAllMocks()` in
  suite afterEach would strip mock implementations of the module-scope pool). Previously
  DB-hanging suites (conductor-route) now pass. **Stale-test rectification also done
  (2026-09-08): `npx vitest run tests/routes` was fully green at that point — 154 passed,
  4 skipped (provider-keys ×3 pre-existing skips + drive symlink on Windows), 0 failed
  (historical count; the suite has since grown — see §16.7 / docs/STATUS.md for current).**
  What changed per suite:
  - `gateway.test.ts` / `gateway-fuzz.test.ts` — the old 400-contract tests were rewritten
    to the fallthrough contract hermetically: unknown models and unconfigured providers
    route to the always-on local Ollama driver (mocked fetch asserting the
    `:11434/api/chat` dispatch + default `qwen2.5:7b` tag), and an unreachable local
    fallback maps to 502 (fail-closed). No test depends on a live Ollama anymore. Both
    files now clear the shared KV in `beforeEach` — the prompt-cache/gateway-log
    singletons replay a previous test's cached 200 into the next test's cache-eligible
    payload otherwise (this was breaking the circuit-breaker test via a cached Groq
    response).
  - `threads.test.ts` — auth test now asserts the two-sided contract: 401 on every route
    when `NEXUS_API_KEY` is set, plus the documented dev-bypass (routes open, preHandler
    still runs) when no auth is configured.
  - `sse-tenant.test.ts` — firehose tests assert the current behavior: the
    enterprise-only tier gate was already removed from `sse.ts` (only
    `requireAuthWithTier` remains; nothing to delete), so a pro token hijacks the stream
    where it previously 403'd. **Owner choice: assert current behavior** — the dead
    branch is gone from code, only the tests were stale. Non-hijack tests got the same
    `{ timeout: 10_000 }` the hijack tests carry (the first DB-query test intermittently
    exceeded the 5s default under full-suite load).
  - `drive.test.ts` — symlink test skips with a stated reason when the platform refuses
    symlink creation (`EPERM`/`EACCES`/`ENOSYS`/`EXDEV`, e.g. Windows without elevation);
    the guard under test is symlink _resolution_, not creation.
  - Post-pass note: `PersistentStore.load()` now skips rows that violate the string-id
    key contract (a suite pg mock answering arbitrary row shapes used to hydrate
    garbage entries into shared stores — surfaced when the marketplace began reading
    the registry store).

---

## Blocked on external infra (not solvable in code)

| Task                      | Blocker                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| Firecracker microVM spike | `firecracker`/`jailer` install + a live throwaway boot (user go) |
| gVisor fallback testing   | Linux host with `runsc`                                          |
| Docker sandbox e2e        | Docker daemon on the worker host                                 |
| Redis cluster rate-limit  | Upstash / managed Redis                                          |
| PgBouncer pooling         | DB admin                                                         |
| K8s HPA deploy            | K8s cluster (chart in `infra/k8s/`)                              |
| Grafana dashboards        | Grafana instance (configs in `infra/grafana/`)                   |
| Provider OAuth app reg    | Google/GitHub dev consoles for client IDs                        |
| Plugin isolate execution  | `deno` binary install (host-mutating)                            |
| Fine-tune training runs   | infra/GPU                                                        |
| §13.1 live ArcGIS probe   | one curl against the FeatureServer (field/date confirmation)     |

## Reference note

`nexus/omni` can front any self-hosted OpenAI-compatible router to inherit a large provider
catalog with zero native driver work. Fine for dev/self-host; for production prefer native
ports (§1) over shipping the sidecar as a silent hard dependency.
