<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Roadmap

Single forward-looking plan. Open work only; shipped items are dropped (read the git
history for what landed). Grouped by theme, not by sprint. Each item is independent
unless a dependency is noted.

**Standing rules for every item below:**

- Scope work to one package: `pnpm --filter @nexus/<pkg> typecheck && test`, not whole-repo.
- SPDX `Apache-2.0` header on every new file (`pnpm check:headers`).
- New env vars go in `.env.example` with a comment.
- Secrets/tokens never logged. Encrypt third-party credentials at rest.
- Conventional Commits; branch off `main`.
- Anything that makes a live outbound call (provider key, MCP test, OAuth) is gated
  behind explicit user go.

---

## 1. LLM provider breadth

Native `llm-drivers` covers ~19 providers plus the local sidecar router (`nexus/omni`)
and Bedrock/Vertex BYOK. Remaining:

- **Azure OpenAI driver** — custom base URL + `api-version`; enterprise requirement.
- **Tier-A OpenAI-compatible drivers** (each ~12 lines, copy an existing driver,
  `pnpm scaffold:driver`): zhipu/glm, moonshot-intl, lingyiwanwu (01.ai), baichuan,
  minimax, stepfun, novita, siliconflow, doubao/volcengine, hunyuan, spark, hyperbolic,
  chutes, nebius, venice, byteplus, qwen, ai360, vercel-ai-gateway. Batch ~10 per PR;
  add a MockTransport test + `.env.example` entry per provider.
- **Tier-A2 non-OpenAI-shaped** (need a request/response adapter, coordinate with the
  translation matrix below): cloudflare-workers-ai, replicate (prediction-poll), baidu
  ernie (access-token OAuth), alibailian, dify, xinference.
- **Aux providers route to existing packages, not `llm-drivers`:** image-gen
  (flux/stability/recraft/fal/comfyui), voice (elevenlabs/deepgram/cartesia/assemblyai),
  retrieval/reranker embeddings (voyage/jina/cohere-embed), search (exa/brave/serper).
- **Custom-driver framework** — document + simplify the provider interface so adding one
  doesn't require touching `llm-drivers` internals.
- Seed model metadata (pricing, ctx limits, modality, cutoff) from the models.dev JSON
  API into `provider-registry`.

> Don't silently skip a provider that needs non-trivial auth — list it as an explicit
> deferred item with the reason, never drop it.

## 2. Format-translation matrix — `@nexus/llm-translate` (new)

Gateway speaks only Anthropic↔OpenAI today. Build a canonical-format hub (every input →
one internal representation → every output; N+N, not N×N) so Tier-A2 providers and
provider-OAuth endpoints work.

- Define the canonical message/chunk/tool schema (reuse `llm-drivers` types).
- Port the format-agnostic concerns first: tool-call mapping, thinking/reasoning,
  finish-reason, usage, modality, image.
- To-canonical + from-canonical per format: openai, claude, gemini, vertex, responses,
  ollama.
- Wire into `gateway`, replacing the bespoke Anthropic↔OpenAI translate without regression.
- **DoD:** golden-file tests (same logical request → correct wire bytes per format);
  streaming chunk translation verified (SSE deltas, tool-call partials, thinking blocks).

## 3. Token compression — `@nexus/llm-compress` (new)

Output-side compression (current packages only prune input). Check `plugin-modes` /
`context-pack` first to avoid rebuilding.

- **Structured-payload encoders (highest ROI, cheap deps):** adopt `@toon-format/toon`
  and a GCF encoder — opt-in, lossless, −40–90% on uniform arrays / code symbols.
- **Lossless tool-output filters** (pure string→string, golden-tested): git diff/status,
  grep, find, ls, tree, dedup-log, smart-truncate, read-numbered, build-output.
  Auto-detect tool-output type → apply matching filter.
- **Opt-in system-prompt injectors** (default off; never silently alter agent semantics):
  terse-output mode, YAGNI/minimal-code mode. Named presets = filter+injector stacks.
- **Heavy lossy mode (opt-in):** `@atjsh/llmlingua-2` dep (⚠️ auto-downloads a 57 MB–2.2 GB
  model on first use).
- Toggle via `x-nexus-compress` header + per-agent default; log measured saving per
  request (no silent black box).

## 4. Provider OAuth + accounts — `@nexus/llm-oauth` (framework landed)

Framework, AES-256-GCM vault, token refresh (dedup), and the Google Vertex provider
exist. **Sanctioned third-party OAuth only — no subscription-CLI routing, no official-CLI
client-ID reuse.** Remaining:

- **Security review of the token vault before any live token is stored** (threat-model:
  encryption at rest, master-key handling, token scoping, no logging, revocation path).
  Hard gate on everything below.
- Login/callback API routes in `apps/api/src/routes/` (PKCE for web, device-code for
  headless).
- Refresh-token DB persistence + a revoke/delete path that purges creds.
- Additional providers only where a documented third-party auth path exists; otherwise
  leave a TODO with the reason (azure-openai, github-models are stubbed `supported:false`).
