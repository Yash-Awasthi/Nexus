<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Roadmap

Forward-looking work only. Each item names the files it touches, an existing pattern to
mirror, and an acceptance check. Completed work has been removed — see the git history for
what shipped. Legend: **Files** = touch these · **Mirror** = existing pattern to copy ·
**Done** = acceptance check · **Gate** = needs a live/external action (provider key, OAuth
app, live probe, host-mutating install) before it can run.

> **Nexus is free/open** — no paid tier, no payment provider. "billing"/"quota" below = BYOK
> spend-guards on the user's own keys, never charging for Nexus.

Conventions that still apply to new work: build against mocks (`MockTransport`, injectable
`fetchFn`/`TokenHttp`); every live outbound call is a **Gate**; new env vars go in
`.env.example`; every new file carries the SPDX `Apache-2.0` header (`pnpm check:headers`);
migrations follow the `packages/db/migrations/` recipe (next free number, add a
`meta/_journal.json` entry or `db:migrate` skips the file); UI routes register in
`apps/ui/app/routes.ts` and mirror `provider-keys.tsx` (CRUD) or `costs.tsx` (dashboards).

---

## 1. LLM provider breadth

Baseline: `@nexus/llm-drivers` = ~48 native drivers in `packages/llm-drivers/src/index.ts`
(~2.3k lines) + `nexus/omni` sidecar. Seams: `LlmDriver` → `BaseDriver`
(`sseLines`/`ndjsonLines`, `_useDefaultTransport`) → `OpenAICompatibleDriver` (override
`chatCompletionsUrl()`/`authHeaders()`); `HttpTransport` (real) vs `MockTransport`
(`setResponses([...])`, all tests). `provider-registry` has the models.dev importer.

- **1.2 Dify SSE + threading** _✓ shipped_ — `DifyDriver.stream()` sends `response_mode: "streaming"` and parses the Dify SSE envelope (message/agent_message deltas reassemble, `message_end` → usage + conversation_id, `error` → typed LlmError, ping/workflow events skipped); `conversationId` rides `LlmRequestOptions`/`LlmResponse` so a follow-up passes `conversation_id` on the wire. Injected-transport (test) calls fall back to the blocking single-delta path.
- **1.3 Aux provider gaps** (one provider = one commit; mirror the sibling adapter; add a
  unit test per provider against mocked fetch):
  - `packages/image-gen/src` — flux, stability, recraft, fal, comfyui _✓ shipped_
    (`FluxProvider` BFL direct POST→poll, `StabilityProvider` v2beta stable-image,
    `RecraftProvider`, `FalProvider` queue API, `ComfyUIProvider` self-hosted
    /prompt→/history→/view; wired into the image-gen route + `.env.example`;
    package suite 92/92).
  - `packages/voice/src` — deepgram, cartesia, assemblyai (mirror ElevenLabs synth + Groq
    transcribe).
  - `packages/retrieval` / `packages/reranker` — voyage, jina, cohere embeddings.
  - `packages/search-orchestrator/src` — exa, brave, serper (mirror the `SearxNG` strategy).
- **1.4 Custom-driver framework** _✓ shipped_ — `packages/llm-drivers/README.md` documents the
  extension seams (`OpenAICompatibleDriver`, `BaseDriver` are public exports) with a compilable
  standalone driver template; no core edits needed.
- **1.5 models.dev seed** _(DB-backed, no startup network)_. Files: next-free migration
  `provider_models.sql` + schema + index export + `apps/cli/src/index.ts` + the API boot
  path. Do: `provider_models` table (per `ModelDefinition` in `provider-registry`); CLI
  `nexus models seed [--file <path>]` (parse with `modelsDevToDefinitions`, upsert — a live
  `fetchModelsDev` pull is a **Gate**); at boot load rows into the registry, no network.
  Done: seed populates from a fixture; boot reads the table; zero network at startup.

## 4. Provider OAuth + accounts

