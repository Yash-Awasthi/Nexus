# NEXUS — Master Project Task Specification

> **Version:** 2.0 (supersedes v1.0)
> **Status:** Authoritative task ledger
> **Mode:** Quality-gated, milestone-based. **No calendar deadlines.** Advance only when exit criteria pass.
> **Owner:** Yash Awasthi
> **Repos absorbed:** [Workspace](https://github.com/Yash-Awasthi/workspace), [Judica](https://github.com/Yash-Awasthi/Judica), [Ghoststack](https://github.com/Yash-Awasthi/Ghoststack), [fin-scrape](https://github.com/Yash-Awasthi/fin-scrape)
> **License:** Apache-2.0 (chosen for patent grant; see ADR-0006)
> **Target:** A complete, secure, observable, plugin-extensible, open-source-grade system that a third party can install, audit, contribute to, and run in production.

---

## Reading guide

This is the **single source of truth** for NEXUS. It replaces all prior planning docs.

- Sections 1–4 are mandatory background. They prevent re-litigating decisions when fatigued.
- Section 5 lists **non-negotiable quality bars** that every milestone must respect.
- Section 6 onward is the milestone-by-milestone work plan. **You do not advance to milestone M+1 until M's exit criteria are 100% green.** Time is irrelevant; the gate is.
- Sections 17–19 are the open-source-readiness checklists, threat model, and operational runbook.

If a task is ambiguous, the rule is: **make it more rigorous, never less.**

---

## Table of contents

1.  [Truth-first repo audit](#1-truth-first-repo-audit)
2.  [Locked architectural decisions (ADRs)](#2-locked-architectural-decisions-adrs)
3.  [Final architecture](#3-final-architecture)
4.  [Naming registry](#4-naming-registry)
5.  [Non-negotiable quality bars](#5-non-negotiable-quality-bars)
6.  [M0 — Project genesis & governance](#6-m0--project-genesis--governance)
7.  [M1 — Repo skeleton & toolchain](#7-m1--repo-skeleton--toolchain)
8.  [M2 — Forensic pruning](#8-m2--forensic-pruning)
9.  [M3 — Shared substrate (DB, types, contracts)](#9-m3--shared-substrate-db-types-contracts)
10. [M4 — Sense layer (nexus-ingest service)](#10-m4--sense-layer-nexus-ingest-service)
11. [M5 — Think layer (council service)](#11-m5--think-layer-council-service)
12. [M6 — Decide layer (runtime + governance)](#12-m6--decide-layer-runtime--governance)
13. [M7 — Act layer (plugin SDK & 14 adapters)](#13-m7--act-layer-plugin-sdk--14-adapters)
14. [M8 — Vertical pipeline (signal-finance)](#14-m8--vertical-pipeline-signal-finance)
15. [M9 — Web UI, CLI, and developer surface](#15-m9--web-ui-cli-and-developer-surface)
16. [M10 — Security, audit, and compliance](#16-m10--security-audit-and-compliance)
17. [M11 — Observability, perf, and disaster recovery](#17-m11--observability-perf-and-disaster-recovery)
18. [M12 — Release engineering & v1.0.0](#18-m12--release-engineering--v100)
19. [Open-source readiness checklist](#19-open-source-readiness-checklist)
20. [Threat model](#20-threat-model)
21. [Operational runbook](#21-operational-runbook)
22. [Glossary](#22-glossary)

---

## 1. Truth-first repo audit

Performed by clone + `find` + `wc -l` + reading entry-point files. The READMEs overstate maturity in three of four repos. The audit below is what `git` actually shows.

### 1.1 Workspace (thin scaffold)

| Metric | Reality | README claim |
|---|---|---|
| TypeScript LOC | **4,279** | "production" |
| Tests | **0** | implied via CI badges |
| Agents | 18 files, **51–236 LOC each** — thin SDK wrappers around an Anthropic tool-use loop | "18-agent autonomous productivity system" |
| DB migrations | 5 SQL files, **83 LOC total** | "Neon Postgres backed" ✓ |
| `apps/dashboard` | **does not exist** | "planned" — accurate |
| Model string | hardcoded `claude-opus-4-6` in `agent-base.ts` (a hallucinated model — does not exist) | — |

**Salvage:** `packages/core/src/{agent-base,message-bus,state-store,tool-registry}.ts` (clean abstractions; *concepts* keep, code discarded), 14 third-party SDK wrappers in `packages/integrations/src/*`, Turbo + pnpm monorepo scaffold.

**Discard:** the 18 `Agent` subclasses (replaced by adapters in M7), the dev dependency on `@anthropic-ai/sdk` for direct LLM calls (replaced by the council in M5), the hardcoded `claude-opus-4-6` strings.

### 1.2 Judica (huge, partially-finished, API-first already)

| Metric | Reality | README claim |
|---|---|---|
| TS/TSX LOC | **~113,000** (src/ only, excludes frontend) | implied |
| Routes | **170 files** | "140+" — actually more |
| Services | **92 files** | "80+" ✓ |
| DB schema files | **62** Drizzle schemas | not stated |
| Migrations | **28 SQL** migrations | not stated |
| Tests | **375 spec files** | not stated |
| Provider modes | API-based via `MISTRAL_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY` (`council.service.ts:getDefaultMembers`) — **already API-first** | "browser-connected accounts" — misleading |

**Critical correction to the v1 plan:** the council is *already* API-driven. You do not "extract API mode." You wire it up. Browser injection is a secondary mode, not the default.

**Salvage:**
- `src/services/council.service.ts` + `src/lib/providers/*` + `src/lib/configResolver.ts` (the council engine).
- `src/db/schema/*` (62 Drizzle schemas — the most complete schema across all repos).
- `src/migrations/*` (28 production-grade migrations).
- `src/lib/{deepResearch,chatCompression,guardrails,scanners,standardAnswers}` (reusable libraries).
- `src/queue/` + `src/queue/workers/` (BullMQ workers).
- `src/middleware/` (rate limit, auth, request-id, request-log).
- `src/observability/` (OTel scaffolding).
- The React Router 7 frontend (after heavy pruning).

**Discard:** `src/ee/*` (enterprise stubs), `src/sandbox/*` (orphan code-exec), `src/extensions/chrome/*` (defer), Electron desktop (defer), `helm/`, `k8s/`, `wrangler.jsonc` (rebuilt), `cli/` (rebuilt as `@nexus/cli`).

### 1.3 Ghoststack (strongest engineering, contaminated by Java)

| Metric | Reality | README claim |
|---|---|---|
| TypeScript LOC | **28,246** (100% TS, not "40% TS" as v1 plan claimed) | ✓ |
| JavaScript LOC | **0** | — |
| Test spec files | **66** (likely 499 individual `it()` cases — plausible) | "499 tests / 65 suites" |
| Orchestration modules | **45+** in `orchestration/` | implied |
| Floci (Java AWS emulator) | **16 MB**, Maven project, irrelevant to finance | "FlociAdapter (LocalStack-compatible)" — irrelevant |

**Salvage (the strongest code in any of the four repos):**
- `orchestration/orchestrator.ts` — `GhostStackOrchestrator.create(opts)` factory.
- `orchestration/planning-engine.ts` — 11-blueprint planner, optional `ILanguageModel`.
- `orchestration/governance-engine.ts` + all constraints, policies, guardrails.
- `orchestration/approval-workflow.ts` — HITL gating.
- `orchestration/circuit-breaker.ts`, `runtime-graph.ts`, `task-executor.ts`, `task-router.ts`.
- `orchestration/file-queue-backend.ts` + `interfaces/queue.interface.ts`.
- `orchestration/event-bus.ts`, `memory-store.ts`, `runtime-compactor.ts`, `runtime-manager.ts`.
- `orchestration/interfaces/*` — the contract layer; this is what makes the kernel adoptable.

**Discard:** `apps/floci/` (16 MB Java), `archive/`, `runtime/docker-compose-runner.ts`, `orchestration/floci-*.ts` (10 files).

### 1.4 fin-scrape (production pipeline, duplicates Judica)

| Metric | Reality | README claim |
|---|---|---|
| Python LOC | **19,228** (~8–10k after excluding vendored Scrapling) | implied ✓ |
| Dashboard LOC | **4,847** TS/TSX (Cloudflare Workers + Durable Objects) | ✓ |
| Tests | **19** Python test files | "112+" — claim is for dashboard, plausible |
| Scrapers | 11 (Bloomberg, Reuters, CNBC, Yahoo, FT, MarketWatch, SeekingAlpha, Benzinga, Investing.com, Google News, EDGAR) | ✓ |
| HTTP service | **`scrape_server.py` already exists on :5001** (Flask) | not in README |
| Own council | **`agents/council.py` (223 LOC) — duplicates Judica** | — |
| Personas | `agents/personas.py` + `agents/market_personas.py` (726 LOC) — finance-tuned prompt library | — |

**Critical duplication:** FinScrape has its own `AgentCouncil` with weighted consensus, dissent detection, and persona-based agents. This **directly competes with Judica** and must be retired (ADR-0003).

**Salvage:**
- `finscrape/scrapers/*` (11 production scrapers).
- `finscrape/engine/scrapling/*` (vendored Scrapling v0.4.6).
- `finscrape/analysis/validator.py` + `constants.py` (heuristic scoring + 200+ keyword lexicon).
- `finscrape/edgar/*` (SEC EDGAR client).
- `finscrape/portfolio.py`, `finscrape/accuracy.py`, `finscrape/monitor.py`.
- `dashboard/workers/signals-do.ts` (Durable Object with SQLite + WebSocket — repurposed as read-cache).
- `dashboard/app/routes/home.tsx` + components (donated to the unified web app).

**Discard:** `finscrape/agents/council.py` (per ADR-0003), Flask in favour of FastAPI (M4), `dashboard.py` CLI wrapper, duplicate ticker/signal storage logic.

### 1.5 Cross-cutting findings

| Issue | Evidence | Resolution |
|---|---|---|
| **Four storage systems** | Workspace→Neon (5 thin tables), Judica→Postgres+pgvector (62 schemas, 28 migrations), Ghoststack→JSONL files, FinScrape→SQLite + Cloudflare DO | One Postgres (ADR-0002). |
| **Three model registries** | `claude-opus-4-6` (Workspace, hallucinated), `claude-3-5-sonnet-20241022` (Judica), `deepseek/deepseek-chat` (FinScrape) | One registry in `@nexus/shared/models.ts`. |
| **Three event buses** | Workspace `MessageBus`, Ghoststack `EventBus`, FinScrape Python events | Ghoststack `IEventBus` wins (ADR-0007). |
| **Two councils** | Judica + FinScrape | Judica wins (ADR-0003). |
| **Two queues** | Judica BullMQ workers, Ghoststack `FileQueueBackend` | Ghoststack `IQueueBackend` interface; default = BullMQ-on-Redis; JSONL for offline dev. |
| **Floci is dead weight** | 16 MB Java AWS emulator, no finance use case | Delete (ADR-0001). |
| **Workspace has 0 tests** | `find … -name '*.test.ts' → 0` | Adapter tests written *alongside* conversion (M7), not deferred. |
| **Hallucinated model string** | Workspace's `claude-opus-4-6` does not exist on any provider | Deleted; the model registry validates strings at build time. |

---

## 2. Locked architectural decisions (ADRs)

These are committed in `docs/adr/` and cannot be changed without writing a superseding ADR.

| ADR | Title | Outcome |
|---|---|---|
| 0001 | Kill Floci | The 16 MB Java AWS emulator is deleted. NEXUS is finance, not cloud emulation. |
| 0002 | Postgres as sole state | One PG16+pgvector cluster. JSONL kept as `--backend=file` for offline dev only. |
| 0003 | Council deduplication | Judica is the only council. FinScrape personas become JSON prompt presets. |
| 0004 | TS/Python boundary | OpenAPI is source of truth. zod (TS) + pydantic (Py) generated from same spec. Schemathesis property-tests both sides. |
| 0005 | Naming registry | See Section 4. |
| 0006 | License = Apache-2.0 | Explicit patent grant; compatible with all four upstream MIT repos. |
| 0007 | EventBus from Ghoststack wins | Workspace `MessageBus` retired. |
| 0008 | Plugin SDK is first-class | Third-party adapters are a supported contract, not a hack. Stable across minor versions. |
| 0009 | Versioned API (`/v1/…`) | API surface gets a version prefix from day one. Deprecation policy = 2 minor versions. |
| 0010 | Audit log is HMAC-chained | Every governance decision is signed and append-only; chain verified on export. |
| 0011 | Telemetry opt-out by default | Zero phone-home unless `NEXUS_TELEMETRY=1`. Privacy is default. |
| 0012 | Reproducible builds | Pin Node 20 LTS, Python 3.11, pnpm 9. Docker = distroless. Cosign-sign all release artefacts. |
| 0013 | Conventional Commits + changesets | Automated semver, automated changelog. |
| 0014 | i18n-ready strings | All user-facing strings extracted to message catalogues; en-US ships v1.0.0; community-driven other locales. |
| 0015 | A11y target = WCAG 2.1 AA | Axe in CI; manual screen-reader pass before each minor release. |
| 0016 | Data residency + retention | Per-workspace retention policy; right-to-deletion automated; encrypted-at-rest. |
| 0017 | Mandatory code coverage 80% | CI blocks PRs that lower coverage below the floor. Adapters exempt only for thin SDK passthroughs (documented). |
| 0018 | Pinned base images, no `latest` tags | All `FROM` directives reference SHA256 digests; renovate-bot auto-PRs upgrades. |

Each ADR is a 1-page markdown file in `docs/adr/NNNN-title.md` following [adr-tools](https://github.com/npryce/adr-tools) format (Status / Context / Decision / Consequences).

---

## 3. Final architecture

### 3.1 Sense → Think → Decide → Act

```
SENSE              THINK               DECIDE              ACT
─────              ─────               ──────              ───
nexus-ingest       @nexus/council      @nexus/runtime      @nexus/adapters/*
(Python FastAPI)   (TS in-process)     (TS in-process)     (TS in-process via
                                                            IExecutionAdapter)
```

All TS components live in one Node process (or share one Redis-backed cluster). Python is the only cross-language boundary, deliberately isolated.

### 3.2 Monorepo layout (canonical)

```
nexus/
├─ apps/
│  ├─ api/                  # @nexus/api          — Fastify HTTP/WebSocket gateway
│  ├─ worker/               # @nexus/worker       — BullMQ queue consumers
│  ├─ web/                  # @nexus/web          — React Router 7 SPA
│  ├─ cli/                  # @nexus/cli          — npx nexus (CLI client)
│  └─ docs-site/            # @nexus/docs         — Docusaurus / Nextra site
├─ packages/
│  ├─ runtime/              # @nexus/runtime      — kernel (ex-Ghoststack)
│  ├─ council/              # @nexus/council      — deliberation engine (ex-Judica)
│  ├─ governance/           # @nexus/governance   — policies, guardrails (split from runtime)
│  ├─ db/                   # @nexus/db           — Drizzle schemas + migrations
│  ├─ memory/               # @nexus/memory       — pgvector + RAG
│  ├─ auth/                 # @nexus/auth         — better-auth integration
│  ├─ shared/               # @nexus/shared       — zod schemas, types, model registry
│  ├─ contracts/            # @nexus/contracts    — OpenAPI specs + generated clients
│  ├─ plugin-sdk/           # @nexus/plugin-sdk   — adapter author kit
│  ├─ pipeline-signal/      # @nexus/pipeline-signal — generalised ingest→verdict pipeline
│  ├─ telemetry/            # @nexus/telemetry    — OTel wrappers, log helpers
│  └─ adapters/
│     ├─ slack/             # @nexus/adapter-slack
│     ├─ github/
│     ├─ linear/
│     ├─ gmail/
│     ├─ calendar/
│     ├─ drive/
│     ├─ neon/
│     ├─ supabase/
│     ├─ vercel/
│     ├─ cloudflare/
│     ├─ doppler/
│     ├─ betterstack/
│     ├─ groq/
│     ├─ tavily/
│     ├─ ingest/            # bridge → Python nexus-ingest
│     └─ council/           # bridge → @nexus/council as ILanguageModel
├─ services/
│  └─ ingest/               # nexus-ingest — Python FastAPI service
│     ├─ pyproject.toml
│     ├─ src/nexus_ingest/
│     │  ├─ api.py
│     │  ├─ scrapers/       # ← finscrape/scrapers
│     │  ├─ analysis/       # ← finscrape/analysis
│     │  ├─ edgar/          # ← finscrape/edgar
│     │  ├─ engine/         # ← finscrape/engine (vendored Scrapling)
│     │  └─ contracts/      # ← pydantic models generated from OpenAPI
│     └─ tests/
├─ contracts/
│  ├─ openapi/
│  │  ├─ nexus-api.yaml     # public REST API
│  │  └─ nexus-ingest.yaml  # internal Py↔TS contract
│  ├─ asyncapi/
│  │  └─ nexus-events.yaml  # event bus schemas
│  └─ jsonschema/
│     └─ workflow-spec.json # workflow DSL schema
├─ infra/
│  ├─ docker/
│  │  ├─ docker-compose.yml
│  │  ├─ docker-compose.dev.yml
│  │  └─ Dockerfile.*       # per-service distroless images
│  ├─ helm/                 # @nexus/helm chart
│  ├─ terraform/            # @nexus/tf module (GCP + AWS + Fly examples)
│  └─ k8s/                  # raw manifests
├─ scripts/
│  ├─ prune/                # M2 forensic-pruning scripts
│  ├─ migrate-finscrape-personas.ts
│  ├─ seed-dev.ts
│  └─ generate-clients.ts   # OpenAPI → TS + Python
├─ docs/
│  ├─ adr/                  # Architecture Decision Records
│  ├─ runbook.md
│  ├─ architecture.md
│  ├─ contributing/
│  ├─ security/
│  │  └─ threat-model.md
│  └─ plugin-author-guide.md
├─ .github/
│  ├─ workflows/            # CI: lint, test, build, security, release
│  ├─ ISSUE_TEMPLATE/
│  └─ PULL_REQUEST_TEMPLATE.md
├─ CHANGELOG.md
├─ CODE_OF_CONDUCT.md
├─ CONTRIBUTING.md
├─ GOVERNANCE.md
├─ LICENSE                  # Apache-2.0
├─ MAINTAINERS.md
├─ NOTICE
├─ README.md
├─ SECURITY.md
├─ package.json
├─ pnpm-workspace.yaml
├─ turbo.json
└─ tsconfig.base.json
```

### 3.3 End-to-end data flow (one signal)

1.  `nexus-ingest` scrapes a Reuters article via Scrapling.
2.  Pydantic-validates the payload, POSTs `IngestedEvent` → `@nexus/api` `/v1/ingest`.
3.  Fastify zod-validates the same payload (both schemas generated from the same OpenAPI spec).
4.  API persists to `ingested_events`; emits `nexus.signal.raw` on Redis pub/sub (AsyncAPI-typed).
5.  `@nexus/worker` consumes the event, runs `@nexus/pipeline-signal` stages: validate → extract tickers → heuristic-score → council deliberate.
6.  `@nexus/council` deliberates across 4 providers in parallel with a finance persona preset, returns verdict + transcript.
7.  Worker submits a task graph to `@nexus/runtime` (`planner → governance → approval → executor`).
8.  Runtime planner produces task graph; governance engine runs constraints, policies, guardrails.
9.  If verdict ∈ {INVEST, PULL_OUT} ∧ score ≥ 4, `ApprovalWorkflow` blocks pending HITL.
10. User approves in `@nexus/web` (or rejects via `nexus approval reject`).
11. Approved tasks dispatch to adapters: `slack` (#signals), `linear` (ticket), `gmail` (portfolio subscribers).
12. Each adapter execution writes an immutable, HMAC-chained audit log row.
13. `@nexus/api` WebSocket pushes update to `@nexus/web` and the Cloudflare DO read-cache.

### 3.4 Tech stack (locked)

| Layer | Tech | Rationale |
|---|---|---|
| Languages | TypeScript 5.4+ strict, Python 3.11 | one TS toolchain, Py only for scraping |
| Node | 20 LTS | predictable security window |
| Package mgr | pnpm 9 + Turborepo | from Workspace's existing scaffold |
| HTTP | Fastify 4 + `@fastify/type-provider-typebox` | from Judica |
| Validation | zod 3 (TS), pydantic v2 (Py), both generated from OpenAPI | ADR-0004 |
| ORM | Drizzle | from Judica |
| Queue | BullMQ 5 on Redis 7 | from Judica |
| DB | Postgres 16 + pgvector + pgcrypto | from Judica |
| Auth | better-auth | active maintenance; OAuth + email + 2FA |
| Object store | MinIO (dev) / S3-compat (prod) | open |
| Cache + pub/sub | Redis 7 | unified |
| Frontend | React Router 7 + Vite + Tailwind 4 + shadcn/ui + Storybook | Judica + FinScrape |
| Test (TS) | Vitest + Playwright + Schemathesis (Py) | from Judica |
| Test (Py) | pytest + hypothesis (property-based) + Schemathesis | from FinScrape |
| Container | Docker (distroless or chiseled), pinned by SHA256 | ADR-0012 |
| Orchestration | docker-compose (dev), Helm (k8s), Terraform module (cloud) | M12 |
| CI | GitHub Actions | de facto standard |
| Observability | OpenTelemetry + Prometheus + Grafana + Tempo + Loki | Judica + Ghoststack |
| Security | gitleaks, CodeQL, Trivy, Dependabot, Renovate, cosign, syft (SBOM) | M10 |
| Release | changesets | ADR-0013 |
| Docs | Docusaurus 3 + ADR | clean static docs |

---

## 4. Naming registry

| Concept | Canonical name | Notes |
|---|---|---|
| Master project | **NEXUS** | branded |
| Root package | `@nexus/root` | non-published; private workspace root |
| Runtime kernel | `@nexus/runtime` | ex-Ghoststack `orchestration/` |
| Council engine | `@nexus/council` | ex-Judica `council.service.ts` |
| Governance | `@nexus/governance` | extracted from runtime |
| DB | `@nexus/db` | Drizzle schemas + migrations |
| Memory | `@nexus/memory` | pgvector RAG |
| Auth | `@nexus/auth` | better-auth wrapper |
| Shared types | `@nexus/shared` | zod + types + model registry |
| Contracts | `@nexus/contracts` | OpenAPI + AsyncAPI + JSON Schema |
| Plugin SDK | `@nexus/plugin-sdk` | published; third-party adapters target this |
| Pipelines | `@nexus/pipeline-signal` | generalised pattern |
| Telemetry | `@nexus/telemetry` | OTel wrappers |
| API | `@nexus/api` | Fastify gateway |
| Worker | `@nexus/worker` | queue consumers |
| Web | `@nexus/web` | SPA |
| CLI | `@nexus/cli` | shipped as `nexus` binary |
| Adapters | `@nexus/adapter-<name>` | 14 first-party adapters |
| Ingest (Py) | `nexus-ingest` | FastAPI service |
| Helm chart | `@nexus/helm` | OCI-published |
| TF module | `nexus-tf` | Terraform registry |

API version path: `/v1/…` from day one (ADR-0009).

---

## 5. Non-negotiable quality bars

Every milestone respects these. CI blocks PRs that violate any of them.

| Bar | Requirement |
|---|---|
| **Coverage** | ≥ 80% line coverage on every published package; ≥ 90% on `governance`, `runtime`, `council`, `auth`. (ADR-0017) |
| **Types** | TypeScript strict, no `any` without `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reason`. Python `mypy --strict`. |
| **Contracts** | Every TS↔Py call uses generated clients. CI fails if generated code drifts from the OpenAPI source. |
| **Security** | gitleaks, CodeQL, Trivy, Dependabot, Renovate all green on `main`. No `latest` Docker tags (ADR-0018). |
| **Tests at boundary** | Schemathesis property-tests both API + ingest endpoints on every push. |
| **Docs** | Every public symbol has TSDoc / docstring. `pnpm docs:check` fails on missing JSDoc for exported functions. |
| **A11y** | `pnpm test:a11y` (Axe) on each page route. WCAG 2.1 AA. (ADR-0015) |
| **Reproducible builds** | `pnpm install --frozen-lockfile` succeeds. Docker images pinned to SHA256. (ADR-0012) |
| **Commit hygiene** | Conventional Commits enforced via `commitlint`. PR title = release-note candidate. (ADR-0013) |
| **Changesets** | Every PR that touches `packages/*` must include a changeset or be marked `--no-version`. |
| **Audit log** | Every governance decision is HMAC-chained + verifiable. (ADR-0010) |
| **Telemetry** | OFF by default; explicit opt-in. (ADR-0011) |
| **i18n** | No hard-coded user-facing strings outside `app/messages/*.json`. (ADR-0014) |
| **License headers** | `apache-license-checker` on `main`; every source file carries SPDX header. |
| **SBOM** | `syft` generates CycloneDX SBOM on every release; published as a GitHub release artefact. |
| **Signed releases** | `cosign` signs every Docker image + GitHub release. Public key in `SECURITY.md`. |

---

## 6. M0 — Project genesis & governance

> **Definition:** The repo exists, the licence is set, the rules are written, and any external contributor can find their feet.
> **Entry criteria:** none.

### 6.1 Tasks

- `[M0-1]` **Create the public GitHub repo `yash-awasthi/nexus`**
  - Files: branch protection (require PR, require 1 review, require all checks passing, no force-push, no delete), default branch `main`, GitHub Discussions enabled, Issues enabled, Security tab populated.
  - Acceptance: branch protection visible in Settings; signed commits required (gh CLI: `gh api … -F required_signatures=true`).
  - Hours: 1.

- `[M0-2]` **Add `LICENSE`, `NOTICE`, `CODE_OF_CONDUCT.md`**
  - Files: `LICENSE` = Apache-2.0 verbatim; `NOTICE` lists upstream attributions for Workspace, Judica, Ghoststack, fin-scrape (all MIT-compatible with Apache-2.0); `CODE_OF_CONDUCT.md` = Contributor Covenant v2.1.
  - Acceptance: `apache-license-checker --license-text-only LICENSE` passes; `NOTICE` cites the four repos with their MIT licences quoted in full.
  - Hours: 1.

- `[M0-3]` **Author `CONTRIBUTING.md`**
  - Files: contains DCO sign-off requirement, how to run locally, how to add a changeset, how to write a test, how to add an ADR, link to plugin author guide.
  - Acceptance: a stranger can clone, build, and submit a PR by following only `CONTRIBUTING.md`.
  - Hours: 4.

- `[M0-4]` **Author `GOVERNANCE.md` and `MAINTAINERS.md`**
  - Files: governance model (BDFL initially with a defined path to lazy consensus); maintainer list (initially: Yash + alts).
  - Acceptance: doc explains how decisions are made, how PRs are reviewed, how releases happen.
  - Hours: 3.

- `[M0-5]` **Author `SECURITY.md`**
  - Files: vulnerability disclosure policy, contact email (PGP key), 90-day patch policy, list of supported versions, cosign public key.
  - Acceptance: linked from repo Security tab; private vulnerability reporting enabled.
  - Hours: 2.

- `[M0-6]` **Issue + PR templates**
  - Files: `.github/ISSUE_TEMPLATE/{bug.yml,feature.yml,adapter-proposal.yml,security.yml}`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/DISCUSSION_TEMPLATE/{q-and-a.yml,ideas.yml}`.
  - Acceptance: filing a new issue offers structured choice; PR template asks for changeset, tests, docs.
  - Hours: 3.

- `[M0-7]` **Write ADR-0001 through ADR-0018**
  - Files: `docs/adr/0001-kill-floci.md` … `docs/adr/0018-pinned-base-images.md`.
  - Acceptance: 18 markdown files, each ≤ 1 page, following adr-tools format (Status / Context / Decision / Consequences). Every other section of NEXUS.md references the appropriate ADR.
  - Hours: 18 (1h each).

- `[M0-8]` **Bootstrap CI baseline**
  - Files: `.github/workflows/{lint.yml, dco.yml, conventional-commits.yml}`. Pre-commit hooks via `husky` + `lint-staged` (commitlint, prettier --check, eslint --quiet, gitleaks pre-commit).
  - Acceptance: a PR without DCO sign-off, or with a non-conventional commit, fails CI.
  - Hours: 4.

### 6.2 Exit criteria (do not advance unless ALL are true)

- ☐ Repo public, branch-protected, signed-commit enforced.
- ☐ LICENSE = Apache-2.0; NOTICE attributes the four upstream MIT repos.
- ☐ All 18 ADRs written.
- ☐ A stranger can submit a PR from `CONTRIBUTING.md` alone.
- ☐ CI rejects unsigned, unconventional, or DCO-missing PRs.

---

## 7. M1 — Repo skeleton & toolchain

> **Definition:** The monorepo builds an empty universe. No business logic. Just the rails.
> **Entry criteria:** M0 complete.

### 7.1 Tasks

- `[M1-1]` **Bootstrap pnpm + Turborepo**
  - Files: `package.json` (private, scripts: `build, dev, lint, test, typecheck, format, clean, docs:check, sbom, prune:report`), `pnpm-workspace.yaml`, `turbo.json` (pipelines: `build`, `lint`, `test`, `typecheck`, `docs:check`), `.nvmrc` = `20.18.0`, `.npmrc` (pin registry, strict-peer-dependencies), `.gitignore`.
  - Acceptance: `pnpm install` clean; `pnpm typecheck` succeeds on empty packages.
  - Hours: 3.

- `[M1-2]` **Root tsconfig + per-package tsconfig**
  - Files: `tsconfig.base.json` (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, ESNext modules, Bundler resolution), each `packages/*/tsconfig.json` extends base.
  - Acceptance: every package's `pnpm typecheck` passes with zero errors.
  - Hours: 4.

- `[M1-3]` **Linting + formatting**
  - Files: `eslint.config.js` (flat config, `@typescript-eslint`, `eslint-plugin-import`, `eslint-plugin-promise`, `eslint-plugin-vitest`, `eslint-plugin-jsx-a11y`), `.prettierrc`, `.editorconfig`.
  - Acceptance: `pnpm lint` zero errors / zero warnings; `pnpm format:check` passes.
  - Hours: 4.

- `[M1-4]` **Conventional Commits + changesets**
  - Files: `commitlint.config.js`, `.changeset/config.json` (mode: "single fixed version per minor"), `.husky/{pre-commit,commit-msg}`.
  - Acceptance: a non-conformant commit message is rejected locally and in CI.
  - Hours: 2.

- `[M1-5]` **Skeleton packages**
  - Files: create empty `packages/{runtime,council,governance,db,memory,auth,shared,contracts,plugin-sdk,pipeline-signal,telemetry}` + each adapter dir + `apps/{api,worker,web,cli,docs-site}`. Every package has its own `package.json`, `tsconfig.json`, `src/index.ts` (empty export), `README.md` (purpose + status).
  - Acceptance: `pnpm build` builds every package to its `dist/`; `pnpm test` runs (no tests yet — exits 0 with `--passWithNoTests`).
  - Hours: 6.

- `[M1-6]` **CI: build matrix**
  - Files: `.github/workflows/build.yml` (Node 20 + 22 matrix, ubuntu-latest + macos-latest), `.github/workflows/test.yml`, `.github/workflows/typecheck.yml`.
  - Acceptance: PRs run all three; merge blocked on failure.
  - Hours: 4.

- `[M1-7]` **Repo-wide Vitest + Playwright + Storybook configs**
  - Files: `vitest.config.ts` at root (workspace projects), `playwright.config.ts` (e2e), `apps/web/.storybook/`.
  - Acceptance: `pnpm test:unit`, `pnpm test:e2e --dry-run`, `pnpm storybook` all boot.
  - Hours: 4.

- `[M1-8]` **`@nexus/shared` — model registry + base types**
  - Files: `packages/shared/src/{models.ts,errors.ts,zod/{event.ts,signal.ts,verdict.ts,task.ts,plan.ts,approval.ts,adapter-result.ts,workflow-spec.ts}.ts,types/*}`.
  - `models.ts` exports `MODEL_REGISTRY` with real, currently-available model identifiers (e.g. `anthropic/claude-3-5-sonnet-20241022`, `openai/gpt-4o-2024-08-06`, `google/gemini-2.0-flash-001`, `groq/llama-3.3-70b-versatile`, `mistral/mistral-large-latest`), token limits, pricing, capabilities. Validated by a unit test against each provider's pricing page (URL recorded as comment).
  - Acceptance: 100% test coverage; type-level test that `MODEL_REGISTRY` keys are a literal union.
  - Hours: 6.

- `[M1-9]` **DCO + signed commits enforcement**
  - Files: `.github/workflows/dco.yml`, `.github/workflows/signed-commits.yml`.
  - Acceptance: PRs without DCO sign-off or signed commits fail CI.
  - Hours: 2.

- `[M1-10]` **License header check**
  - Files: `scripts/check-license-headers.ts` — every `.ts`, `.tsx`, `.py`, `.sql` file starts with `// SPDX-License-Identifier: Apache-2.0`.
  - Acceptance: CI step `pnpm check:headers` blocks merges missing the header.
  - Hours: 3.

### 7.2 Exit criteria

- ☐ `pnpm install && pnpm build && pnpm test && pnpm lint && pnpm typecheck` all green on a fresh clone.
- ☐ All packages skeletal but present; CI builds them on every PR.
- ☐ `@nexus/shared` model registry shipped; covered by tests.
- ☐ Conventional-Commits + DCO + signed-commits + license-headers all enforced.

---

## 8. M2 — Forensic pruning

> **Definition:** Every line of imported upstream code is either kept (with reason) or deleted (with evidence). No code enters the tree without justification.
> **Entry criteria:** M1 complete.

### 8.1 The pruning toolchain

This is a dedicated milestone because the reviewer was right: pruning 113k LOC of Judica + 28k LOC of Ghoststack + 4k LOC of Workspace + 19k LOC of FinScrape is *not* a side-effect of importing them.

Tools mandated:
- `knip` — finds unused files, exports, dependencies.
- `ts-prune` — finds unused TypeScript exports.
- `depcheck` — finds unused npm dependencies.
- `madge` — produces module dependency graphs + cyclic-import detection.
- `vulture` (Python) — finds unused Python code.
- `coverage` analysis under integration tests — confirms a code path is actually exercised.

### 8.2 Tasks

- `[M2-1]` **Add upstream repos as `git subtree`s under `vendor/`**
  - Why: preserves provenance. Every commit retains attribution.
  - Files: `git subtree add --prefix=vendor/workspace https://github.com/Yash-Awasthi/workspace.git main --squash` (and similarly for the three others, **with their last-known-good SHA pinned**).
  - Acceptance: `git log vendor/workspace` shows upstream history flattened to a single squash commit; future syncs use `git subtree pull`.
  - Hours: 2.

- `[M2-2]` **Knip + ts-prune + depcheck baseline**
  - Files: `knip.json` (config), `package.json` scripts (`prune:knip`, `prune:ts-prune`, `prune:depcheck`, `prune:madge`).
  - Run on `vendor/judica/`, `vendor/ghoststack/`, `vendor/workspace/`.
  - Acceptance: report files dropped into `docs/audit/M2-pruning-{judica,ghoststack,workspace}.md`. Each lists unused files, exports, dependencies.
  - Hours: 6.

- `[M2-3]` **Judica forensic prune**
  - Inputs: M2-2 reports.
  - Tasks: for every file in `vendor/judica/src/`, mark KEEP / MOVE / DELETE in a spreadsheet (`docs/audit/M2-judica-decisions.csv`). MOVE rows specify the destination `packages/*` directory.
  - Acceptance: spreadsheet 100% filled. Sum of MOVE bytes ≈ council + DB schemas + middleware + queue + observability + relevant libs. Sum of DELETE bytes ≥ 60% of the original.
  - Hours: 16 (this is the biggest single task; do not rush).

- `[M2-4]` **Ghoststack forensic prune**
  - Same procedure for Ghoststack. Floci is auto-DELETE (ADR-0001).
  - Acceptance: `docs/audit/M2-ghoststack-decisions.csv`. MOVE targets `packages/runtime/`, `packages/governance/`, `packages/telemetry/`.
  - Hours: 10.

- `[M2-5]` **Workspace forensic prune**
  - Workspace is the smallest. The 18 agent classes are auto-DELETE; the 14 integration packages are auto-MOVE to `packages/adapters/*`; `core/` is auto-DELETE in favour of `@nexus/runtime`'s EventBus.
  - Acceptance: `docs/audit/M2-workspace-decisions.csv`.
  - Hours: 4.

- `[M2-6]` **FinScrape forensic prune**
  - `vulture` over the Python tree. Council + `dashboard.py` CLI + market personas (extracted as JSON in M5) are DELETE; scrapers + analysis + EDGAR + storage + monitor are MOVE; vendored Scrapling is MOVE-as-is.
  - Acceptance: `docs/audit/M2-finscrape-decisions.csv`.
  - Hours: 6.

- `[M2-7]` **Execute MOVE decisions**
  - Files: `scripts/prune/execute-moves.ts` — reads the four CSVs, performs `git mv` per row, updates imports.
  - Acceptance: post-execute, `pnpm build` succeeds (likely with many broken imports — those are fixed in M3..M7); but the file tree matches the target layout.
  - Hours: 12.

- `[M2-8]` **Execute DELETE decisions**
  - Files: `scripts/prune/execute-deletes.ts` — removes everything marked DELETE from `vendor/`. Floci goes here. `vendor/` is then deleted itself; we keep history through the squash subtree commits.
  - Acceptance: `vendor/` no longer exists; repo size shrinks by ≥ 60%.
  - Hours: 4.

- `[M2-9]` **Dead-code report (post-prune)**
  - Re-run knip + ts-prune + vulture. Output `docs/audit/M2-post-prune-report.md`.
  - Acceptance: report shows < 100 unused exports + 0 unused files; remaining items justified inline.
  - Hours: 4.

- `[M2-10]` **Madge cyclic-import report**
  - Files: `docs/audit/M2-cycles.md`.
  - Acceptance: 0 cyclic imports across `packages/*` and `apps/*`.
  - Hours: 3.

### 8.3 Exit criteria

- ☐ All four decision CSVs committed under `docs/audit/`.
- ☐ Every retained file has a corresponding KEEP/MOVE row with rationale.
- ☐ `vendor/` deleted.
- ☐ Post-prune dead-code report < 100 unused exports, 0 unused files.
- ☐ 0 cyclic imports.
- ☐ `pnpm build` succeeds (with stubs/exceptions documented per package).

---

## 9. M3 — Shared substrate (DB, types, contracts)

> **Definition:** One DB, one queue, one set of generated clients, end-to-end type safety.
> **Entry criteria:** M2 complete.

### 9.1 Tasks

- `[M3-1]` **Author OpenAPI 3.1 specs**
  - Files: `contracts/openapi/nexus-api.yaml` (public API: `/v1/health`, `/v1/ingest`, `/v1/council/*`, `/v1/runtime/*`, `/v1/signals/*`, `/v1/approvals/*`, `/v1/adapters/*`, `/v1/auth/*`).
  - Files: `contracts/openapi/nexus-ingest.yaml` (internal: `/scrape`, `/scrape/{job_id}`, `/analyze`, `/health`).
  - Acceptance: both specs lint clean with `redocly lint`; example requests/responses for every operation; security schemes declared (JWT, API-key).
  - Hours: 16.

- `[M3-2]` **AsyncAPI event spec**
  - Files: `contracts/asyncapi/nexus-events.yaml` — every Redis pub/sub channel + payload schema (`nexus.signal.raw`, `nexus.signal.scored`, `nexus.verdict.ready`, `nexus.task.queued`, `nexus.adapter.executed`, `nexus.approval.requested`, `nexus.approval.resolved`).
  - Acceptance: `asyncapi validate` passes; rendered HTML committed in `docs-site/`.
  - Hours: 6.

- `[M3-3]` **Workflow-spec JSON Schema**
  - Files: `contracts/jsonschema/workflow-spec.json` v1.1 — based on Ghoststack's spec; validated by ajv at runtime.
  - Acceptance: a sample spec parses; an invalid spec fails with a useful error.
  - Hours: 4.

- `[M3-4]` **Code generation pipeline**
  - Files: `scripts/generate-clients.ts`. Runs:
    - `openapi-typescript` → `packages/contracts/src/api.gen.ts`, `packages/contracts/src/ingest.gen.ts`.
    - `datamodel-code-generator` (pydantic v2) → `services/ingest/src/nexus_ingest/contracts/`.
    - `@asyncapi/generator` → `packages/contracts/src/events.gen.ts`.
    - `json-schema-to-typescript` → `packages/contracts/src/workflow-spec.gen.ts`.
  - Acceptance: `pnpm generate` produces all four; CI step verifies generated files are checked in and match (`git diff --exit-code`).
  - Hours: 8.

- `[M3-5]` **`@nexus/contracts` package wired**
  - Files: `packages/contracts/src/index.ts` re-exports the four generated modules + manual zod schemas that mirror them (for runtime validation).
  - Acceptance: a unit test imports a generated type and validates a sample payload against the zod equivalent — round-trip clean.
  - Hours: 6.

- `[M3-6]` **DB unified schema**
  - Files: `packages/db/src/schema/*` consolidated. New schemas added in `packages/db/src/schema/nexus.ts`: `ingested_events`, `signals`, `verdicts`, `council_transcripts`, `runtime_tasks`, `runtime_events`, `approval_requests`, `adapter_executions`, `signal_actions`, `audit_log` (HMAC-chained), `workspaces`, `workspace_members`, `api_keys`.
  - Acceptance: `pnpm db:generate` emits one new migration; on a fresh PG16 `pnpm db:migrate` applies all 28 (Judica) + new ones cleanly.
  - Hours: 14.

- `[M3-7]` **Audit log HMAC chain**
  - Files: `packages/db/src/audit.ts`. Implements `appendAudit({event, payload})` which: computes `hmac = HMAC_SHA256(secret, prev_hash || canonical_json(payload))`; inserts row with `(prev_hash, hash, event, payload, ts)`. `verifyAuditChain(workspaceId)` walks the chain and reports tampering.
  - Acceptance: a test inserts 1000 events, tampers with one row, `verifyAuditChain` correctly identifies the tampered index.
  - Hours: 8.

- `[M3-8]` **Migration tests**
  - Files: `packages/db/tests/migrations.test.ts`. Boots an ephemeral PG container, runs all migrations forward + backward (where reversible); checks foreign keys, indexes present.
  - Acceptance: green in CI.
  - Hours: 6.

- `[M3-9]` **Queue substrate**
  - Files: `packages/runtime/src/{redis-queue-backend.ts, postgres-event-store.ts, postgres-runtime-persistence.ts}`. Implements `IQueueBackend`, `IEventStore`, `IRuntimePersistence` on Redis + Postgres. Keep file-backed implementations behind `--backend=file` for offline dev.
  - Acceptance: existing Ghoststack tests pass against the new backends; new tests verify priority ordering, DLQ semantics, crash recovery (kill -9 worker, restart, in-flight task either completes or DLQs).
  - Hours: 20.

- `[M3-10]` **Property-based boundary tests**
  - Files: `services/ingest/tests/test_boundary.py` (hypothesis), `packages/contracts/tests/boundary.test.ts` (fast-check).
  - Strategy: zod and pydantic schemas should accept exactly the same payloads. Use Schemathesis to fuzz both endpoints and assert behavioural equivalence.
  - Acceptance: 10k randomised payloads, 0 schema mismatch errors.
  - Hours: 10.

### 9.2 Exit criteria

- ☐ OpenAPI + AsyncAPI + JSON Schema all linted, committed.
- ☐ Code generation deterministic; CI fails on drift.
- ☐ All migrations apply cleanly on a fresh PG16.
- ☐ Audit log HMAC chain implementation + tamper-detection test passes.
- ☐ Redis queue passes all Ghoststack tests + new crash-recovery tests.
- ☐ Property-based boundary tests pass with 10k cases.

---

## 10. M4 — Sense layer (nexus-ingest service)

> **Definition:** A FastAPI service that wraps FinScrape's scrapers + analysis, conforms to the OpenAPI contract, runs in Docker, and is contract-tested.
> **Entry criteria:** M3 complete.

### 10.1 Tasks

- `[M4-1]` **Rebuild `services/ingest` skeleton (FastAPI)**
  - Files: `services/ingest/pyproject.toml` (PEP 621, ruff, mypy --strict, pytest, hypothesis, Schemathesis); `services/ingest/src/nexus_ingest/{__init__,api,settings,logging,observability}.py`; `services/ingest/Dockerfile` (distroless Python 3.11 base, pinned SHA).
  - Acceptance: `uvicorn nexus_ingest.api:app --port 5001` boots; `/health` returns 200; `pytest -q` runs (no tests yet).
  - Hours: 8.

- `[M4-2]` **Migrate FinScrape scrapers**
  - Files: copy 11 scrapers from M2 MOVE into `services/ingest/src/nexus_ingest/scrapers/`. Vendored Scrapling stays.
  - Acceptance: each scraper has a smoke test that hits its target site (or a recorded VCR cassette) and returns ≥ 1 article. CI uses VCR-mode for determinism.
  - Hours: 14 (1.3h × 11 scrapers).

- `[M4-3]` **Migrate analysis + EDGAR + storage**
  - Files: M2 MOVE files into `services/ingest/src/nexus_ingest/{analysis,edgar,storage}/`. Switch storage from SQLite to Postgres (via `psycopg[binary]`).
  - Acceptance: existing 19 FinScrape pytest tests pass; new tests cover storage write/read.
  - Hours: 12.

- `[M4-4]` **Wire endpoints**
  - Files: `nexus_ingest/api.py` implements:
    - `POST /scrape` — body `{source, age_hours?, limit?, ticker?}` → returns `{job_id}`.
    - `GET /scrape/{job_id}` → status + events.
    - `POST /analyze` — body `{title, text, metadata}` → heuristic score (no council; council lives in TS).
    - `GET /health` → `{ok: true, version, postgres: 'up'|'down', redis: 'up'|'down'}`.
  - Acceptance: Schemathesis fuzzes all four; all green.
  - Hours: 10.

- `[M4-5]` **Push to NEXUS API**
  - Files: `nexus_ingest/sink.py` — every completed scrape POSTs `IngestedEvent[]` to `@nexus/api` `/v1/ingest`. Uses generated TS-side client schema (same OpenAPI) for symmetry.
  - Acceptance: an end-to-end test starts ingest + API + Postgres + Redis via docker-compose, triggers a scrape, asserts the events land in `ingested_events`.
  - Hours: 8.

- `[M4-6]` **Observability in Python**
  - Files: `nexus_ingest/observability.py` — OTel tracer + Prometheus client. Every endpoint instruments span + counter + histogram.
  - Acceptance: traces reach Tempo via OTLP; metrics on `:9464/metrics`.
  - Hours: 8.

- `[M4-7]` **Python contract tests via Schemathesis**
  - Files: `services/ingest/tests/test_contract.py`.
  - Acceptance: Schemathesis discovers the FastAPI spec, fuzzes 100 cases per endpoint, all pass.
  - Hours: 6.

- `[M4-8]` **Scrapers robustness pass**
  - Per scraper: identify a failure mode (HTML structure change). Add a structural assertion (CSS selector + minimum field count). On failure → raise typed `ScraperBrokenError`, surface in `/health` payload as degraded.
  - Acceptance: deliberately break a selector; integration test catches it; `/health` returns degraded status.
  - Hours: 12.

### 10.2 Exit criteria

- ☐ `docker compose up ingest` boots; Schemathesis green.
- ☐ All 11 scrapers have VCR cassettes + structural assertions + smoke tests.
- ☐ End-to-end ingest → API → Postgres happy-path test passes.
- ☐ OTel traces + Prometheus metrics live.

---

## 11. M5 — Think layer (council service)

> **Definition:** A multi-provider council with persona presets, deterministic verdict synthesis, and a streamed API.
> **Entry criteria:** M3 complete (M4 not required).

### 11.1 Tasks

- `[M5-1]` **Migrate Judica council code**
  - Files: M2 MOVE — `packages/council/src/{council.service.ts, providers/*, configResolver.ts, types.ts}`.
  - Acceptance: package builds, type-checks, basic instantiation test passes.
  - Hours: 8.

- `[M5-2]` **Provider abstraction (`ILanguageModel`)**
  - Files: `packages/council/src/providers/base.ts` — single interface; each provider (Anthropic, OpenAI, Google, Groq, Mistral) implements it. Streaming (`generateStream`) + non-streaming (`generate`) + structured output (`generateObject`).
  - Acceptance: contract test runs the same prompt against all 5 providers (mocked in CI, real in nightly). All return the same JSON shape.
  - Hours: 12.

- `[M5-3]` **Council orchestrator**
  - Files: `packages/council/src/orchestrator.ts`. Modes: `classic` (parallel), `blind` (each provider doesn't see others), `debate` (n rounds with critique), `ultraplinian` (1051 parallel, top-K winners by composite metric).
  - Acceptance: integration test with 3 mocked providers across all 4 modes; each mode produces a verdict object.
  - Hours: 16.

- `[M5-4]` **Persona-preset system**
  - Files: `packages/council/src/presets/`. Schema in `@nexus/contracts`. Built-in presets: `general.default`, `finance.contrarian`, `finance.quant`, `finance.fundamental`, `finance.macro`, `finance.technical`, `finance.default`, `security.triage`, `code.review`.
  - Source: extract from FinScrape's `personas.py` + `market_personas.py` (kept aside in M2). Conversion script: `scripts/migrate-finscrape-personas.ts`.
  - Acceptance: presets validated against schema; `POST /v1/council/deliberate {presetId: 'finance.default'}` includes the expected 4-persona council.
  - Hours: 10.

- `[M5-5]` **Verdict synthesis**
  - Files: `packages/council/src/synthesis.ts`. Designated synthesizer (rotated per round). Confidence scoring = composite of (a) inter-agent agreement, (b) provider self-reported confidence, (c) heuristic alignment with optional external signal.
  - Acceptance: deterministic golden tests on 20 fixture transcripts: same input → identical verdict.
  - Hours: 10.

- `[M5-6]` **API routes (`/v1/council/*`)**
  - Files: `apps/api/src/routes/council.ts`. `POST /deliberate` (SSE), `GET /sessions/:id`, `GET /presets`, `POST /presets`, `GET /providers`, `POST /providers` (admin).
  - Acceptance: a `curl` call returns a streamed verdict; session persisted; permissions enforced.
  - Hours: 12.

- `[M5-7]` **`@nexus/adapter-council` (council as ILanguageModel)**
  - Files: `packages/adapters/council/src/index.ts`. Wraps `/v1/council/deliberate` as an `ILanguageModel` implementation for the runtime planner.
  - Acceptance: `new PlanningEngine(new CouncilModel(apiUrl))` plans an objective using council deliberation; e2e test green.
  - Hours: 6.

- `[M5-8]` **Cost tracking + budgets**
  - Files: `packages/council/src/cost.ts`. Records token in/out + price per model from `MODEL_REGISTRY`; per-workspace budget enforcement; aggregated in `audit_log`.
  - Acceptance: deliberation that would exceed budget fails fast with a typed error.
  - Hours: 8.

- `[M5-9]` **Guardrails**
  - Files: `packages/council/src/guardrails/{rate-limit,token-limit,prompt-injection,toxicity,pii-leak,jailbreak-detect}.ts`. Pre- and post-process hooks. Configurable per workspace.
  - Acceptance: each guardrail has tests with known-good and known-bad inputs.
  - Hours: 16.

- `[M5-10]` **Council load test**
  - Files: `apps/api/tests/load/council.k6.js`.
  - Acceptance: target p95 < 8s for 4-provider classic deliberation at 5 RPS sustained for 5 min.
  - Hours: 4.

### 11.2 Exit criteria

- ☐ All 5 providers contract-tested.
- ☐ All 4 modes (classic/blind/debate/ultraplinian) integration-tested.
- ☐ 9 built-in presets + JSON-schema validated.
- ☐ Cost tracking + per-workspace budgets enforced.
- ☐ All 6 guardrails covered.
- ☐ Load test p95 within SLO.

---

## 12. M6 — Decide layer (runtime + governance)

> **Definition:** Plan → govern → approve → execute, with persisted state and HITL gating.
> **Entry criteria:** M3 + M5 complete.

### 12.1 Tasks

- `[M6-1]` **Migrate Ghoststack core**
  - Files: M2 MOVE — `packages/runtime/src/*`. Strip floci-* per ADR-0001.
  - Acceptance: builds; 66 Jest spec files pass after migrating Jest config to Vitest (or keeping Jest in this package only).
  - Hours: 14.

- `[M6-2]` **Extract `@nexus/governance`**
  - Files: split `packages/runtime/src/{governance-engine,approval-workflow}.ts` + all `constraints/`, `policies/`, `guardrails/` into `packages/governance/`.
  - Acceptance: cyclic-free; runtime depends on governance, not vice versa.
  - Hours: 10.

- `[M6-3]` **Wire planner with council**
  - Files: `apps/api/src/services/runtime.ts` boots one `GhostStackOrchestrator` per process using `RedisQueueBackend`, `PostgresEventStore`, `PostgresRuntimePersistence`, `CouncilModel` planner.
  - Acceptance: `POST /v1/runtime/submit {objective}` plans, governs, queues, executes. State survives API restart.
  - Hours: 12.

- `[M6-4]` **Approval workflow + UI hook**
  - Files: `apps/api/src/routes/approvals.ts`; events `nexus.approval.requested` and `nexus.approval.resolved` flow on the bus.
  - Acceptance: a task gated by `HighCostPlanGuardrail` pauses; CLI `nexus approval list` shows it; `nexus approval approve <id>` unblocks.
  - Hours: 10.

- `[M6-5]` **Governance configurability**
  - Files: `apps/api/src/routes/policies.ts` — `GET/POST /v1/policies` per workspace. JSON-schema-validated.
  - Acceptance: a workspace admin can disable a guardrail or tune a threshold; change reflected within the next deliberation.
  - Hours: 8.

- `[M6-6]` **Spec loader + workflow engine**
  - Files: `packages/runtime/src/workflow-engine.ts` reads JSON Schema-validated workflow specs and registers them as runtime templates.
  - Acceptance: 5 built-in templates work end-to-end: `BrowserResearch`, `LocalCloudProvisioning`, `DocumentProcessing`, `SpecToExecution`, `GovernedETL`, `FinanceSignal` (new).
  - Hours: 10.

- `[M6-7]` **Crash recovery & DLQ tooling**
  - Files: `apps/cli/src/commands/{dlq,queue,graph}.ts`.
  - Acceptance: kill the worker mid-task → restart → task either completes or DLQs; `nexus dlq list/retry/clear` works.
  - Hours: 8.

- `[M6-8]` **Runtime tracing**
  - Files: every span in runtime carries `tenant.id`, `workspace.id`, `task.id`, `correlation.id`. Trace IDs propagate from API → council → runtime → adapter.
  - Acceptance: a single trace in Jaeger/Tempo spans Python ingest → API → council → runtime → mock adapter, ≥ 12 spans.
  - Hours: 8.

### 12.2 Exit criteria

- ☐ Planner uses council by default; falls back to keyword-blueprint matching when council unavailable.
- ☐ All 6 built-in workflow templates pass integration tests.
- ☐ HITL approval works end-to-end via API + CLI.
- ☐ Crash recovery proven by kill-9 chaos test.
- ☐ Trace spans Python → adapter visible in Tempo.

---

## 13. M7 — Act layer (plugin SDK & 14 adapters)

> **Definition:** Adapters are first-class plugins. A third party can author one in < 30 min following the SDK guide.
> **Entry criteria:** M6 complete.

### 13.1 The plugin SDK

- `[M7-1]` **`@nexus/plugin-sdk` design**
  - Files: `packages/plugin-sdk/src/{index.ts, defineAdapter.ts, capabilities.ts, errors.ts, testing.ts}`.
  - Public API:
    ```ts
    import { defineAdapter, capability } from "@nexus/plugin-sdk";

    export default defineAdapter({
      name: "slack",
      version: "1.0.0",
      capabilities: [
        capability("slack.message.send", schema),
        capability("slack.channel.create", schema),
      ],
      execute: async (task, ctx) => { /* ... */ },
      health: async (ctx) => { /* ... */ },
    });
    ```
  - Acceptance: type-level test ensures `task.action` is narrowed to the capability schema's input.
  - Hours: 16.

- `[M7-2]` **Adapter testing kit**
  - Files: `packages/plugin-sdk/testing.ts` exposes `mockContext`, `expectAdapter(...).toHandle(task).withResult(...)`, contract-test helpers.
  - Acceptance: rolling an adapter against the kit produces 80%+ coverage with minimal boilerplate.
  - Hours: 8.

- `[M7-3]` **Adapter registry**
  - Files: `apps/api/src/services/adapter-registry.ts`. Discovery via filesystem (`packages/adapters/*`) and via runtime registration (for third-party plugins installed via npm).
  - Acceptance: a third-party adapter installed via `pnpm add @some/nexus-adapter-notion` is auto-discovered.
  - Hours: 8.

- `[M7-4]` **Plugin author guide**
  - Files: `docs/plugin-author-guide.md` (also in docs-site).
  - Acceptance: a stranger creates a working `nexus-adapter-hello` in < 30 min following only the guide.
  - Hours: 8.

### 13.2 Convert the 14 first-party adapters

For each adapter, the task structure is identical:

```
[M7-AX]  <name>
Files: packages/adapters/<name>/src/{index.ts, client.ts, capabilities.ts, errors.ts}
       packages/adapters/<name>/tests/{unit.test.ts, contract.test.ts, integration.test.ts}
Acceptance:
  - canHandle({type, action}) returns true for declared capabilities only
  - execute(task) works against (a) real SDK with credentials, (b) recorded VCR cassettes for CI
  - 90% line coverage
  - HEALTHCHECK endpoint contract
  - Error mapping: all SDK-specific errors map to NEXUS typed errors
  - Telemetry: spans + counters present
  - Adapter registered in adapter-registry on API boot
Hours per adapter: 8 (5h dev + 2h tests + 1h docs)
```

Adapters in priority order:

- `[M7-A1]` `slack` (8h) — demo
- `[M7-A2]` `gmail` (8h) — demo
- `[M7-A3]` `linear` (8h) — demo
- `[M7-A4]` `github` (8h) — demo
- `[M7-A5]` `ingest` (8h) — Python bridge
- `[M7-A6]` `calendar` (8h)
- `[M7-A7]` `drive` (8h)
- `[M7-A8]` `neon` (8h)
- `[M7-A9]` `supabase` (8h)
- `[M7-A10]` `vercel` (8h)
- `[M7-A11]` `cloudflare` (8h)
- `[M7-A12]` `doppler` (8h)
- `[M7-A13]` `betterstack` (8h)
- `[M7-A14]` `groq` (8h)
- `[M7-A15]` `tavily` (8h)

Total: 14 adapters × 8h = **112 h**.

### 13.3 Exit criteria

- ☐ Plugin SDK published as `@nexus/plugin-sdk@0.1.0` to npm.
- ☐ Author guide passes the "stranger in 30 min" usability test.
- ☐ All 14 first-party adapters: 90% coverage, healthcheck contract, telemetry, error mapping.
- ☐ A third-party adapter registered via npm install is auto-discovered and usable.

---

## 14. M8 — Vertical pipeline (signal-finance)

> **Definition:** The end-to-end finance flow works without manual stitching.
> **Entry criteria:** M4 + M5 + M6 + M7 (Slack/Linear/Gmail + Ingest adapters) complete.

### 14.1 Tasks

- `[M8-1]` **`@nexus/pipeline-signal`**
  - Files: `packages/pipeline-signal/src/{index.ts, stages/{ingest,validate,extract,score,deliberate,act}.ts, presets/finance.ts}`.
  - Acceptance: pipeline run from `IngestedEvent` to "actions queued" passes; each stage emits an event.
  - Hours: 18.

- `[M8-2]` **Finance preset**
  - Files: `packages/pipeline-signal/src/presets/finance.ts` — declares: scraper selection, council preset `finance.default`, verdict threshold, default actions (Slack/Linear/Gmail).
  - Acceptance: `nexus pipeline run signal:finance --ticker AAPL` runs end-to-end.
  - Hours: 8.

- `[M8-3]` **Scheduled signals**
  - Files: leverages Ghoststack scheduler — `every */30 * * * *` runs `signal:finance --tickers WATCHLIST`.
  - Acceptance: a 30-min cron submits a job; runs visible in `/v1/runtime/runs`.
  - Hours: 4.

- `[M8-4]` **Portfolio + accuracy tracking**
  - Files: schema additions for `portfolios`, `holdings`, `signal_outcomes`; backfill logic from market-data lookups (`adapter-betterstack` or yfinance proxy from Python).
  - Acceptance: outcomes recorded; `GET /v1/signals/accuracy?range=30d` returns metrics.
  - Hours: 12.

- `[M8-5]` **Divergence escalation**
  - Files: when heuristic and AI scores disagree by > threshold, automatically trigger a multi-round debate-mode council deliberation.
  - Acceptance: divergence > 2 → escalation visible in the audit log.
  - Hours: 6.

### 14.2 Exit criteria

- ☐ End-to-end demo flow works without manual stitching.
- ☐ `nexus pipeline run signal:finance --ticker AAPL` returns a verdict and queues actions.
- ☐ Scheduled signals running on the system itself.
- ☐ Accuracy tracking produces a 30-day metric.

---

## 15. M9 — Web UI, CLI, and developer surface

> **Definition:** A human can use NEXUS without writing code; a developer can script it.
> **Entry criteria:** M6 + M7 + M8 complete.

### 15.1 Web

- `[M9-1]` **App shell + auth**
  - Files: `apps/web/app/{root.tsx, routes/_layout.tsx, lib/auth-client.ts}`. `@nexus/auth` integration; login, signup, OAuth (Google + GitHub).
  - Acceptance: Axe-clean; protected routes redirect; session in Redis.
  - Hours: 14.

- `[M9-2]` **Dashboard `/`**
  - Files: KPI tiles (signals today, council sessions, top tickers, worker queue depth, pipeline uptime).
  - Acceptance: live data; refreshes every 30s; responsive.
  - Hours: 10.

- `[M9-3]` **`/signals`**
  - Files: list view with date picker + ticker filter + verdict filter; detail view with transcript + action history + audit log.
  - Acceptance: WebSocket updates < 500 ms p95.
  - Hours: 16.

- `[M9-4]` **`/council`**
  - Files: prompt playground; preset/provider picker; streamed opinion view; verdict reveal.
  - Acceptance: parity with Judica's deliberation panel; session history persisted.
  - Hours: 14.

- `[M9-5]` **`/workflows`**
  - Files: DAG visualiser (reactflow); spec editor; run button; live execution status.
  - Acceptance: existing specs render correctly; run from UI enqueues task.
  - Hours: 14.

- `[M9-6]` **`/approvals`**
  - Files: queue view; reasoning panel (why paused); approve/reject buttons; bulk actions; per-tenant filters.
  - Acceptance: full HITL flow works through UI.
  - Hours: 10.

- `[M9-7]` **`/integrations`**
  - Files: list of 14 adapters + community-installed; status, last call, error rate, configure button (per-workspace API keys via Doppler).
  - Acceptance: configurable from UI; status accurate.
  - Hours: 10.

- `[M9-8]` **`/policies`**
  - Files: editor for governance policies; JSON-schema-driven form.
  - Acceptance: a workspace admin can tweak `HighCostPlanGuardrail` threshold and see effect.
  - Hours: 8.

- `[M9-9]` **`/audit`**
  - Files: append-only log viewer; chain-verify button; export to CSV/JSON; filtering.
  - Acceptance: clicking "verify" walks the HMAC chain client-side; export produces a signed file.
  - Hours: 10.

- `[M9-10]` **Storybook + a11y**
  - Files: every shared component has a Storybook story; Axe runs in story matrix.
  - Acceptance: Axe-clean across all stories.
  - Hours: 12.

- `[M9-11]` **i18n scaffolding**
  - Files: `apps/web/app/messages/en-US.json`; format = ICU; loader.
  - Acceptance: every visible string is extracted; switching the messages file to a stub `??` reveals zero un-translated strings.
  - Hours: 10.

### 15.2 CLI

- `[M9-12]` **`@nexus/cli` skeleton**
  - Files: `apps/cli/src/{index.ts, commands/*.ts, config.ts}` — `oclif` or `commander` based. Distributed as `nexus` binary.
  - Acceptance: `nexus --help` shows command tree; `nexus auth login` works; config persisted to `~/.nexusrc`.
  - Hours: 10.

- `[M9-13]` **Command set**
  - Commands: `auth {login,logout,whoami}`, `ingest {scrape,jobs,list,get}`, `council {ask,sessions,presets,providers}`, `runtime {submit,tasks,plans,graph,dlq}`, `approvals {list,approve,reject}`, `signals {list,get,accuracy}`, `policies {list,get,set}`, `audit {tail,verify,export}`, `adapters {list,health,configure}`, `workspaces {list,create,members,invite}`, `version`, `config`.
  - Acceptance: every API operation reachable via CLI; every CLI command has a `--json` flag for scripting.
  - Hours: 20.

- `[M9-14]` **Shell completion**
  - Files: bash/zsh/fish completion scripts.
  - Acceptance: tab-completion works.
  - Hours: 4.

### 15.3 SDK + docs site

- `[M9-15]` **TypeScript SDK**
  - Files: `packages/sdk/src/*` — thin wrapper around generated OpenAPI client + helpers.
  - Acceptance: published as `@nexus/sdk`; example app in `docs-site/`.
  - Hours: 8.

- `[M9-16]` **Python SDK**
  - Files: `python/nexus_sdk/` — thin wrapper around pydantic-generated client.
  - Acceptance: published to PyPI; example notebook.
  - Hours: 8.

- `[M9-17]` **Docs site**
  - Files: `apps/docs-site/` Docusaurus 3 with: overview, quick-start, architecture, plugin author guide, API reference (auto-generated from OpenAPI), CLI reference, ADR index, contributing.
  - Acceptance: deployed to Cloudflare Pages on every push to `main`; algolia search wired.
  - Hours: 16.

### 15.4 Exit criteria

- ☐ Every API operation reachable from web + CLI + SDK.
- ☐ Web UI Axe-clean; Storybook complete.
- ☐ All strings i18n-extracted.
- ☐ Docs site live with auto-generated API + CLI reference.

---

## 16. M10 — Security, audit, and compliance

> **Definition:** A security-minded reviewer would let this run in production.
> **Entry criteria:** M9 complete.

### 16.1 Tasks

- `[M10-1]` **gitleaks + truffleHog**
  - Files: `.github/workflows/secrets.yml`; pre-commit hook.
  - Acceptance: any commit containing a secret pattern is rejected pre-commit and pre-merge.
  - Hours: 3.

- `[M10-2]` **CodeQL + SAST**
  - Files: `.github/workflows/codeql.yml` (TS + Python).
  - Acceptance: any critical CodeQL alert fails the build; current state = zero alerts.
  - Hours: 4.

- `[M10-3]` **Dependency scanning**
  - Files: Dependabot + Renovate configs; `.github/workflows/trivy.yml` (filesystem + container scans).
  - Acceptance: weekly auto-PRs; CI fails on critical CVEs.
  - Hours: 4.

- `[M10-4]` **SBOM generation**
  - Files: `.github/workflows/sbom.yml` — `syft` generates CycloneDX SBOM on every release.
  - Acceptance: SBOM artefact attached to GitHub release.
  - Hours: 3.

- `[M10-5]` **Cosign signing**
  - Files: `.github/workflows/release.yml` — every Docker image + release artefact signed with cosign (OIDC via GitHub OIDC). Public key in `SECURITY.md`.
  - Acceptance: `cosign verify ghcr.io/yash-awasthi/nexus-api:v0.1.0` succeeds.
  - Hours: 6.

- `[M10-6]` **Secrets management**
  - Files: `docs/runbook.md` section. Default: env vars from Doppler. In Helm: external-secrets operator. In docker-compose: `.env` file (gitignored).
  - Acceptance: no secret in repo (gitleaks passes); deployment guide shows the three patterns.
  - Hours: 4.

- `[M10-7]` **Rate limiting + abuse**
  - Files: `apps/api/src/plugins/rate-limit.ts` — per-IP + per-user + per-workspace. Redis-backed sliding window.
  - Acceptance: load test confirms the limit; 429 returned with `Retry-After`.
  - Hours: 6.

- `[M10-8]` **mTLS between services (optional/recommended)**
  - Files: Helm chart supports a sidecar (linkerd / istio). In-process docker-compose uses TLS via self-signed CA.
  - Acceptance: traffic between API ↔ ingest ↔ worker encrypted; cert rotation tested.
  - Hours: 12.

- `[M10-9]` **Encryption at rest**
  - Files: `pgcrypto` for `signals.text`, `verdicts.transcript`, `audit_log.payload`. Workspace-scoped DEKs derived from a per-workspace key in KMS.
  - Acceptance: a Postgres dump reveals ciphertext, not plaintext.
  - Hours: 10.

- `[M10-10]` **Threat model**
  - Files: `docs/security/threat-model.md` — STRIDE per component. Trust boundaries diagram.
  - Acceptance: each STRIDE category for each component has mitigations linked or noted as accepted risk.
  - Hours: 12.

- `[M10-11]` **Penetration test scenarios**
  - Files: `docs/security/pentest-scenarios.md` — 20 scripted scenarios (SSRF on ingest, prompt injection on council, IDOR on signals, broken auth flows, …).
  - Acceptance: each scenario has a written outcome; failures filed as issues and fixed before tagging v1.0.0.
  - Hours: 20.

- `[M10-12]` **GDPR / data subject rights**
  - Files: `apps/api/src/routes/dsr.ts`: `GET /v1/dsr/export?workspace=…`, `POST /v1/dsr/erase`.
  - Acceptance: erase request anonymises personally identifiable rows + scrubs object storage within 7 days. Audit-logged.
  - Hours: 10.

- `[M10-13]` **Telemetry opt-in**
  - Files: `packages/telemetry/src/anonymous.ts` — only fires when `NEXUS_TELEMETRY=1`. Sends version + opt-in install ID. Documented.
  - Acceptance: a fresh install with default env sends zero packets to any external host (verified via tcpdump in CI sandbox).
  - Hours: 4.

### 16.2 Exit criteria

- ☐ gitleaks, CodeQL, Trivy, Dependabot all green on `main`.
- ☐ Every release ships an SBOM + cosign signature.
- ☐ Encryption at rest verified.
- ☐ Threat model + pentest scenarios documented + remediated.
- ☐ DSR endpoints work end-to-end.
- ☐ Zero phone-home with default env.

---

## 17. M11 — Observability, perf, and disaster recovery

> **Definition:** When something breaks at 3 a.m., the operator has the data to fix it.
> **Entry criteria:** M10 complete.

### 17.1 Tasks

- `[M11-1]` **OpenTelemetry end-to-end**
  - Files: TS + Py OTel SDK; trace context propagates via `traceparent` header. Logs via Loki (JSON), metrics via Prometheus, traces via Tempo.
  - Acceptance: one signal's trace spans ingest → API → council → runtime → adapter, ≥ 12 spans, all correlatable.
  - Hours: 14.

- `[M11-2]` **Grafana dashboards**
  - Files: `infra/grafana/dashboards/{ingest,council,runtime,adapters,db,overview}.json`.
  - Acceptance: each dashboard renders error-free against the metrics stream.
  - Hours: 10.

- `[M11-3]` **SLOs + alerts**
  - Files: `infra/grafana/alerts/*.yaml`. Five SLOs: API availability 99.9%, ingest p95 < 10s, council p95 < 8s, adapter p95 < 5s, worker queue depth < 1000.
  - Acceptance: synthetic load violates each SLO once; alert fires within 1 minute.
  - Hours: 8.

- `[M11-4]` **Load testing**
  - Files: `apps/api/tests/load/*.k6.js` for ingest, council, runtime, adapters, signal pipeline end-to-end.
  - Acceptance: each load test runs in CI nightly; results published to `docs/perf/v0.x.0.md` per release.
  - Hours: 16.

- `[M11-5]` **Chaos engineering**
  - Files: `tests/chaos/{kill-worker,kill-db,kill-redis,partition-network}.sh` (Toxiproxy).
  - Acceptance: each scenario degrades gracefully; system self-recovers; alert fires; no data loss.
  - Hours: 14.

- `[M11-6]` **Backup automation**
  - Files: `infra/backup/{wal-g.yaml, redis-rdb.yaml, minio-mirror.yaml}`.
  - PG = WAL-G to S3, hourly base + continuous WAL.
  - Redis = RDB snapshot every 6h.
  - MinIO = `mc mirror` to off-host bucket.
  - Acceptance: a backup verifier runs on a schedule and reports last successful backup.
  - Hours: 10.

- `[M11-7]` **PITR drill**
  - Files: `docs/runbook.md` "DR drill" section + `scripts/dr/restore-pitr.sh`.
  - Acceptance: restore-to-arbitrary-timestamp drill executed quarterly; recorded duration in `docs/dr-drills/`.
  - Hours: 12.

- `[M11-8]` **Cost dashboards**
  - Files: per-workspace LLM cost; storage cost; compute cost.
  - Acceptance: a workspace owner can see their token spend over 30 days, broken down by provider + preset.
  - Hours: 8.

### 17.2 Exit criteria

- ☐ Full OTel trace verified through every layer.
- ☐ 6 Grafana dashboards live.
- ☐ 5 SLOs declared, alert-tested.
- ☐ k6 load tests in nightly CI.
- ☐ 4 chaos scenarios pass.
- ☐ Backup + PITR drill executed once successfully.

---

## 18. M12 — Release engineering & v1.0.0

> **Definition:** Anyone can `curl install.sh | bash`, get a working NEXUS, upgrade safely, and roll back cleanly.
> **Entry criteria:** all previous milestones complete.

### 18.1 Tasks

- `[M12-1]` **Versioning + release automation**
  - Files: `changesets` config; `.github/workflows/release.yml` — on `main`, opens a "Version Packages" PR; merging it tags + publishes npm + builds + signs Docker images + creates GitHub release.
  - Acceptance: end-to-end test produces a `v0.1.0` release with all artefacts present.
  - Hours: 10.

- `[M12-2]` **Docker images**
  - Files: distroless or chiseled images per service; multi-arch (amd64 + arm64); pinned SHA256 bases.
  - Acceptance: `docker pull` works on Mac M-series and Linux x86_64; `docker scout cves` returns zero high.
  - Hours: 8.

- `[M12-3]` **Helm chart**
  - Files: `infra/helm/nexus/*` — values.yaml supports: external Postgres, external Redis, ingress, autoscaling.
  - Acceptance: `helm install nexus ./infra/helm/nexus --values values-staging.yaml` produces a healthy cluster on kind.
  - Hours: 16.

- `[M12-4]` **Terraform module**
  - Files: `infra/terraform/modules/nexus/*` — example deployments for Fly.io, GCP Cloud Run, AWS ECS.
  - Acceptance: `terraform apply` brings up a 3-service prod on each cloud (manual verification).
  - Hours: 18.

- `[M12-5]` **One-command install**
  - Files: `install.sh` — Docker-based; pulls signed images; bootstraps Postgres + Redis + MinIO + API + Worker + Web + Ingest.
  - Acceptance: on a fresh Ubuntu 22 VM, `curl … | bash` produces a working NEXUS in < 5 min.
  - Hours: 6.

- `[M12-6]` **Upgrade + rollback procedures**
  - Files: `docs/runbook.md` "Upgrade" section. Drizzle migration up + down; Helm rolling update; Docker tag flip.
  - Acceptance: one minor-version upgrade test (`v0.2.0 → v0.3.0`) passes both up and rollback.
  - Hours: 8.

- `[M12-7]` **Demo recording**
  - Files: `docs/demo/{script.md, recording.mp4}`. The SEC-AAPL-PULL_OUT scenario.
  - Acceptance: ≤ 90s; clean cut; embedded in README.
  - Hours: 8.

- `[M12-8]` **README polish**
  - Files: `README.md` — hero, demo embed, quick-start, architecture diagram, tech stack, community badges, sponsors section (optional), table-of-contents to docs.
  - Acceptance: a stranger "gets it" in 30s.
  - Hours: 6.

- `[M12-9]` **CHANGELOG.md**
  - Files: generated by changesets; pre-1.0.0 manual additions describing the project's origin (the four upstream repos).
  - Acceptance: every release has a human-readable entry.
  - Hours: 3.

- `[M12-10]` **v1.0.0 release**
  - Files: `MAINTAINERS.md` reviewed; ADRs final; quality bars all green; security audit signed off.
  - Acceptance: GitHub release `v1.0.0` published with: SBOM, signed Docker images, helm chart, terraform module, signed install.sh, demo video.
  - Hours: 4.

### 18.2 Exit criteria

- ☐ `install.sh` works on a fresh VM in < 5 min.
- ☐ Helm + Terraform deploys succeed.
- ☐ Upgrade + rollback both clean.
- ☐ All non-negotiable quality bars (§5) green.
- ☐ v1.0.0 tagged + signed + announced.

---

## 19. Open-source readiness checklist

(Run before tagging v1.0.0. Every box must be ☑.)

### 19.1 Legal & governance

- ☐ `LICENSE` = Apache-2.0 verbatim
- ☐ `NOTICE` attributes the four upstream MIT repos with full licence text
- ☐ `CODE_OF_CONDUCT.md` = Contributor Covenant 2.1
- ☐ `CONTRIBUTING.md` includes DCO sign-off
- ☐ `GOVERNANCE.md` published
- ☐ `MAINTAINERS.md` published
- ☐ `SECURITY.md` includes PGP key + cosign key + disclosure policy
- ☐ All commits DCO-signed-off
- ☐ All releases cosign-signed

### 19.2 Documentation

- ☐ Top-level `README.md` covers: what + why + 30s demo + quick-start + architecture link
- ☐ `docs-site/` deployed (Docusaurus); search-enabled
- ☐ API reference auto-generated from OpenAPI
- ☐ CLI reference auto-generated
- ☐ Plugin author guide proven by a stranger creating an adapter in < 30 min
- ☐ All 18 ADRs published
- ☐ Threat model published
- ☐ Operational runbook published
- ☐ Every public symbol has TSDoc / docstring; `pnpm docs:check` green

### 19.3 Code quality

- ☐ Coverage ≥ 80% on every package (≥ 90% on runtime, council, governance, auth)
- ☐ TypeScript strict, mypy --strict
- ☐ Zero ESLint errors, zero Ruff errors
- ☐ Zero cyclic imports
- ☐ Conventional Commits enforced + changesets working

### 19.4 Security

- ☐ Zero secrets in repo (gitleaks)
- ☐ Zero critical CVEs (Trivy)
- ☐ Zero critical CodeQL alerts
- ☐ Dependabot + Renovate enabled
- ☐ SBOM generated per release
- ☐ Docker images cosign-signed
- ☐ Threat model + 20 pentest scenarios documented & remediated
- ☐ Encryption at rest verified
- ☐ DSR endpoints work

### 19.5 Reliability

- ☐ 5 SLOs declared + alert-tested
- ☐ 4 chaos scenarios pass
- ☐ PITR drill executed successfully
- ☐ Upgrade + rollback proven
- ☐ Backup verifier reports last successful backup

### 19.6 Performance

- ☐ k6 load tests in nightly CI
- ☐ Per-release perf doc published

### 19.7 Community

- ☐ GitHub Discussions enabled
- ☐ Discord / Matrix / Zulip room created (optional but recommended)
- ☐ "good first issue" labelled at least 10 issues
- ☐ Hacktoberfest-friendly tags
- ☐ Release notes go to: GitHub, docs-site, blog post / `dev.to`, `r/programming` cross-post

---

## 20. Threat model

(Lives in `docs/security/threat-model.md`; summary here.)

### 20.1 Trust boundaries

```
[Client browser] —HTTPS→ [API gateway] ─┬→ [Worker] ─┬→ [Council] → [LLM providers (external)]
                                        │            ├→ [Runtime] → [Adapters] → [Third-party SaaS]
                                        │            └→ [Postgres / Redis / MinIO]
                                        └→ [Ingest (Python)] → [Scraped sites (external)]
```

### 20.2 STRIDE quick reference

| Boundary | Spoofing | Tampering | Repudiation | Info disclosure | DoS | EoP |
|---|---|---|---|---|---|---|
| Client ↔ API | JWT + 2FA | TLS 1.3 | HMAC audit log | Per-workspace scoping | Rate limit | RBAC |
| API ↔ Worker | mTLS (k8s) | Signed events | Audit log | At-rest encryption | Queue limits | None — same trust zone |
| Ingest (Py) ↔ API | API key | OpenAPI validation | Audit log | TLS | Rate limit + circuit breaker | None |
| Adapters ↔ SaaS | OAuth + Doppler | TLS | Per-call audit | Secrets in Doppler | Adapter quota | Per-workspace API keys |
| Council ↔ LLM | Provider API key | TLS | Audit log | Token redaction | Budget caps | Provider isolation |

### 20.3 Highest-risk threats (each must be mitigated by v1.0.0)

- **T1 — Prompt injection** via scraped article causes council to issue malicious task graph.
  *Mitigation:* M5-9 guardrails; runtime governance blocks `dangerous` operations; HITL gate on INVEST/PULL_OUT.
- **T2 — Adapter token exfiltration** by malicious workflow.
  *Mitigation:* per-task token scoping; `ResourceScopeConstraint` enforced; tokens never logged.
- **T3 — Audit log forgery.**
  *Mitigation:* HMAC chain (ADR-0010); chain-verify on export.
- **T4 — SSRF via ingest scrapers.**
  *Mitigation:* allowlist of target hostnames; deny internal CIDRs; egress proxy.
- **T5 — RCE via spec loader.**
  *Mitigation:* JSON Schema validation; no eval; no shell-out without `dangerous` policy + HITL.

---

## 21. Operational runbook

(Lives in `docs/runbook.md`; summary here.)

### 21.1 Deployments

- **Local dev:** `docker compose -f infra/docker/docker-compose.dev.yml up`.
- **Single VM:** `curl -fsSL https://nexus.dev/install.sh | bash`.
- **Kubernetes:** `helm install nexus ./infra/helm/nexus --values values.yaml`.
- **Cloud (Fly/GCP/AWS):** `terraform apply` in `infra/terraform/examples/{fly,gcp,aws}`.

### 21.2 Day-2 operations

- **Logs:** `kubectl logs -l app=nexus-api -f` or Loki at Grafana.
- **Traces:** Tempo at Grafana.
- **Metrics:** Prometheus at Grafana, see dashboards (M11-2).
- **DLQ inspection:** `nexus dlq list`; retry: `nexus dlq retry <id>`.
- **Backup status:** Grafana → "Operations" dashboard → backup panel.
- **Cost:** Grafana → "Cost" dashboard.

### 21.3 Incident response

- **API down:** check `/v1/health`, then container logs, then DB / Redis. Roll back tag if recent deploy.
- **Worker stuck:** `nexus runtime graph` shows hung node; `nexus dlq` after retry budget.
- **DB corruption:** PITR restore (M11-7).
- **Bad release:** `helm rollback nexus N-1`.

---

## 22. Glossary

| Term | Meaning |
|---|---|
| **Adapter** | A plugin that implements `IExecutionAdapter` and exposes one or more capabilities. |
| **Capability** | A typed action an adapter can perform (e.g., `slack.message.send`). |
| **Council** | A coordinated set of LLM providers that deliberate and synthesize a verdict. |
| **Verdict** | Council output: `{ verdict, confidence, transcript, synthesizer, persona }`. |
| **Preset** | A named bundle of providers + persona system prompts + verdict schema. |
| **Pipeline** | A reusable graph of stages (`ingest → validate → extract → score → deliberate → act`). |
| **Workflow spec** | JSON document describing a task graph; validated against `workflow-spec.json` schema. |
| **Plan** | The output of `PlanningEngine`: a list of tasks with dependencies. |
| **Policy** | A governance rule (e.g., budget cap, dangerous operation). |
| **Guardrail** | A pre/post-LLM filter (e.g., prompt injection, PII). |
| **Approval request** | An HITL gate produced by governance. |
| **Adapter execution** | One concrete call to a third-party SaaS, persisted in the audit log. |
| **Audit log** | The HMAC-chained, append-only record of every governance + adapter decision. |
| **Workspace** | A tenant boundary. All data is scoped to a workspace. |

---

## Final note (read this last)

This is not a 16-week sprint. It is a quality contract.

The four upstream repos are scaffolding — useful, partially fictional in their READMEs, and not yet production-grade individually. NEXUS is the act of *taking them seriously as a system*. The novelty is not any single layer; it is the disciplined integration: one governance plane, one observability story, one contract layer, one plugin model.

When you finish, the deliverable is:

- A signed, SBOM-bundled, multi-arch container distribution.
- A Helm chart and a Terraform module.
- A documented plugin SDK that a stranger can use in < 30 min.
- A demo that shows a real SEC filing arrive, be deliberated, gated, approved, and acted upon, with every step audit-logged and verifiable.
- A threat model and a security disclosure policy.
- A test pyramid with property-based contract tests at the language boundary.
- A community-ready governance model.

That is "no issues remaining" — not perfection, but a system whose every known limitation is documented and reasoned about. Open-source means anyone reviewing this can see your decisions, your trade-offs, and your seams. Make them clean.

— end of NEXUS.md v2.0 —