- **Multi-account pool + tier ladder — `@nexus/llm-accounts` (new):** N creds per provider
  with health/cooldown/quota state; route picks healthy highest-tier-that-fits
  (sub→cheap→free); cooldown on 429/auth-fail; new router strategies (weighted,
  power-of-2, quota-aware, tier-ladder); per-provider circuit breaker. Dedup + jitter to
  avoid refresh/cooldown thundering-herd.

## 5. Quota, cost & multi-tenant billing

`token-budget` rate-limits but there is no cost model or quota hierarchy. Extend
`billing` / `governance` / `telemetry`:

- Per-provider/model input+output (+cache-hit) cost table, seeded from `provider-registry`
  / models.dev.
- Quota hierarchy (token < user < account), enforced pre-call; exhaustion returns a clean
  typed error, not silent overspend.
- Billing lifecycle: estimate → reserve → settle, reconciling streaming partials + overage/refund.
- Per-request prompt/completion/cache token breakdown → usage analytics UI route.

## 6. Multi-agent orchestration

`@nexus/agent-orchestrator` (worktree fan-out → score → winner-merge, council-backed
scoring, merge defaults OFF) + the `orchestration.run` worker job exist. Remaining:

- Persist orchestration state in Postgres so runs survive a worker restart.
- UI compare/merge view in `apps/ui` (diff per candidate; manual or scored winner select).
- Checkpoint / resume-from-checkpoint (langgraph-style durable execution) and an
  evidence-first verification gate before merge.

## 7. Coding-agent harness (`agent-runtime` wiring)

`agent-runtime` is a real tool-use loop but under-wired. Native tool-calling,
`ToolAgentRuntime`, the `agent.run` BullMQ job, and the `IExecutionAdapter` seam exist.
Remaining:

- **Tools into `RuntimeToolSet`:** bridge `tool-registry`; `edit_file` (reuse CodeEditor
  apply + path-traversal guard), `find_files`, `read_file`, `run_command` (wrap
  `@nexus/sandbox`), MCP tools (`McpClient.callTool()` from the per-user registry).
- **Worker→API SSE relay** for live step streaming (last gap for true end-to-end).
- **Sessions, permissions, compaction:** two-tier permission gate (read-only auto-allow;
  mutating ops require approval via `GovernanceEngine`, surfaced over the event bus);
  context compactor (budget 200k, compact at 80%, hard at 95%, keep last 10 turns,
  flat-charge images ~1.6k tokens); session persist/resume by `SessionStatus`.
- **PTC (programmatic tool calling):** expose the tool layer to a sandboxed child over
  local RPC; only stdout returns to context.
- **Forked background learning loop:** propose `MEMORY.md` / skill updates off a warm
  cache or digest.
- `nexus code <task>` command in `apps/cli` (currently HTTP-client only).

> g0dm0d3 is AGPL — ideas only, clean-room, never copy source.

## 8. Nexus Drive — per-user sandboxed CLI + storage (flagship)

Persistent per-user 512 MB quota-capped workspace running a CLI in an isolated microVM.
Design locked in `.claude/NEXUS_DRIVE_SANDBOX.md`. Cannot finish in a quick pass — needs a
KVM host. Locked decisions: Firecracker primary (gVisor / Docker fallback), FS-level
512 MB quota (loopback ext4 / XFS project quota, soft-warn ~90% + grace then hard block),
30-day idle reclaim, user supplies their own LLM key via `.env` in `/workspace` (not BYOK
injection), persistent volume + ephemeral compute.

- **Isolation spike (throwaway, decision gate):** prove Firecracker + 512 MB FS quota
  end-to-end on the target host; confirm KVM. Fall back to gVisor / Docker-with-limits if
  impractical. **Needs a KVM host — external infra blocker.**
- **Storage + schema:** `drive_workspaces` table (userId, volumePath, quotaBytes,
  lastActiveAt, state); per-user volume provision/teardown; FS-level (not app-level) quota.
- **Runtime package:** `packages/sandbox` (or extend `@nexus/code-repl`) — ephemeral
  microVM bound to the user volume, CPU/RAM/PID/wall-clock caps, policy-gated egress.
- **API + worker:** `/api/v1/drive/*` (create/exec/upload/ls/quota) behind
  `requireAuthWithTier`; BullMQ job for lifecycle (provision, idle-reclaim, quota sweep).
  Drive usage metrics (Prometheus), idle-reclamation cron (30-day), backup/export endpoint.
- **UI:** terminal + drive panel (`sandbox.tsx` exists); `.env.example` seeded into fresh
  workspaces; quota meter with soft-warn UX.
- **Hardening:** egress allowlist, secret-hygiene (never log `.env`), abuse/runaway limits.

## 9. Security hardening

- `run_tool_script` PTC sandbox — Worker-thread isolation for the `AsyncFunction` path.
- Per-user API-key rate limiting (current limiter is IP-based only).
- Docker sandbox: seccomp profile, read-only rootfs, user-namespace remapping.
- Security-baseline pass over `apps/api`: Helmet headers, SSRF filter on outbound
  provider/tool calls, output sanitize, prompt-injection guard (`awesome-secure-defaults`).