- **4.3 OAuth live E2E** _(Gate)._ Unit coverage of `completeLogin`/`refresh`/`revoke` with
  mocked `TokenHttp` lives in `packages/llm-oauth/tests/` — extend there if gaps appear. A
  live run needs the operator's registered OAuth app + redirect URI (external, one-time). Do
  not attempt without user go; never log token-exchange bodies.

## 8. Nexus Drive — per-user sandboxed CLI + storage (flagship)

**Spec (locked):** Firecracker microVM primary; fallback gVisor → Docker-limits. FS-level
512 MB quota (loopback ext4 or XFS project quota) at `/workspace`; soft-warn ~90% + bounded
grace, then hard-block. 30-day idle reclaim (warn first; track `lastActiveAt`). User supplies
their own LLM key via `.env` in `/workspace` (never log it; exclude from backups/exports).
Persistent volume + ephemeral compute; per-sandbox CPU/RAM/PID/wall-clock caps; egress
policy-gated. Baseline: `@nexus/sandbox` (`buildDockerArgs` — `--network=none`,
`--cap-drop=ALL`, `--pids-limit`, seccomp, read-only rootfs, non-root user already in place) +
`/drive/*` routes (`apps/api/src/routes/drive.ts`: `safeResolve` guard, app-level 512 MB
accounting, status/exec/ls/upload/delete behind auth + rate limits).

- **8.1 Isolation spike** _(Gate — decision-gates the rest of §8)._ Hardware is READY
  (`/dev/kvm` + vmx/svm present, 40 cores); `firecracker`/`jailer` binaries are **not
  installed**. This is a throwaway, live, host-mutating spike that yields no committable code,
  so it stays a Gate until the user opens it. Goal: boot a Firecracker microVM and prove a
  512 MB FS-level quota hard-fails a write end-to-end. **No production isolation code
  (§8.2–§8.6) until this passes.**

  **Researched procedure (from `firecracker/docs/getting-started.md`). Every step is
  live/host-mutating — do NOT run any of it inside a normal coding turn.**
  1. _KVM preflight:_ `lsmod | grep kvm` ·
     `[ -r /dev/kvm ] && [ -w /dev/kvm ] && echo OK || sudo setfacl -m u:${USER}:rw /dev/kvm`
  2. _Install the static binary_ (no build):
     ```
     ARCH="$(uname -m)"; url="https://github.com/firecracker-microvm/firecracker/releases"
     latest=$(basename $(curl -fsSLI -o /dev/null -w %{url_effective} ${url}/latest))
     curl -L ${url}/download/${latest}/firecracker-${latest}-${ARCH}.tgz | tar -xz
     mv release-${latest}-${ARCH}/firecracker-${latest}-${ARCH} ./firecracker
     ```
  3. _Kernel + rootfs_ from Firecracker CI S3 (`https://s3.amazonaws.com/spec.ccfc.min`):
     `wget` the latest `vmlinux` + the Ubuntu squashfs; `unsquashfs` → inject an ssh key into
     `squashfs-root/root/.ssh/authorized_keys` → `truncate -s 1G ubuntu.ext4` →
     `sudo mkfs.ext4 -d squashfs-root -F ubuntu.ext4`. **For the quota test build the rootfs on
     a 512 MB loopback-ext4 with a project quota** so the write cap is FS-enforced.
  4. _Run_ (terminal 1): `sudo rm -f /tmp/fc.socket; sudo ./firecracker --api-sock /tmp/fc.socket`.
  5. _Configure + boot_ (terminal 2) — `PUT` over the unix socket in order: `/boot-source`
     (`kernel_image_path`, `boot_args:"console=ttyS0 reboot=k panic=1"`), `/drives/rootfs`
     (`path_on_host`, `is_root_device:true`), optional `/network-interfaces/net1` (tap0), then
     `sleep 0.015; PUT /actions {"action_type":"InstanceStart"}`.
  6. _Prove the quota:_ SSH in (root/root),
     `dd if=/dev/zero of=/workspace/big bs=1M count=600` — **PASS = the write hard-fails at
     ~512 MB at the FS layer**, not app-level accounting.
  7. _Teardown:_ `reboot` inside the guest (exits the VMM); `sudo rm -f /tmp/fc.socket`;
     delete the kernel/rootfs/tap. Nothing is committed.
     Fallback if Firecracker fails its KVM/jailer checks: gVisor `runsc` (systrap); Docker
     `--memory`/`--storage-opt` limits are the interim (docker client present).

- **8.2 FS-level quota.** Files: `apps/api/src/routes/drive.ts` + sandbox mount. Do: replace
  app-level accounting with loopback-ext4/XFS-project quota. Done: a write past 512 MB
  hard-fails at the FS layer.
- **8.3 Schema.** Files: next-free migration + `packages/db/src/schema/drive-workspaces.ts`
  (userId, volumePath, quotaBytes, lastActiveAt, state). Done: provision/teardown persists a row.
- **8.4 Lifecycle worker.** Files: `apps/worker/src/handlers/drive-handler.ts` +
  `workspace-manager.ts`. Do: BullMQ provision job + 30-day idle-reclaim cron (warn first) +
  quota sweep; Prometheus metrics; backup/export endpoint. Done: reclaim + sweep run on schedule.
- **8.5 UI.** Files: `apps/ui/app/routes/sandbox.tsx`. Do: terminal + drive panel; seed
  `.env.example` into fresh workspaces; quota meter with soft-warn. Done: file ops + meter work.
- **8.6 Hardening.** Do: egress allowlist (deny by default); never log `.env`; runaway limits.
  Done: egress denied by default.

## 13. Domain feeds — `@nexus/domain-feeds`

Baseline: abstract `FeedAdapter<T>` + ~26 adapters (`MaritimeFeed`, `AviationFeed`, …) +
`FeedRegistry`/`FeedCache`. Tests use mocked fetch.

- **13.1 Port-congestion source.** Verify a live keyless source (**Gate** — live probe), then
  add the adapter mirroring `MaritimeFeed`. Done: adapter + mocked-fetch test.

  **Researched candidate: IMF PortWatch — official, public, KEYLESS.** Sourced from UN Global
  Platform AIS; served from public ArcGIS Online feature services (no token, GET only). Two
  datasets, both `/FeatureServer/0/query` on host `services9.arcgis.com/weJ1QsnbMYJlCHdG`:
  - **`Daily_Chokepoints_Data`** — _the port-congestion signal_: daily transit counts +
    capacity at maritime chokepoints (Suez, Panama, Hormuz, Bosphorus, …). Fields: `date`
    (epoch **ms**), `year/month/day`, `portid`, `portname`,
    `n_container/n_dry_bulk/n_general_cargo/n_roro/n_tanker/n_cargo/n_total`, `capacity_*`,
    `capacity`, `ObjectId`. Congestion ≈ `n_total` vs a trailing-mean `capacity`.
  - **`Daily_Ports_Data`** — 2065 ports: `date`, `portid`, `portname`, `country`, `ISO3`,
    `portcalls*`, `import*`, `export*`, `ObjectId`. A `portcalls` collapse = closure.

  Full query URL:
  `https://services9.arcgis.com/weJ1QsnbMYJlCHdG/ArcGIS/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query`
  Params: `where=1=1` (or `portid=…` / `date>…`), `outFields=*`, `f=json`,
  `returnCountOnly=true` for a count first, then paginate with `resultOffset` (batch ≤5000).
  Field metadata: same URL minus `/query`, plus `?f=json`. Refreshed weekly (Tue 09:00 ET).

  **Execution plan (build behind the Gate):** (a) **Gate/live probe** — `curl` the count + one
  page to confirm the field names/date encoding still match; (b) add a
  `PortCongestionFeed extends FeatureAdapter<…>` next to `MaritimeFeed`, baseUrl the
  FeatureServer, parse epoch-ms `date`, derive severity from the transit-vs-capacity anomaly,
  resilient mock fallback on malformed JSON like `MaritimeFeed`; (c) mocked-fetch test with a
  real-shape ArcGIS `{features:[{attributes:{…}}]}` payload — no live call in the test. Only
  step (a) is the Gate.