## 10. UI surfaces over existing backends

- **Prompt versioning** — backend (`prompts` / `prompt_versions` routes) is complete; add a
  version-history drawer to `prompts.tsx` (list versions, view read-only, restore = new
  version). Needs migration `0009_prompts_and_build_tasks.sql` (these raw-`pg.Pool` tables
  have no migration yet — exist only in prod Neon).
- **Build task DAG** — `build.tsx` filters out subtasks; add a Board↔Graph toggle, render
  `parentId` edges with `@xyflow/react` (already installed, used in `workflows.tsx`), reuse
  the existing `TaskDetailPanel`. Treat orphan `parentId` as roots, log don't drop.
- **MCP server registry** — servers are hardcoded/in-memory. New `mcp_servers` table +
  migration `0010`, per-user CRUD routes (`requireAuthWithTier`, fail-closed key encryption
  via `secret-crypto`, key write-only, never return raw), a `/test` route (live outbound —
  gate behind user go), and an `mcp-servers.tsx` route modeled on `provider-keys.tsx`.
- **Workflow UI polish** — `workflows.tsx` exists; add `@lobehub/icons` provider/model
  icons and feed models.dev metadata into the picker.
- Medium-term pages over mature backends: voice (push-to-talk + streaming transcription),
  image-gen Sandbox tab, knowledge-graph viz, prediction-markets dashboard, gauntlet
  benchmark page, RLHF thumbs-up/down feeding `rlhf-pipeline`, eval-runner UI.

## 11. Memory upgrade — `packages/memory`

Concept-only (memory stays a library, not a server): entity linking + temporal reasoning +
multi-signal fusion (BM25+vector+entity, single-pass extract) à la mem0; self-editing typed
memory blocks (human/persona/scratch) à la letta.

## 12. MCP breadth + A2A (optional / last)

Cherry-pick MCP tools Nexus lacks (sandboxed, no unscoped capability); add an
agent-to-agent JSON-RPC-over-SSE protocol (authn'd, no impersonation) to complement
orchestration. Consider `mcp-compressor` to shrink tool manifests 60–95%.

## 13. Domain feeds

`domain-feeds` has 16 domains. Add: legislative tracking (congressional bills, EU
directives), scientific preprints (arXiv, bioRxiv), earnings & SEC filings (EDGAR, 8-K),
social signals (Reddit, HN — rate-limited), supply chain (AIS shipping, port congestion).
Dark-web sources need careful legal review first.

## 14. Production multi-tenant hardening

Mostly external-infra / ops, scoped here for completeness:

- DB: PgBouncer pooling, read replicas for analytics, PITR, encryption at rest.
- Auth: RS256 JWT for multi-service, OAuth device flow for CLI, session revocation + audit,
  brute-force backoff.
- Observability: OTel distributed tracing across services, SLO dashboards, alerting, per-
  tenant cost attribution.
- Infra: K8s HPA for api+worker (chart in `infra/helm/nexus/`), multi-AZ Postgres/Redis,
  CDN, edge DDoS protection.
- Compliance: SOC2 readiness, GDPR data-residency + right-to-deletion, no-LLM-data-logged.
- Raise test coverage toward 80%+ across `council`, `memory`, `runtime`.

## 15. Long-term / ambitious

Multi-tenant SaaS (org isolation, per-org quotas, Stripe), plugin marketplace
(`plugin-sdk` → hosted registry, Deno-isolate sandboxed execution), federation protocol
(cross-instance delegation, federated council, CRDT knowledge-graph sync, OIDC/SAML trust),
fine-tuning pipeline (SFT from conversation history via `sft-tagger` + `corpus-builder`),
agentic browser over `stealth-browser`, desktop app (Electron shell + local offline
worker), mobile app (React Native + push on task completion).

---

## External-infra blockers (cannot be done from code alone)

| Task                       | Blocker                                  |
| -------------------------- | ---------------------------------------- |
| Firecracker microVM spike  | KVM host (bare-metal or nested-virt VM)  |
| gVisor fallback testing    | Linux host with `runsc`                  |
| Docker sandbox e2e         | Docker daemon on the worker host         |
| Redis cluster rate-limit   | Upstash / managed Redis                  |
| PgBouncer pooling          | DB admin                                 |
| K8s HPA deploy             | K8s cluster (chart ready in `infra/k8s/`)|
| Grafana dashboards         | Grafana instance (configs in `infra/`)   |
| Stripe webhook verify      | Stripe dashboard                         |
| Provider OAuth app reg     | Google/GitHub dev consoles for client IDs|

## Reference-router note

`nexus/omni` can front any self-hosted OpenAI-compatible router to inherit a large provider
catalog with zero native driver work. Fine for dev/self-host; for production, prefer native
ports (sections 1–3) of the capabilities you depend on rather than shipping the sidecar as a
silent hard dependency.