- **13.3 Dark-web sources** _(Gate — legal review before any code)._

## 14. Production multi-tenant hardening

Most items are **Blocked on provisioning**, not on code — the seams already exist. `infra/`
holds `k8s/`, `helm/nexus`, `terraform/`, `grafana/`, `otel/`, `chaos/`, `k6/`.

- **14.1 RS256 wiring** _✓ shipped_ — HS256/RS256 JWT issuance + alg-pinned verification (`NEXUS_JWT_ALG`, `.env.example`).
- **14.3 Brute-force / revocation** _✓ shipped_ — login throttle (429 backoff) + revocation registry wired in `middleware/auth.ts`; Redis-backed store Blocked on managed Redis.
- **14.4 GDPR erasure route** _✓ shipped_ — self-service `DELETE /users/:id/data` with content-free audit line.
- **14.5 Coverage → 80%** _✓ shipped_ — `council` 92.8%, `memory` 92.2%, `@nexus/runtime` 80.5% lines (623 tests, green).
  Remaining uncovered lines are concentrated in genuinely server/process-bound modules
  (federation-supervisor, bootstrap, docker-compose-runner, mcp-server-host, manifest
  export) that need live services; nothing there is a correctness gap.
- **14.6 DB / Infra provisioning** _(Blocked — see infra table)._ PgBouncer, read replicas,
  PITR, encryption-at-rest; K8s HPA; multi-AZ PG/Redis; CDN/edge DDoS; Grafana SLO dashboards +
  alerting. Charts/manifests exist; each is Done when provisioned.

## 15. Long-term / ambitious (greenfield — spec before building)

All below are multi-week greenfield; none is a one-commit item. Sequenced most-self-contained
first.

- **15.1 Plugin marketplace.** `plugin-sdk` (typed manifest + capability grants, first slice
  shipped and fails-closed on ungranted capabilities) → hosted registry transport →
  Deno-isolate sandbox runtime that enforces the grant at execution time.
- **15.2 Federation.** Cross-instance delegation, federated council, CRDT KG sync, OIDC/SAML.
  Leans on `@nexus/a2a` (agent-to-agent) as the delegation transport — start there.
- **15.3 Fine-tuning pipeline.** SFT via `sft-tagger` + `corpus-builder` (dataset assembly →
  export JSONL). Code-only up to the export; training runs are infra/GPU (**Blocked**).
- **15.4 Agentic browser** (`stealth-browser`), **15.5 Desktop** (Electron + offline worker),
  **15.6 Mobile** (React Native + push) — product tracks; each needs its own spec + scaffolding
  decision first.
- **15.7 Per-model capability routing** _✓ shipped_ — `GET /api/v1/llm/route`
  (`lib/model-routing.ts`) ranks the discovery surface by hard requirements (vision /
  toolUse / streaming / minContextWindow / maxOutputNeeded / minReasoningTier) and soft
  preference (capability-first or preferCheapest), returning the pick, the top 5 with
  reasons, and per-candidate unmatched filters when nothing qualifies.
- **15.8 Cheap extraction model.** Wire a small local model (e.g. `llama3.2:1b` on Ollama) as
  the automatic extractor turning execution events into memory, replacing the current
  deterministic distillation in `apps/api/src/lib/mission-memory.ts` (enhancement, not a
  hole — distillation works today at zero cost).

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

## Reference note

`nexus/omni` can front any self-hosted OpenAI-compatible router to inherit a large provider
catalog with zero native driver work. Fine for dev/self-host; for production prefer native
ports (§1) over shipping the sidecar as a silent hard dependency.
