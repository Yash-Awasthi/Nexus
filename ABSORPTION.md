# ABSORPTION.md — inspiration/Nexus → things/Nexus







Living ledger for the mission: **take every repo in `inspiration/Nexus` into `things/Nexus`, literally all features.**



Created 5 Sep 2026. One row per repo; status is updated in the same batch that resolves the repo. Nothing in



`inspiration/` gets deleted and nothing in `things/` moves until every parent ledger is 100% absorbed/duplicate.







## Status legend







- **absorbed** — the repo's features are genuinely integrated into things/Nexus (mapped to a concrete `@nexus/*` package or app and verified this pass / by FEATURES.md).



- **partial** — a matching `@nexus/*` package exists with real code, but full feature parity with the repo is **not yet verified**; flipped to absorbed only after its batch verifies (or closes) every gap.



- **missing** — no implementation found in things/Nexus, or the repo is out of Nexus scope (note says which). These are the real work queue.



- **duplicate** — same GitHub repo as another folder in inspiration/Nexus (twin named in the note). The twin carries the integration; the duplicate itself needs no code.







## Running totals (end of pass 1 — batch 1 resolved)







- duplicate: **10** · absorbed: **18** · partial: **203** · missing: **27**







## The ledger







| # | Repo | GitHub | Status | Notes |



|---|---|---|---|---|



| 1 | graphiti | https://github.com/getzep/graphiti | duplicate | twin: knowledge_graph — both getzep/graphiti (keep one) |



| 2 | knowledge_graph | https://github.com/getzep/graphiti | duplicate | twin: graphiti — both getzep/graphiti |



| 3 | llm-router | https://github.com/vllm-project/semantic-router | duplicate | twin: semantic-router — both vllm-project/semantic-router |



| 4 | openapi-mcp | https://github.com/open-webui/mcpo | duplicate | twin: openapi-to-mcp — both open-webui/mcpo |



| 5 | openapi-to-mcp | https://github.com/open-webui/mcpo | duplicate | twin: openapi-mcp — both open-webui/mcpo |



| 6 | opentelemetry-js | https://github.com/open-telemetry/opentelemetry-js | duplicate | twin: otel — both open-telemetry/opentelemetry-js |



| 7 | otel | https://github.com/open-telemetry/opentelemetry-js | duplicate | twin: opentelemetry-js — both open-telemetry/opentelemetry-js |



| 8 | sdk-typescript | https://github.com/FuelLabs/fuels-ts | duplicate | twin: typescript-sdk — both FuelLabs/fuels-ts |



| 9 | semantic-router | https://github.com/vllm-project/semantic-router | duplicate | twin: llm-router — both vllm-project/semantic-router |



| 10 | typescript-sdk | https://github.com/FuelLabs/fuels-ts | duplicate | twin: sdk-typescript — both FuelLabs/fuels-ts |



| 11 | bullmq | https://github.com/taskforcesh/bullmq | absorbed | FEATURES.md: domain feeds scheduled as BullMQ repeatable jobs (@nexus/task-queue, 774 LOC) (Verified sweep) |



| 12 | debate-engine | https://github.com/OpenDebate/debate-cards | partial | **Correction (batch 1):** repo is a debate-*evidence card search* tool (docx→cards→Solr), not a debate framework. @nexus/debate-engine (verified) implements multi-round debate — AIDebator-inspired contest + Du et al. parallel multiagent-debate + convergence/early-stop rounds (multiagent-debate.ts + detectors, passes 1/34, campaign-tested) — the card-search domain model is not ported; doc parsing/search is generically covered by @nexus/doc-pipeline + retrieval |



| 13 | deliberation | https://github.com/antonbabenko/deliberation | absorbed | → @nexus/deliberation (358 LOC, verified in batch 1: blind phase, cross-pollination, rotating challenger, judge synthesis, collab eval — matches the repo's expert-review debate flow) |



| 14 | ensemble | https://github.com/MLWave/Kaggle-Ensemble-Guide | partial | **Correction (batch 1):** repo is CSV *prediction* ensembling (correlations.py, kaggle_vote.py). @nexus/ensemble-refinement (229 LOC, verified) covers LLM answer ensembling (multi-sample + iterative aggregation) — the CSV correlation/voting tools are not ported (non-LLM, out of core scope) |



| 15 | fastify | https://github.com/fastify/fastify | absorbed | apps/api is Fastify-based (README + FEATURES.md) (Verified sweep) |



| 16 | glicko2.ts | https://github.com/animafps/glicko2 | absorbed | **Integrated in batch 1:** @nexus/glicko-rating rewritten to full Glicko-2 — Illinois volatility algorithm (paper steps 5.1–5.5), rating-period semantics (v, Δ, φ*, φ′, μ′), match history (matches/wins/winRate), draws, RD decay. Verified against Glickman's canonical worked example (1464.06 / 151.52 / 0.05999); 6 vitest tests added (packages/glicko-rating/src/index.test.ts) |



| 17 | how_to_fix_your_context | https://github.com/langchain-ai/how_to_fix_your_context | absorbed | context-engineering guide; equivalent context mgmt implemented (MicroCompactor/LlmCompactor, @nexus/context-*) (Verified sweep) |



| 18 | json-rpc-2.0 | https://github.com/tedeh/jayson | absorbed | FEATURES.md: MCP support = JSON-RPC 2.0 over HTTP (@nexus/mcp-client, 523 LOC) (Verified sweep) |



| 19 | mcp-client-raw-json-rpc-implementation | https://github.com/meanands/mcp-client-raw-json-rpc-implementation | absorbed | **Re-verified batch 5:** @nexus/mcp-client (523 LOC) speaks MCP JSON-RPC 2.0 directly (McpClient/McpHttpTransport, injectable fetch) — the tutorial's raw-JSON-RPC framing is covered; its stdio transport is tutorial scope |



| 20 | moa | https://github.com/togethercomputer/MoA | absorbed | → @nexus/mixture-of-agents (126 LOC, verified in batch 1: layered proposer/aggregator with reference-aware synthesis — matches arXiv 2406.04692) |



| 21 | modelcontextprotocol | https://github.com/modelcontextprotocol/modelcontextprotocol | absorbed | MCP protocol spec absorbed into @nexus/mcp-client (JSON-RPC 2.0 per FEATURES.md) (Verified sweep) |



| 22 | opentelemetry-specification | https://github.com/open-telemetry/opentelemetry-specification | absorbed | FEATURES.md: OpenTelemetry (OTLP) traces (@nexus/telemetry) (Verified sweep) |



| 23 | opossum | https://github.com/nodeshift/opossum | absorbed | **Verified batch 2:** opossum's core wrapper — execute() + fallback, CircuitOpenError, state transitions open/half-open/closed with recovery — ported into @nexus/confidence-circuit-breaker (462 LOC; fallback/execute added this pass, 26 checks green incl. half-open recovery) |



| 24 | pgvector | https://github.com/pgvector/pgvector | absorbed | FEATURES.md: pgvector IVFFlat is the long-term-memory backend (@nexus/db) (Verified sweep) |



| 25 | piston | https://github.com/engineer-man/piston | absorbed | FEATURES.md: 'Piston for several languages' — sandboxed code execution in @nexus/sandbox (Verified sweep) |



| 26 | prometheus | https://github.com/prometheus/prometheus | absorbed | FEATURES.md: per-call cost as Prometheus metrics (@nexus/telemetry + run-cost) (Verified sweep) |



| 27 | servers | https://github.com/punkpeye/awesome-mcp-servers | absorbed | **Re-verified batch 5:** awesome-mcp-servers catalog absorbed into MCP docs (@nexus/mcp-bulk) |



| 28 | swarm-code | https://github.com/openai/swarm | absorbed | FEATURES.md: 'Swarm mode spawns sub-agents … ChannelIndex' (@nexus/agents + agent-runtime) (Verified sweep) |



| 29 | tldrsec_awesome-secure-defaults | https://github.com/tldrsec/awesome-secure-defaults | absorbed | secure-defaults list folded into docs/security + @nexus/secret-guardrail (Verified sweep) |



| 30 | adk-python | https://github.com/google/adk-python | partial | **Verified batch 12:** Google ADK 2.0 (python SDK): model-driven agents, multi-agent hierarchies, sessions/state, eval sets, deploy. @nexus/agent-runtime covers the core loop (ToolAgentRuntime), tool registry, spawn_agents hierarchy, session state; ADK's python SDK breadth (evaluation framework, Vertex deploy adapters) unported |



| 31 | ag2 | https://github.com/ag2ai/ag2 | partial | **Verified batch 12:** AutoGen successor — conversable agents, group chat with speaker selection, code execution. agent-runtime's spawn_agents covers parallel fan-out; group-chat turn-taking (named agents, selectable next speaker) was delivered batch 15 (group-chat.ts: GroupChat/roundRobinPicker/llmSpeakerPicker/TERMINATE, 11 campaign tests — this note predated it); AG2 python breadth (nested chats, inter-chat handoffs, code executors, eval harnesses) is the remaining unported slice (Verified batch 12 + pass 41) |



| 32 | agent-kit | https://github.com/google/adk-samples | partial | ADK Recipes (google/adk-samples): tool-calling loop core now real in @nexus/agent-engine (was a stub — tools execute via injectable executor); ADK sessions/sub-agents/streaming unported (Verified batch 23) |



| 33 | agent-squad | https://github.com/2FastLabs/agent-squad | partial | **Batch 9:** multi-agent orchestration framework shipped as TS+Python+Swift libs (npm/pypi). @nexus/swarm-graph verified real (316 LOC: LLM/Decision/Aggregate nodes, SwarmGraph, global memory) covers the TS graph-orchestration core; full framework (cloud/Swift/built-in tools) unported |



| 34 | agent-swarm-kit | https://github.com/cirosantilli/china-dictatorship | missing | **Folder corrupted batch 14:** the inspiration/Nexus/agent-swarm-kit folder is a mislabeled clone of cirosantilli/china-dictatorship (an unrelated censorship-info site — no agent content at all). No 'agent-swarm-kit' repo exists here to absorb; the row documents what was actually cloned |



| 35 | agentcouncil | https://github.com/Sentry01/AgentCouncil | partial | **Batch 9:** GitHub Copilot skill throwing 3 models in parallel then either building on each other OR debating. Multi-model parallel + council/review mechanism now genuinely covered (@nexus/council deliberative); **pass 57: the build-on-the-others mode — one agent continuing from a peer's output — is sequential context chaining, real in @nexus/agents crew.ts (RoleAgent/Task context chain, batch 14, 13 campaign tests), so parallel-council AND sequential-build are both expressible; the Copilot skill packaging itself remains the unported product** |



| 36 | agentic-memory | https://github.com/vectorize-io/hindsight | partial | → @nexus/memory + memory-consolidation (verified: memory-consolidation header cites always-on-memory-agent lineage; store/consolidate/dedupe/merge/decay/query covered; hindsight's event→LLM insight/reflection synthesis per arXiv:2512.12818 + hosted API unported) (Verified sweep) |



| 37 | ai-debate-council | https://github.com/okjpg/llm-council | absorbed | **Batch 9:** its flow — 5 advisors independent in parallel → anonymized (letter-randomized) peer review answering strongest/blind-spot/missed-by-all → chairman COUNCIL VERDICT (agreements/clashes/blind-spots/recommendation/one-thing-first) — is exactly @nexus/council's new DeliberativeCouncil (deliberative.ts, verified 8 checks). Advisor lenses are pluggable config (Nexus ARCHETYPES panel); skill packaging + context-enrichment guidance unported |



| 38 | ai-gateway | https://github.com/higress-group/higress | partial | **Verified batch 19 (identity confirmed):** row name 'ai-gateway' = Higress, the AI-native API gateway (C++/Go core, WASM plugin platform, k8s ingress). TS analogue surfaces verified: @nexus/gateway (alias-based model routing: ModelTarget/BUILTIN_ALIASES, 817 LOC) + @nexus/admin-gateway (route entries + alias stats). The native gateway core/WASM plugin runtime is out of TS scope |



| 39 | ai-sdk-provider | https://github.com/OpenRouterTeam/ai-sdk-provider | partial | **Verified batch 18 (identity confirmed):** folder/URL = OpenRouter provider FOR Vercel AI SDK (row name was generic). @nexus/llm-drivers (audited: real 2,294 LOC driver layer) ships an OpenRouterDriver (OpenAICompatible) covering multi-model single-key routing, plus Anthropic/Gemini/Ollama/LlamaCpp/Mistral/etc. The AI-SDK provider packaging surface (streamObject/hooks ecosystem) is unported |



| 40 | aiact-audit-log | https://github.com/systima-ai/aiact-audit-log | absorbed | **Verified batch 6:** @nexus/ai-act-audit is a superset — AiActAuditEntry fields annotated per Article 12 paragraphs (12(1)/12(2)(a-c)/12(3)(a-c)/72), SHA-256 hash chain (prevHash/hash), retention policies, PII protection, coverage + compliance-package export; @nexus/audit-logging adds the AuditLogger + genesis chain. aiact's S3/local storage backends are app surface, not ported |



| 41 | aidebator | https://github.com/csv610/AIDebator | absorbed | **Verified batch 9:** @nexus/debate-engine is explicitly 'Inspired by csv610/AIDebator' (header) and implements its full feature list — organizer/supporter/opposer/judge roles, multi-round alternating arguments, quality-threshold termination, 40%-evidence-weighted scoring, acknowledgment bonus, weakness penalty, intermediate feedback (406 LOC, verified). Repo's litellm provider layer + debate CLI/sl apps not ported (engine is transport-injected) |



| 42 | aigate | https://github.com/IronManCantFix/AIGateway | absorbed | **Verified batch 3:** local proxy converting OpenAI<->Anthropic formats = @nexus/gateway's core (817 LOC): routeMessage/toOpenAIRequest/toAnthropicResponse + alias resolution + failover, wired into apps/api/api-bridge.ts. aigate's switch-backend core is a subset |



| 43 | alexgreensh_token-optimizer | https://github.com/alexgreensh/token-optimizer | partial | **Batch 4:** harness-plugin surface (Claude Code/OpenClaw/OpenCode/Codex plugins + live dashboard) is app glue, not a Nexus package; core output compression covered by @nexus/llm-compress. Plugin parity unverified |



| 44 | anthropics_claude-code | https://github.com/anthropics/claude-code | partial | **Verified batch 12 (hooks integration):** Claude Code's lifecycle-hook seam (PreToolUse blocks tool calls with fail-closed merge, PostToolUse redacts/annotates history text, SubagentStop vetoes child verdicts, Stop transforms the final answer) is now implemented in @nexus/agent-runtime (src/hooks.ts + wiring in ToolAgentRuntime and makeSpawnAgentsTool); 15 focused vitest tests in the campaign suite. The closed-source CLI product itself (subscription auth, IDE integration) remains out of scope |



| 45 | any-llm | https://github.com/nomic-ai/gpt4all | partial | **Identity corrected batch 18:** row name 'any-llm' mismatches content — folder is nomic-ai/gpt4all (C++ local inference engine with bindings). Local-model SERVING over HTTP is covered by @nexus/llm-drivers' Ollama/LMStudio/LlamaCpp drivers; the gpt4all native runtime itself (gguf inference, local embeddings) is non-TS |



| 46 | atjsh_llmlingua-2-js | https://github.com/atjsh/llmlingua-2-js | absorbed | **Verified batch 4:** it IS the JS LLMLingua-2 engine behind @nexus/llm-compress's heavy path — defaultLoadCompressor dynamically imports LLMLingua2.WithBERTMultilingual/WithXLMRoBERTa from @atjsh/llmlingua-2 (optional dep) + transformers.js/tfjs |



| 47 | atlassian-labs_mcp-compressor | https://github.com/atlassian-labs/mcp-compressor | absorbed | **Verified batch 4:** @nexus/mcp-compressor (339 LOC) doc states it implements 'the same interaction pattern as Atlassian's mcp-compressor' — 3-tool gateway (list_tools/get_tool_schema/invoke_tool) + compressManifest + CompressedToolProxy |



| 48 | autogen | https://github.com/microsoft/autogen | partial | **Verified batch 15 (group-chat integration):** AutoGen is in maintenance mode behind Microsoft Agent Framework (MAF). Its AgentChat core — conversable agents and group chat with speaker selection — is now in @nexus/agent-runtime (group-chat.ts: GroupChat, roundRobinPicker, llmSpeakerPicker auto mode, TERMINATE ending, 11 campaign tests) reusing the shared LlmToolFn stack. Python AgentChat breadth (nested chats, inter-chat handoffs, code executors) unported; no absorb claim |



| 49 | axon | https://github.com/looplj/axonhub | partial | AxonHub: 'any SDK, any model' AI gateway platform — re-homed to @nexus/gateway + llm-drivers (gateway stack audited batch 19); agent-network mapping dropped (Verified batch 22) |



| 50 | babyagi | https://github.com/yoheinakajima/babyagi | partial | **Identity clarified batch 17:** the clone holds babyagi's v2 FastAPI dashboard app + functionz plugin packs — the classic archived v1 task-planning loop (execution/task-creation/prioritization agents) is NOT in this folder (moved to babyagi_archive per the README). mission-engine mapping corrected (that package is a red-team ops engine — wrong home). v1's function is superseded by @nexus/agent-runtime's ToolAgentRuntime/spawn loop; the v2 app product is out of TS scope |



| 51 | bee-observe | https://github.com/i-am-bee/bee-observe | partial | **Batch 6:** archived (repo banner) Fastify+Mongo collector for bee-agent-framework OTel events. Nexus observability-manager (400 LOC, real) receives/stores observations; MongoDB-backed collector parity unverified |



| 52 | BerriAI_litellm | https://github.com/BerriAI/litellm | partial | **Batch 3:** @nexus/gateway (817 LOC) + llm-gateway (347 LOC) verified real; LiteLLM's per-key/team budgets + spend tracking unverified |



| 53 | bitrouter | https://github.com/bitrouter/bitrouter | partial | **Batch 3:** Rust crate; concepts (aliases/fallback/strategies) covered by @nexus/llm-router (596 LOC, verified). No cost-aware-router package exists — original mapping fixed. Rust impl itself not ported |



| 54 | browser-use | https://github.com/browser-use/browser-use | absorbed | **Verified batch 11:** browser-use's core actor model now implemented in @nexus/browser-automation: perceive→plan→act over numbered `[i_N]` elements (never raw selectors), DOM snapshot format follows the eval_serializer convention ([i_N] marks on interactive elements only, inline leaf text, SVG skipped), stub's planAction/buildPageText heuristics ported as the LLM seam; runs on @nexus/stealth-browser drivers. 11 focused vitest tests. Not ported: cloud service, default LLM-planner calls (heuristic seam instead), CDP geometry queries |



| 55 | bull-board | https://github.com/felixmosh/bull-board | partial | → @nexus/task-queue + apps/ui (BullMQ dashboard parity unverified this batch) |



| 56 | camel | https://github.com/camel-ai/camel | partial | **Verified batch 14 (package audited — real, not stub):** CAMEL role-playing multi-agent research framework. The core primitive — role/goal/backstory-defined agents executing tasks — is now implemented in @nexus/agents (crew.ts RoleAgent/Task/Crew, 13 campaign tests); goal→subtask decomposition now real via @nexus/agents src/planner.ts (planTasks/parsePlan: numbered-step parsing, [role] assignment, format-ignoring fallback, 9 campaign tests — the planner is a single-shot decomposition, CAMEL's two-agent task-inception *conversation protocol* itself remains unported); societal-scaling research breadth unported (Verified pass 40) |



| 57 | chopratejas_headroom | https://github.com/chopratejas/headroom | partial | **Batch 4:** Rust agent-context compressor (tool output/logs/RAG/conversation, reversible). Reversible CCR + tool-output-aware compression present in @nexus/llm-compress (ccrEngine/rtkEngine/headroom+jsonl columnar, verified); 'wrap claude/codex/...' agent surface + content-class breadth not ported. Note: llm-compress's 'headroom' engine name traces to the OmniCompress/OmniRoute columnar lineage, not chopratejas — mapping is thematic, techniques verified separately |



| 58 | chorus | https://github.com/Chorus-AIDLC/Chorus | partial | **Batch 9 mapping correction:** NOT a debate framework — Chorus-AIDLC is a coding-agent **harness** (AI-DLC: agents propose, humans verify; session lifecycle, task DAG, permission matrix, Next.js platform). Correct mapping: @nexus/swarm-graph + multi-reviewer (propose/verify) concepts; product surface (UI/daemon/permissions/MCP) unported. Original debate-engine/council mapping dropped |



| 59 | chouzz_llm-interceptor | https://github.com/chouzz/llm-interceptor | partial | LLM Interceptor (LLI): proxy-layer traffic microscope — masked request/response logging + session grouping now in @nexus/llm-gateway src/traffic.ts (onTraffic sink); interactive watch-mode UI unported (Verified batch 27) |



| 60 | chroma | https://github.com/chroma-core/chroma | partial | → @nexus/retrieval (verified: HNSW ANN core — chroma's default index type — ported as hnsw-index.ts; **where-clause vocabulary now ported** (pass 50): @nexus/retrieval src/where.ts + store wiring — chroma's operator set $eq/$ne/$gt/$gte/$lt/$lte/$in/$nin + metadata $contains/$not_contains array membership, $and/$or composition, shorthand equality, chroma missing-key semantics ($ne/$nin/$not_contains match absent fields), int/float value-typed equality, document $contains/$not_contains substring over entry text, grammar validation; 22 campaign tests. Honest remainder: collection add/query facade + include/projection + persistence + client/server (server product, non-TS-expressible here) **pass 76 closed the facade half** — @nexus/retrieval src/collection.ts (VectorCollection): chroma's named collection API over the existing store + embedder + where vocabulary — add(ids/documents/metadatas, batch embed+persist, length validation, upsert-on-duplicate noted), query(query_texts, nResults, where/whereDocument, include projection) returning chroma's parallel-array envelope (ids/documents/metadatas/distances/embeddings, distances = 1-cosine — engine-metric divergence noted), get by ids/where with the same include, count/delete; 7 campaign tests. Remaining honest remainder: persistence + client/server (chroma's server product, non-TS-expressible here) |



| 61 | circuit-breaker-agents | https://github.com/sno-ai/llmix | partial | **Batch 2:** @nexus/confidence-circuit-breaker now has opossum-style execute/fallback (verified); llmix's agent-level integration specifics still unverified |



| 62 | claude-code-hermit | https://github.com/gtapps/claude-code-hermit | partial | **Verified batch 12:** Claude Code plugin turning an instance into a 24/7 stateful agent: routines (scheduled with precheck scripts), operator-gated proposal system, lessons/observations archive. The autonomy/guardrail seam it drives now exists (batch 12 hooks in agent-runtime); the routines scheduler + stateful handoff archive remain unported |



| 63 | claude-council | https://github.com/aiwithremy/claude-skills-llm-council | absorbed | **Batch 9:** the canonical Karpathy 5-expert council + verdict, ported as DeliberativeCouncil in @nexus/council (convene independent positions → anonymized peer review → chairman synthesis with agreements/clashes/blind spots/recommendation/next-action; ARCHETYPES provides the lens panel). Skill/context-enrichment surface unported |



| 64 | cloakbrowser | https://github.com/CloakHQ/CloakBrowser | partial | **Verified batch 11:** PyPI/npm stealth-Chromium distribution with built-in proxies + TLS/JA3 patching. TS analogue covers UA rotation, canvas/WebGL noise, WebRTC block, Cloudflare bypass — and batch 11 added per-context proxy to StealthProfile (buildContextOptions). Remaining gap is the patched browser binary itself (TLS fingerprint, CDP runtime patch) — not achievable in a TS wrapper |



| 65 | cognee | https://github.com/topoteretes/cognee | partial | **Batch 7:** AI-memory platform (ingest-any-format -> self-hosted KG -> recall). @nexus/memory (3030 LOC) + knowledge-graph (1688 LOC) verified real; cognee's ECL pipeline + platform surface unverified |



| 66 | containarium | https://github.com/FootprintAI/Containarium | partial | **Batch 8:** agent runtime platform (SSH-native isolation, eBPF egress policy, K8s+LXC, GPU passthrough). @nexus/sandbox covers the container-grade execution core; platform orchestration (per-tenant SSH boxes, eBPF/K8s) not ported |



| 67 | context | https://github.com/modelcontextprotocol/servers | partial | **Batch 5:** @nexus/mcp-client verified real (523 LOC). Official reference server *implementations* (filesystem/git/memory/fetch/sequential-thinking) are consumable apps, not ported as Nexus servers |



| 68 | core | https://github.com/vercel/ai | partial | **Identity corrected batch 18:** row name 'core' = the vercel/ai monorepo root (Vercel AI SDK). Its language-model-over-providers core maps to @nexus/llm-drivers' LlmDriver/stream layer (audited real), and the run/orchestration utilities to @nexus/agent-runtime's adapters (llmDriverToStreamFn/llmDriverToToolFn) + ToolAgentRuntime; the AI-SDK generateText/streamText orchestration + React-hooks/provider ecosystem breadth is unported |



| 69 | cortex | https://github.com/cortexlabs/cortex | partial | cortexlabs ML deployment platform (realtime/async/batch serving, autoscaling, k8s): realtime maps to @nexus/gateway + llm-gateway, async queue pattern to async-inference, batch to task-queue; k8s operators non-TS (Verified batch 26) |



| 70 | council-of-high-intelligence | https://github.com/0xNyk/council-of-high-intelligence | partial | **Batch 9:** 18-member historical-thinker catalog + auto-routing/.council.yaml + CLI flags + verdict templates. Its deliberation core (diverse personas, independent positions, forced disagreement, synthesis preserving open questions) now genuinely covered by @nexus/council DeliberativeCouncil; catalog/config/routing machinery unported |



| 71 | crawlee | https://github.com/apify/crawlee | partial | Crawlee TS crawling framework: core loop (targets/queue/checkpoints/retry/proxy) genuinely covered by @nexus/spider (662 LOC) + adaptive-scraper engines. **Session pools + anti-bot heuristics now ported** (sessions.ts, faithful port of crawlee's SessionPool/Session model): per-identity CrawlSession (error-score blocking at maxErrorScore w/ markGood healing by decrement, usage cap, expiry, terminal retire), SessionPool (random/round-robin/use-until-failure reuse, create-while-space, drop-unusable-to-make-room, duplicate-id rejection, getState/restore persistence-shaped snapshots), blocked-status vocabulary (401/403/429), host-matched fingerprint generation, wired into Spider as opt-in sessionPool (per-attempt identity + userData.headers merge, blocked status retires + retries on a fresh identity, successes markGood, network errors markBad) — 24 campaign tests (sessions.test.ts). Honest remainder: crawler breadth (cheerio/jsdom/browser/integrated crawlers need a driver), storages/autoscaling, KV persistence (in-process pool only — divergences documented in module header) |



| 72 | crewai | https://github.com/crewAIInc/crewAI | partial | **Verified batch 14 (Crew integration):** crewAI's core model is now in @nexus/agents (crew.ts, 13 tests): RoleAgent with role/goal/backstory personas, Task with expected output + context chaining, Crew executing sequential or hierarchical (manager delegate→verify→refine, max-iterations cap) processes — crewAI semantics kept behavioural. the python framework's breadth (plugins, guardrails, memory, training, enterprise) is unported; a goal→plan layer now precedes crews (planner.ts, pass 40 — semantic-kernel/CAMEL planner parity); no absorb claim (Verified pass 40) |



| 73 | cross-review | https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep | partial | **Batch 9 re-scope:** repo is ARIS (overnight autonomous research workflow: Claude Code + Codex as independent reviewer + 61-signal fabrication-forensics audit). @nexus/multi-reviewer verified real (432 LOC: parallel model reviews, scoring, disagreements, aggregation) covers the independent-review mechanism; ARIS workflow/methodology/audit surfaces unported |



| 74 | daytona | https://github.com/daytonaio/daytona | partial | **Batch 8:** self-hosted dev-environment manager (**archived June 2026**). VM/container workspaces + API; @nexus/sandbox covers local container execution; workspace-orchestration parity unverified |



| 75 | debatellm | https://github.com/instadeepai/DebateLLM | partial | **Batch 9:** research *library of debating protocols* (many from the literature: debate, society-of-minds, etc.) for Q&A accuracy experiments. @nexus/debate-engine implements three of its protocols (AIDebator-style contest; Du et al. parallel multiagent-debate; convergence-refinement rounds, pass 34); the rest of the protocol zoo + dataset harnesses remain unported |



| 76 | decision-protocols | https://github.com/jongwony/epistemic-protocols | partial | Epistemic Protocols: AI-collaboration misalignment-catch practice collection (plan-level checkpoints) — maps to @nexus/deliberation + proposal-system opinion-consensus mechanics; practice-doc collection, no engine (Verified batch 30) |



| 77 | decolua_9router | https://github.com/decolua/9router | partial | **Batch 3:** @nexus/llm-router + provider-registry verified real; 9router's RTK token-saving + free-model auto-fallback catalog not ported |



| 78 | dr-manhattan | https://github.com/guzus/dr-manhattan | partial | **Mapping corrected batch 12:** CCXT-style unified API for prediction markets (Polymarket/Kalshi…), NOT a coding agent. Original agent-runtime mapping dropped; the TS domain core exists in @nexus/prediction-market (verified real: Market/MarketCache/PmRateLimiter/ApiKeyAuthenticator/MarketBackend). Multi-venue adapter coverage parity unverified |



| 79 | dr-manhattan-ts | https://github.com/gtg7784/dr-manhattan-ts | partial | **Mapping corrected batch 12:** TS port of guzus/dr-manhattan — prediction markets, not agents. Mapped to @nexus/prediction-market alongside row 78; the unified-venue API surface is TS there, per-venue adapter parity unverified |



| 80 | dsherret_ts-morph | https://github.com/dsherret/ts-morph | partial | import-declaration editing (add/merge/remove) ported into @nexus/code-map src/edit.ts (Verified batch 21); compiler-backed rename/navigation out of scope for the regex indexer |



| 81 | e2b | https://github.com/e2b-dev/E2B | partial | **Batch 8:** cloud-sandbox infra + JS/Python SDKs for AI-generated code. @nexus/sandbox verified real (509 LOC, docker+seccomp runner); it is local-only — cloud orchestration side out of scope for a TS monorepo |



| 82 | envoy | https://github.com/envoyproxy/envoy | partial | **Verified batch 19:** CNCF cloud-native edge/middle proxy (C++) — transport infra, non-TS. The LLM-relevant semantic slice (upstream routing, caching, rate limiting, retries) has TS analogues in @nexus/llm-gateway (verified: LLMGateway with cache/rate-limit/retry config) + @nexus/proxy-rotation (rotators); the byte-level proxy core, xDS and filter chain are out of TS scope |



| 83 | example-multi-agent-orchestration-ts | https://github.com/VAIXLNS/VAIXLNS | missing | **Folder corrupt batch 15:** inspiration folder holds an EMPTY clone (remote VAIXLNS/VAIXLNS, zero files) — the row name claims an example multi-agent-orchestration repo but no content exists to absorb |



| 84 | falkordb | https://github.com/FalkorDB/FalkorDB | partial | → @nexus/knowledge-graph (graph-DB server: Cypher/full-text/vector-in-graph/multi-tenant — non-TS, out of scope; concept parity via knowledge-graph nodes/edges/communities + embedded-kg; Cypher-subset query engine (src/query.ts: MATCH/WHERE/RETURN/LIMIT over KGStore) now real, 11 tests (Verified campaign pass)) (Verified sweep) |



| 85 | fastapi-jaeger | https://github.com/blueswen/fastapi-jaeger | partial | **Batch 6:** python demo of OTel->Jaeger tracing. Nexus side now has the export half: llm-tracer spans -> OTLP/HTTP JSON POST /v1/traces (new otlp-exporter, Jaeger OTLP receiver accepts this path, 20 checks green). Demo's python auto-instrumentation content not ported; real-backend interop unverified here |



| 86 | fastapi-observability | https://github.com/blueswen/fastapi-observability | partial | **Batch 6:** three-pillar demo (Prometheus+Loki+Tempo+Grafana). Nexus: prometheus-format (real), new OTLP exporter covers the traces pillar to Tempo; Loki/logs pillar + stack glue unverified |



| 87 | fastchat | https://github.com/lm-sys/FastChat | partial | **Verified batch 19:** python platform for training/serving/eval of chatbot LLMs (controller/worker serving architecture). The async serving pattern maps to @nexus/async-inference (verified real: InferenceQueue submit/poll, MemoryJobStore/KVJobStore) and OpenAI-compatible serving concepts to @nexus/gateway; the python training/eval/arena platform breadth is non-TS out of scope |



| 88 | fastify-mcp-server | https://github.com/flaviodelgrosso/fastify-mcp-server | partial | MCP HTTP server plugin: server-side JSON-RPC core (initialize/tools-list/call/ping/notifications) now in @nexus/mcp-client src/server.ts, transport-agnostic to serve mcp-openapi tools; Fastify plugin binding unported (Verified batch 30) |



| 89 | fastmcp | https://github.com/PrefectHQ/fastmcp | partial | **Batch 5:** Prefect's Python MCP *server framework* has no TS counterpart in Nexus (no mcp-framework pkg; @nexus/mcp-bulk only borrows the name). Server-authoring concept partially covered by tool-registry + server side; parity unverified |



| 90 | firecracker | https://github.com/firecracker-microvm/firecracker | partial | **Batch 8:** KVM microVM in Rust — non-portable systems impl. Isolation *concept* mirrored by @nexus/sandbox's docker profile (network none, memory caps, cap-drop, seccomp, read-only rootfs); VMM-grade multi-tenant isolation not expressible in TS |



| 91 | freshrss | https://github.com/FreshRSS/FreshRSS | partial | FreshRSS self-hosted PHP reader: feed fetch/parse genuinely covered by @nexus/domain-feeds (3,474 LOC: FeedEvent/FeedPage/XML parsing) + mail-ingest; PHP app product (UI/accounts/scheduling) unported (Verified batch 29) |



| 92 | g0dm0d3 | https://github.com/elder-plinius/G0DM0D3 | partial | **Mapping corrected batch 12:** open-source multi-model chat interface for red-teaming/jailbreak research ('liberated AI', AGPL) — not an agents runtime. Re-scoped to the gateway/UI concept family (multi-model chat, post-training-layer probing); safety/red-team harness parity unverified |



| 93 | gateway | https://github.com/Portkey-AI/gateway | partial | **Batch 3:** @nexus/gateway verified real & wired (apps/api/api-bridge.ts); Portkey's load-balancing/canary/budget parity unverified |



| 94 | gemini-llm-council | https://github.com/theerud/gemini-llm-council | partial | **Batch 9:** Gemini extension (Karpathy methodology) + distinctive Autonomous Investigator subagent, hierarchical global/project config, audit personas. Core peer-review + synthesis council flow now covered in @nexus/council; **pass 57: the Autonomous-Investigator SUBAGENT mechanism (spawn → independent research → report back) is agent-runtime territory — ToolAgentRuntime + spawn tool + lifecycle hooks (batch 12, agent-hooks campaign tests); the Gemini-extension persona/hierarchical-config/audit artifacts remain product** |



| 95 | golf | https://github.com/openai/parameter-golf | partial | **Correction (batch 2):** repo is a model-training challenge (compress a parameter), not a benchmark suite. @nexus/evals verified real this batch (ScenarioRunner/BenchmarkTracker); compression-parity in @nexus/llm-compress unverified |



| 96 | gopher-mcp | https://github.com/GopherSecurity/gopher-mcp | partial | **Correction (batch 5):** repo is the MCP **C++ SDK** (multi-language C-API bindings), not a Go server. C++ SDK not ported; protocol concepts covered by @nexus/mcp-client (verified) |



| 97 | gptswarm | https://github.com/metauto-ai/GPTSwarm | partial | swarm-graph verified real (inspired by GPTSwarm's Graph class: LLMNode/DecisionNode/AggregateNode/SwarmGraph); the repo's optimizer half is now ported to @nexus/swarm-graph src/optimizer.ts (optimizeNodeVariant mirrors the SHIPPED swarm/optimizer/node_optimizer code — candidates from positive/negative examples, revised prompt + extended demonstrations, evaluate-and-adopt-best; the paper's bandit framing is not what the code ships — with LLMNode.promptText/applyVariant composition, 7 campaign tests); gptswarm's datasets/experiment harnesses remain non-TS python (Verified batch 22 + pass 39) |



| 98 | graphrag | https://github.com/microsoft/graphrag | partial | **Batch 7:** research project (maintenance mode). Nexus core loop now present: community-report query (graphrag-query engine, verified) + **indexing pipeline added this batch** (index-graphrag.ts: extract->merge->partition->summarize, 18 checks green). Dual-mode split now honest: the community map-reduce GLOBAL mode is GraphRAGQueryEngine (above); **pass 54 ported the LOCAL (entity-anchored) mode** — LocalSearchEngine (src/local-search.ts): lexical query→entity anchoring, hop expansion, graphrag two-tier relationship filter (in-network first, out-of-network ranked by mutual selected-links), token-budgeted entity/relationship tables + linked community reports, single-pass answer — consuming the indexer's own entity/relation/report shapes, 11 campaign tests. Viz remains unported **passes 69-71 served-surface note:** both graphrag engines are now reachable as served MCP tools — createGraphRagMcpServer (packages/graphrag-query/src/mcp-server.ts: graphrag_local_search + graphrag_global_search over the McpHttpServer JSON-RPC seam) with worker/CLI builders adapting the loop ILLMTransport to the QueryRouter, 10 permanent campaign tests; engine code unchanged; viz + source-text units remain unported |



| 99 | graphrag-rs | https://github.com/automataIA/graphrag-rs | partial | **Batch 7:** Rust impl (server/WASM/WebGPU architectures) not portable to TS; the concept now has a TS pipeline in @nexus/graphrag-query (indexer + query engine, verified) |



| 100 | graphrag-sdk | https://github.com/FalkorDB/GraphRAG-SDK | partial | **Batch 7:** FalkorDB-backed GraphRAG SDK; community-report query core present in @nexus/graphrag-query; FalkorDB graph-store specifics unverified |



| 101 | groupmq | https://github.com/alexbudure/queuedash | partial | QueueDash: dashboard UI for Bull/BullMQ/Bee-Queue/GroupMQ — its status metrics aggregate data @nexus/task-queue allTasks() already exposes; dashboard product unported (Verified batch 24) |



| 102 | gvisor | https://github.com/google/gvisor | partial | **Batch 8:** kernel sandbox in Go — non-portable systems impl. Concept mirrored by @nexus/sandbox process/docker isolation profile; kernel-level syscall interposition not expressible in TS |



| 103 | harness-sdk | https://github.com/strands-agents/harness-sdk | partial | **Verified batch 12:** Strands Agents (AWS) — model-driven agent loop, tools, MCP, sessions. agent-runtime's ToolAgentRuntime + mcp-tools bridge + permission gate cover the core; Strands' SDK packaging (python/TS clients, deploy targets) unported |



| 104 | haystack | https://github.com/deepset-ai/haystack | partial | → @nexus/retrieval + doc-pipeline (Python RAG framework: pipeline stages covered by doc-pipeline extract/chunk/embed/store + retrieval + reranker; **pass 53 ported the Pipelines orchestration core**: ComponentPipeline (src/pipeline.ts) — declarative DAG of components with haystack connect-string grammar ('comp.socket'), topo execution, fan-out, variadic multi-sender sockets ordered by sender name, missing-input preflight, cycle rejection — 16 campaign tests incl. doc-pipeline stage composition; haystack's loop components + ecosystem unported) (Verified sweep + pass 53) |



| 105 | hnswlib | https://github.com/nmslib/hnswlib | absorbed | → @nexus/retrieval (verified b10: hnsw-index.ts ports hnswlib.Index + BFIndex — init M/efConstruction/randomSeed, addItems with label-upsert, searchKnn filter+batch, mark/unmarkDeleted, resizeIndex, setEf, getters; distance conventions match C++ spaces l2=sq-euclidean/cosine=1-dot(unit)/ip=1-dot; checked exact vs brute force all spaces, seeded determinism, ≥0.95 recall @1500 pts; persistence/replace-deleted/SIMD/multithread unported) |



| 106 | hystrix | https://github.com/Netflix/Hystrix | partial | → @nexus/bulkhead + confidence-circuit-breaker (breaker fallback/execute now verified batch 2); Hystrix thread-pool isolation + metrics-stream parity unverified |



| 107 | InterceptSuite_ProxyBridge | https://github.com/InterceptSuite/ProxyBridge | partial | **Batch 3:** @nexus/proxy-rotation verified real (345 LOC, 4 rotators + health) + gateway; bridge-specific parity unverified |



| 108 | jaeger | https://github.com/jaegertracing/jaeger | partial | **Batch 6:** Go tracing *backend* — out of scope as a Nexus deliverable. Consumer half now present: otlp-exporter (POST /v1/traces, JSON) added this batch; ingestion by a live Jaeger/collector not verified here |



| 109 | jessefreitas_OmniCompress | https://github.com/jessefreitas/OmniCompress | partial | **Batch 4:** lossless columnar + CCR + log-folding engines present in @nexus/llm-compress (ported lineage per REF comments). **NDJSON/JSONL lossless codec integrated this batch** (jsonlCompress + headroomEngine composes it, 12 checks green). Still missing: tree-sitter code elision (5 langs, aggressive mode) + MCP/CLI/proxy surfaces |



| 110 | judge0 | https://github.com/judge0/judge0 | partial | **Batch 8:** multi-language code-execution API (isolate sandbox). Execution core covered by @nexus/sandbox runner; judge0's API-service surface + 60-language runtime matrix not ported |



| 111 | JuliusBrussee_caveman | https://github.com/JuliusBrussee/caveman | absorbed | **Verified batch 4:** cavemanCompress/cavemanEngine in @nexus/llm-compress: rule-based output compression at lite/full/ultra intensities (CAVEMAN_RANK lite:0/full:1/ultra:2 — matches the repo's level switch), preserved-block protection so code/URLs/errors stay exact, revert-on-corruption. Repo's 'wenyan' intensity + 30-harness plugin distribution surface not ported |



| 112 | kglite | https://github.com/kkollsga/kglite | absorbed | **Verified batch 7:** @nexus/knowledge-graph-lite header states 'Inspired by kglite' (embedded Cypher-queryable KG, 222 LOC) and @nexus/embedded-kg states 'Inspired by KGLite's approach to graph-for-agents' (429 LOC: progressive disclosure, temporal as-of, ontology, MCP). TS embedded-KG-for-agents genuinely covers kglite; python/Rust wheel impls not ported (TS is the point) |



| 113 | Kilo-Org_kilocode | https://github.com/Kilo-Org/kilocode | partial | **Verified batch 12:** VS Code extension (Roo/Cline fork): modes/archetypes, MCP, checkpoints. The runtime concepts land on agent-runtime (+ council archetypes); the IDE extension itself is a product, not a TS-package absorb |



| 114 | kin-openapi | https://github.com/getkin/kin-openapi | partial | **Verified batch 16 (identity confirmed):** Go OpenAPI 3 toolkit (openapi3 model, validation, router) — non-TS. The TS-side spec-modeling/conversion slice exists in @nexus/mcp-openapi (verified: OpenApiDoc model, tool conversion both directions); the Go router/validator breadth is out of TS scope |



| 115 | langchain-ai_langgraph | https://github.com/langchain-ai/langgraph | partial | **Verified batch 12:** graph-based agent orchestration. @nexus/workflow-chain mirrors the core mechanics (conditional/loop/parallel/agent steps, events, SuspendError human-in-loop); LangGraph's checkpointers/platform deployment remain unverified |



| 116 | langfuse_langfuse | https://github.com/langfuse/langfuse | partial | **Batch 6:** LLM engineering platform (trace server + evals + prompts + datasets + UI). Nexus tracing core (llm-tracer + llm-observability GenAI semconv attrs + new OTLP export) + evals verified; platform/UI/datasets parity unverified |



| 117 | leiden-communities-openmp-dynamic | https://github.com/puzzlef/leiden-communities-openmp-dynamic | absorbed | **Reconciliation pass 41:** the repo's feature — modularity-based community detection — is fully present in TS: @nexus/knowledge-graph src/community.ts implements Louvain local-moving + Leiden refinement + multi-level aggregation with resolution γ and a modularity() quality fn, deterministic ordering documented, 8 campaign tests (community.test.ts). The only remainder is the C++ OpenMP dynamic-screening *performance* variant — non-TS-expressible, same category as aider's provider layer at its flip (Verified batch 25 + pass 41) |



| 118 | letta-ai_letta | https://github.com/letta-ai/letta | partial | **Batch 7:** Letta (MemGPT) = memory blocks + archival/recall + agent platform. @nexus/memory (3030 LOC, remember/recall/forget/list + MemoryGraph, verified) covers the memory core; archival-conversation semantics now evidenced covered: @nexus/memory MemoryBlock/TurboQuant streams + recall over persistent entries implement full-history-store-then-search (pass-41 re-audit); the Letta server/agents platform surface remains unported |



| 119 | librecodeinterpreter | https://github.com/usnavy13/LibreCodeInterpreter | partial | **Batch 8:** nsjail-isolated code-interpreter API (LibreChat-compatible). @nexus/code-repl (583 LOC, kernel sessions, verified) covers TS-side execution; the LibreChat-compatible API service surface not ported |



| 120 | lightrag | https://github.com/HKUDS/LightRAG | partial | **Batch 7:** lightweight GraphRAG (LLM extraction + graph merge + dual local/global retrieval). Nexus extraction->merge->community pipeline now present (batch-7 indexer, verified); **pass 55 ported the merge graph-ops half** — mergeGraphEntities (index-graphrag.ts): deterministic surgery on an LLM/caller merge DECISION — source descriptions join onto the target (concatenate|keep_first), mentions sum|max, all relations touching a source rewired to the target, redirected duplicates collapsed onto same-typed edges (mentions max — LightRAG weight=max semantics, descriptions joined), self-loops dropped, inputs not mutated, 10 campaign tests. The merge decision itself stays with the caller/LLM (prompt layer unported); dual-mode retrieval now has structural analogues in graphrag-query's global (community map-reduce) + local (entity-anchored, pass 54) engines — lightrag's specific retrieval decomposition unverified **pass 71 served-surface note:** graphrag-query's local + global engines now expose served tools (graphrag_local_search/graphrag_global_search) reachable from the worker/CLI agent loops via ILLMTransport-adapted builders — dual-mode retrieval is structurally reachable end-to-end; lightrag's exact retrieval decomposition + the caller-side prompt merge layer remain unverified/unported |



| 121 | llm-api-key-proxy | https://github.com/Mirrowel/LLM-API-Key-Proxy | partial | **Batch 3:** @nexus/api-key-rotation verified real (211 LOC, ApiKeyPool) + proxy-rotation; full proxy/resilience parity unverified |



| 122 | llm-cascade-router | https://github.com/cebernic/deepnow | partial | **Batch 3:** cascade core IS absorbed — @nexus/complexity-router's header states 'Extracted from llm-cascade-router' (153 LOC, verified). DeepNow's full gateway + RAG-fusion surface unverified |



| 123 | llm-coding-benchmark | https://github.com/llm-as-a-verifier/llm-as-a-verifier | partial | → @nexus/evals + adaptive-testing (@nexus/evals verified real batch 2; llm-as-a-verifier task parity unverified) |



| 124 | llm-comparison | https://github.com/pingcap/ossinsight | missing | **Correction (batch 1):** repo is OSSInsight — GitHub-events analytics engine, not an LLM compare tool. No Nexus counterpart; the compare concept lives in @nexus/gauntlet (483 LOC, verified) but the repo itself is out of scope |



| 125 | llm-council-am-will | https://github.com/hanzoskill/llm-council | partial | **Verified batch 13:** multi-planner council for bias-resistant implementation plans (parallel planners → anonymize → judge merges best elements). The generic flow is DeliberativeCouncil (verified: convene → anonymized peer review → chairman verdict); the planner-specific prompt layer and plan-merge tuning are the unported remainder |



| 126 | llm-council-app | https://github.com/PromtEngineer/llm-council-app | absorbed | **Verified batch 13 (Borda integration):** v2's distinctive mechanic — tallied (Borda) full anonymous rankings per seat — is implemented in @nexus/council (borda.ts: parseBordaRanking/tallyBorda/formatBordaStandings + DeliberativeCouncil.rankedReview/runRanked, 13 vitest tests in the campaign suite); role personas per seat = ARCHETYPES; consensus/fragmented strength signal feeds the chairman (synthesizeRanked). Not ported: the zero-dependency web-app shell and Vercel AI Gateway key plumbing |



| 127 | llm-council-niveshdandyan | https://github.com/niveshdandyan/llm-council | partial | **Verified batch 13:** multi-model consensus engine (parallel queries, side-by-side live dashboard, anonymous judging) — Python stdlib + vanilla JS. Flow core = DeliberativeCouncil; the live dashboard app itself is an apps/ui concern, not a package absorb |



| 128 | llm-debate-system | https://github.com/appleweiping/WEIPING_COUNCIL | partial | **Batch 9:** Weiping Council — honest multi-model deliberation for local/OpenAI-compatible runtimes with inspectable transcripts (route, model evidence, dissent, timings, warnings, degraded-state). Deliberation mechanism now covered (@nexus/council); **pass 58 ported the transcript-inspectability artifact layer** — @nexus/council src/transcript.ts: createTranscript/recordStage/appendAudit/recordRouting build the run record (stages, audit trail, route evidence), and finalizeTranscript reproduces Weiping's _attach_observability semantics — degraded = OR of protocol/provider/trace/context/confidence sources with the faithful warning strings, non-finite confidence → 0 with clamp flag, confidence capped at success ratio when traces carry errors, deduped sorted warnings, call metrics + total_ms — 11 campaign tests |



| 129 | llm-graph-builder | https://github.com/neo4j/neo4j-graphrag-python | partial | → @nexus/knowledge-graph + graphrag-query (GraphRAG concepts mirrored incl. b7 index-graphrag: docs→community reports→query loop; Neo4j backend/persistence + python entity-resolution/prompt templates unported) (Verified sweep) |



| 130 | llm-speed-benchmark | https://github.com/modelscope/AgentJet | partial | **Correction (batch 2):** repo is AgentJet — agent **RL training**, not a speed benchmark. Honest mapping: @nexus/rlhf-pipeline (238 LOC, real); original load-test mapping dropped |



| 131 | llm-switchboard | https://github.com/Uo1428/llm-switchboard | absorbed | **Verified batch 3:** 4-tier classifier (SIMPLE/MEDIUM/COMPLEX/REASONING) + agentic detection + sigmoid confidence + reasoning override ported into @nexus/complexity-router (prompt-tier.ts, weights/boundaries verbatim from defaults.ts, 16 checks green). Multilingual keyword data is config — EN default ships, other locales injectable |



| 132 | llm-tournament | https://github.com/lechmazur/elimination_game | partial | **Correction (batch 1):** repo is a social-reasoning elimination-game *benchmark* (public/private chat, strategic voting, jury), not a model arena. @nexus/llm-arena + elo-rating (verified) cover judging/ratings; the game benchmark itself is not implemented — port as an eval scenario in @nexus/evals |



| 133 | llm_multiagent_debate | https://github.com/composable-models/llm_multiagent_debate | absorbed | **Batch 9 integration:** Du et al. parallel multi-agent debate (arXiv:2305.14325) ported into @nexus/debate-engine (multiagent-debate.ts): N agents answer independently, each later round embeds the OTHER agents' latest answers in the user message (paper's construct_message verbatim), cumulative per-agent history, majority-final aggregation. 8 checks green incl. sharing/freshness semantics; extended this pass with optional convergence detection + early stopping (runMultiAgentDebate convergence: rounds become a budget, positional-stability/consensus detectors stop once positions hold). Repo's per-dataset eval harnesses (gsm/math/mmlu/biography) not ported |



| 134 | llmcouncil | https://github.com/rachittshah/llmcouncil | partial | **Batch 9 + passes 34-35 audit:** MCP-server protocol router (vote/debate/synthesize/critique/red-team/verify + KS stopping). Protocol-by-protocol audit of llmcouncil src (550 LOC): vote → council borda/rankedReview, synthesize → DeliberativeCouncil.run, critique → council review, debate → debate-engine runMultiAgentDebate convergence (pass 34: llmcouncil's KS/epsilon/patience rule == stability-with-patience detector, injectable); MAV verify protocol now ported to @nexus/council verify.ts (runMavVerification: candidates×verifiers cross-product, structured boolean verdicts, majority tally, anonymize, 8 campaign tests) and the critique/red-team protocols to critique.ts (runCritique: per-response structured feedback — reviewer framing strengths/weaknesses/errors/confidence vs red-team adversary flaws/edge cases/adversarial inputs/failure modes, critics never see their own response, anonymize, 6 campaign tests). Served surface now real: @nexus/council createCouncilMcpServer (mcp-server.ts) exposes council_deliberate/vote/debate/critique/verify tools over @nexus/mcp-client McpHttpServer, one injected transport drives all five protocols, 7 end-to-end JSON-RPC tests. **Pass 66 app wiring: that served surface is now reachable end-to-end from Nexus's own agent loops** — localMcpToolsFromServer wraps the server's real JSON-RPC handle() seam as in-process RuntimeTools (worker agent-mcp.ts pass 60, CLI deliberation-tools.ts pass 63) and the worker's `council.deliberate` job + API `/council/*` routes emit the shared pass-58/66 run transcript; per-invocation tool transcripts share one artifact contract via @nexus/council run-transcript.ts. Unported (repo product shell): llmcouncil's own broker/CLI/providers/cost-tools surface |



| 135 | LLMRouter | https://github.com/ulab-uiuc/LLMRouter | partial | **Batch 3:** @nexus/llm-router verified real (596 LOC: aliases/fallbacks/first+round-robin+least-latency, KNN/MLP/SVM/MF); ulab's academic benchmark_pipeline (router leaderboard eval) not ported |



| 136 | lm-evaluation-harness | https://github.com/EleutherAI/lm-evaluation-harness | partial | → @nexus/evals (ScenarioRunner + BenchmarkTracker verified real batch 2, 400+ LOC); EleutherAI's 60+ task-suite parity unverified |



| 137 | Local-LLM-Arena | https://github.com/sammy995/Local-LLM-Arena | absorbed | → @nexus/llm-arena (205 LOC, verified in batch 1: parallel candidates, blind judge scoring 1–10, winner, prompt-injection defense). Superset: works with local models too (Ollama via @nexus/llm-drivers); the repo's live-stream metrics UI is covered by apps/ui |



| 138 | local-llm-compare | https://github.com/vince-lam/awesome-local-llms | partial | **Correction (batch 2):** repo is a curated *list* of local LLMs, not a tool. Compare capability already exists (@nexus/gauntlet 483 LOC + llm-arena, verified batch 1); the catalog content itself is reference material, not ported |



| 139 | magi | https://github.com/magi/magi | partial | **Mapping corrected batch 14:** magi is a Go K8s GitOps PaaS (FluxCD + Kustomize, multi-cluster config management) — NOT an agent orchestrator. Agent-runtime mapping dropped; re-scoped to deployment/ops concepts (apps/ops tooling), which no batch package covers |



| 140 | maka | https://github.com/apache/maka | partial | **Verified batch 15 (identity confirmed):** Apache Maka — local-first agent workspace (desktop + terminal + evaluation all route through a Runtime Host). Runtime concepts overlap agent-runtime/agents; the Maka product surfaces (desktop UI, eval harness, runtime host) are out of a single TS package's scope |



| 141 | mcp | https://github.com/awslabs/mcp | partial | **Batch 5:** AWS server suite (bedrock/cost-analysis/etc.) are app servers Nexus can consume via mcp-client; AWS-specific servers not ported |



| 142 | mcp-agent | https://github.com/activepieces/activepieces | missing | **Correction (batch 5):** folder/row misnamed — repo is Activepieces (no-code workflow SaaS, git remote verified). Not an MCP-agent library; out of scope |



| 143 | mcp-context-forge | https://github.com/IBM/mcp-context-forge | partial | **Batch 5:** IBM's Python registry/proxy federating MCP+A2A+REST/gRPC w/ governance. Gateway + context-builder + tool-registry (all real) cover slices; A2A/REST federation parity unverified |



| 144 | mcp-framework | https://github.com/QuantGeekDev/mcp-framework | partial | **Batch 5:** QuantGeekDev's TS MCP server framework — directory-based tool/resource/prompt discovery + CLI scaffold. Nexus tool-registry (437 LOC, verified) covers definitions; discovery + server-framework surface absent — candidate integration |



| 145 | mcp-proxy | https://github.com/sparfenyuk/mcp-proxy | partial | **Batch 42:** repo is a transport bridge (stdio<->SSE) + per-path multi-server switchboard. The aggregation facade is now real: @nexus/mcp-client `proxy.ts` — `createAggregatingClient` fans tools/list + tools/call across many McpTransports, name-collision prefix policy, per-server error isolation, merged tool list (7 tests in campaign suite). Remaining: stdio<->SSE network transport bridging (non-in-process) |



| 146 | mem0ai_mem0 | https://github.com/mem0ai/mem0 | partial | **Batch 7:** mem0 memory layer (ADD/search + entity linking across memories; platform). @nexus/memory (3030 LOC, remember/recall/forget/list, userId ACL, TTL, stores, MemoryGraph entity extraction) verified real; mem0's entity-linking retrieval boosting is present in @nexus/memory (pass-39 audit: fusion recall entityIndex + entity-overlap signal, extractEntities/normalizeEntity at remember/recall, weights.entity — memory/src/index.ts fusion retrieval); the hosted platform remains unported (Verified batch 7 + pass 39/41) |



| 147 | metaculus | https://github.com/metaculus/metaculus | partial | **Batch 9:** full Metaculus forecasting *platform* codebase (Django website: questions, tournaments, Brier/peer scoring). @nexus/prediction-market verified real (1456 LOC: Polymarket + Mock backends, cache/rate-limit layers, SwarmPredictor/SwarmConsensus) implements forecasting-market + swarm-consensus concepts; the web platform is non-portable (out of scope for the TS monorepo) |



| 148 | metagpt | https://github.com/geekan/MetaGPT | partial | **Verified batch 17 (mapping corrected):** python multi-agent 'software company' — SOP-driven roles (PM/architect/engineer/QA) passing document artifacts down a pipeline. mission-engine dropped (red-team ops — wrong home). The role→task→artifact-chaining mechanics map to @nexus/agents' crew module (RoleAgent/Task/context, batch 14); MetaGPT's typed SOP document dataflow and python breadth remain unported |



| 149 | Mibayy_token-savior | https://github.com/Mibayy/token-savior | partial | **Batch 4:** bash-output compaction core covered by rtkCompress; structural code navigation + persistent memory (tsbench 97.9% MCP server) are separate agent-tool surfaces — parity unverified |



| 150 | microsandbox | https://github.com/microsandbox/microsandbox | partial | **Batch 8:** Rust local microVMs for untrusted workloads — non-portable. Isolation concept maps to @nexus/sandbox (docker profile); microVM layer not expressible in TS |



| 151 | microsoft_LLMLingua | https://github.com/microsoft/LLMLingua | partial | **Batch 4:** LLMLingua-2 semantic pruning integrated (llmlinguaEngine + compressHeavy, env-gated, via @atjsh/llmlingua-2 + transformers.js, verified). Microsoft's Python reference lib incl. LLMLingua v1 + LongLLMLingua variants not ported |



| 152 | milvus | https://github.com/milvus-io/milvus | partial | → @nexus/retrieval (distributed Go server, non-TS; ANN index core — its search primitive — now present as hnsw-index.ts; **pass 50 added chroma-grammar where/metadata filtering** (src/where.ts + MemoryFilter.where/whereDocument store wiring, 22 campaign tests) — the metadata-filter primitive milvus shares with chroma/weaviate. Honest remainder: collection/schema API + server (product, non-TS-expressible here) **pass 76 note:** the chroma-style in-memory collection facade (VectorCollection add/query/get/include over stores + where, src/collection.ts, 7 campaign tests) now exists in the shared package — but milvus's distributed collection/schema/partition server API remains out (server-shaped, non-TS) |



| 153 | mission-control | https://github.com/AgentSystemLabs/mission-control | partial | **Verified batch 17 (mapping corrected):** Electron desktop control surface managing agentic coding CLIs (Claude Code/Codex/Cursor) across projects via real PTYs + SQLite. mission-engine dropped (red-team ops — wrong home); the process-supervision concepts ARE covered by @nexus/supervisor (verified real: ProcessRegistry/PidFile/HealthChecker/ShutdownCascade/AgentHarness); the Electron/PTY desktop product is out of TS-package scope |



| 154 | mrsimpson_quiet-shell-mcp | https://github.com/mrsimpson/quiet-shell-mcp | absorbed | **Verified batch 8:** quiet-shell's exact operator model ported into @nexus/sandbox (shell-session.ts): include-whitelist mode (only error/summary lines survive), tail_paragraphs always keeping the final summary block, keep/drop mode for rtk-style filtering, QUIET_SHELL_PRESETS (tsc/vitest templates), cwd-tracking ShellSession. 11 checks green. Not ported: MCP-server transport (@nexus/mcp-client is client-only), tool-discovery skill, full per-tool template catalog |



| 155 | multi-agent-orchestrator | https://github.com/Yeachan-Heo/oh-my-claudecode | partial | **Identity corrected batch 15:** folder is oh-my-claudecode (row name claims the AWS multi-agent-orchestrator repo — content mismatch). Actual content: multi-agent orchestration FOR Claude Code/Codex CLIs with an SDK integration path for agent runtimes (OpenClaw/Hermes/Grokbot). Maps to agent-runtime + apps/cli orchestration concepts, not the fan-out scorer in @nexus/agent-orchestrator |



| 156 | multi-ai-advisor-mcp | https://github.com/YuChenSSR/multi-ai-advisor-mcp | partial | **Verified batch 13:** MCP SERVER exposing a multi-Ollama council-of-advisors as a tool; engine side real (@nexus/council). The server wrapper is now composable: @nexus/mcp-client src/server.ts (batch 30) serves any tool set incl. council, and **passes 60-66 wire that served surface into Nexus's own agent loops** (worker localMcpToolsFromServer + CLI deliberation-tools.ts, each invocation leaving the shared run-transcript.ts artifact) — the multi-Ollama council-of-advisors wrapper artifact itself remains unshipped |



| 157 | nano-graphrag | https://github.com/gusye1234/nano-graphrag | partial | **Batch 7:** minimal full-pipeline python GraphRAG. Nexus pipeline pieces verified + assembled this batch (knowledge-graph graph store + graphrag-query indexer->reports->query); chunking/embedding + eval integration end-to-end unverified (pass 53: doc-pipeline ComponentPipeline now supplies the DAG orchestration seam for chunk→embed→KG-index wiring; the wiring itself is unshipped) |



| 158 | networkanalysis | https://github.com/alphaSeclab/awesome-network-stuff | partial | alphaSeclab/awesome-network-stuff: curated security-tools links list (not analysis code) — no engine features to absorb; curation repo (Verified batch 25) |



| 159 | networkanalysis-ts | https://github.com/neesjanvaneck/networkanalysis-ts | partial | Leiden/Louvain clustering + resolution now in @nexus/knowledge-graph community.ts; VOS layout technique unported; deterministic ordering deviates from the paper's random order (Verified batch 25) |



| 160 | neurolink | https://github.com/juspay/neurolink | partial | **Mapping corrected batch 11:** juspay/neurolink is 'the pipe layer for the AI nervous system' — a multi-provider LLM streaming/tool-call gateway (TS), NOT a browser. Original stealth-browser mapping dropped; its provider-streaming/tool-gateway/retry-fallback concepts map to the @nexus/llm-router/@nexus/gateway family (batch 3 theme) |



| 161 | nexusrag | https://github.com/LeDat98/NexusRAG | partial | **Batch 7:** hybrid KG + agentic chat w/ citations. Nexus retrieval + knowledge-graph + graphrag-query (verified) cover the KG-RAG core; citation-attributed agentic chat surface is product-shaped (pass-55 audit: Citation model + 4-char id assembly + markers live in the FastAPI chat app/frontend — not a package mechanic; retrieval evidence → answer attribution composes over LocalSearchEngine evidence if a citation layer is wanted) **pass 71 served-surface note:** LocalSearchEngine is now a served tool (graphrag_local_search, MCP JSON-RPC) with worker/CLI builders — retrieval evidence → answer attribution composes end-to-end if a citation layer is wanted; the Citation model + 4-char id assembly + marker layer remains product-shaped/unported |



| 162 | nodejs-opentelemetry-tempo | https://github.com/mnadeem/nodejs-opentelemetry-tempo | partial | **Batch 6:** demo (Node -> OTel -> Tempo + Prometheus). Traces pillar now exportable via new otlp-exporter (Tempo accepts OTLP); demo stack glue unverified |



| 163 | nodriver | https://github.com/ultrafunkamsterdam/nodriver | partial | **Verified batch 11:** undetected-chromedriver's async successor — direct CDP, no webdriver/selenium. The TS analogue now exists for real: @nexus/browser-automation's actor loop over @nexus/stealth-browser (CDP-capable driver abstraction); nodriver-style proxy config honored via the new StealthProfile.proxy. Not ported: python asyncio API, tab/cookie manager |



| 164 | nyt-connections | https://github.com/lechmazur/nyt-connections | absorbed | **Verified batch 2:** scoring ported into @nexus/evals (connections-eval.ts): normalizeWord/parseGroups, scoreConnections (linear g/4), scoreConnectionsQuadratic ((g/4)^2), runConnectionsBenchmark; tests green vs README spec (perfect=1, 1-group=6.25%) |



| 165 | OmniRoute | https://github.com/diegosouzapw/OmniRoute | partial | **Batch 3:** @nexus/gateway + llm-gateway + provider-registry all verified real; 236-provider catalog + token compression not ported |



| 166 | onyx | https://github.com/onyx-dot-app/onyx | partial | enterprise RAG platform: retrieval+doc-pipeline cover search/RAG primitives; @nexus/connectors are app-auth connectors (GitHub/Slack/...), not data-source ingestion; chat/UI/auth/ingestion platform unported (Verified batch 28) |



| 167 | ooples_token-optimizer-mcp | https://github.com/ooples/token-optimizer-mcp | partial | **Batch 4:** MCP server storing compressed content externally (SQLite) + smart tooling ≈ mcp-compressor + llm-compress ccrStore shape; parity unverified |



| 168 | open-model-council | https://github.com/sanky369/open-model-council | partial | **Verified batch 13:** Perplexity-style web council (Next.js/React/OpenRouter): independent long-form answers → debate → synthesis with per-model breakdown. Model-discovery need is covered by @nexus/provider-registry (verified real: ProviderRegistry/FreeTierPool/BUILTIN_MODELS + models.dev catalogue); flow = DeliberativeCouncil; the web app remains a product |



| 169 | open-multi-agent | https://github.com/open-multi-agent/open-multi-agent | partial | **Verified batch 15:** self-hosted multi-agent orchestration platform (runs in your own environment; agent-to-agent protocol + broker + registry model). Overlaps @nexus/agent-orchestrator fan-out and the new group chat (agent-runtime batch 15); the broker/registry product surfaces are unported |



| 170 | openai_codex | https://github.com/openai/codex | partial | Codex CLI coding agent: agentic loop (tools/permissions/hooks/subagents) genuinely covered by @nexus/agent-runtime + code-repl (ReplLanguage/JupyterMode) + sandbox; CLI product + rollout orchestration unported (Verified batch 31) |



| 171 | openapi-mcp-codegen | https://github.com/cnoe-io/openapi-mcp-codegen | partial | **Batch 5:** OpenAPI→MCP core now present (see openapi-mcp-generator); codegen's raison d'etre is emitting standalone Python server *code* + config + tests — that emission surface not ported |



| 172 | openapi-mcp-generator | https://github.com/harsha-iiiv/openapi-mcp-generator | absorbed | **Verified batch 5:** core contract ported into @nexus/mcp-openapi (openapi-to-mcp.ts): operation→tool w/ operationId naming (dots sanitized, <=64 head__tail_hash), params merged path-level+op (name+in), body under `requestBody` (upstream's key), $ref resolved vs components.schemas, description fallback chain, operationId preserved; + createOpenApiCaller executes the REST call (27 checks green, tsc clean). Not ported (named): x-mcp include semantics, exclude/filter opts, security requirements, deeper schema mapping (integer->number/nullable), CLI |



| 173 | openapi-mcpserver-generator | https://github.com/mcp-gen/openapi-mcpserver-generator | missing | **Folder corrupt batch 16:** inspiration folder is an EMPTY clone (only .git, zero content) — the generator repo was never actually cloned; nothing to absorb |



| 174 | openapi-servers | https://github.com/OpenAPITools/openapi-generator | partial | **Identity corrected batch 16:** row name 'openapi-servers' mismatches content — folder is OpenAPITools/openapi-generator (the huge Java multi-language codegen: client SDKs, mock server, 1,379-line README). Non-TS; the MCP-relevant slice (spec → server tools + live caller) maps to @nexus/mcp-openapi; language codegen breadth is out of scope |



| 175 | openapi-to-mcp-converter | https://github.com/zxypro1/openapi-to-mcp-converter | partial | **Verified batch 16:** the converter's three listed features (automated OpenAPI 3.0 parsing, TS typing, request-proxy parameter mapping) are all genuinely present in @nexus/mcp-openapi — openApiToMcpTools (path/method/param/body conversion with param-location metadata) + createOpenApiCaller (live REST executor with injectable fetch, reserved-header guards) + campaign tests. Remaining: the runnable MCP-server wrapper serving converted tools — the shared server-runtime gap documented on row 156 |



| 176 | openapi-to-mcpserver | https://github.com/higress-group/openapi-to-mcpserver | partial | **Batch 5:** Go tool emitting MCP server *configs*; OpenAPI→MCP core now in @nexus/mcp-openapi (verified); Go config-output surface not ported |



| 177 | opencode-dynamic-context-pruning | https://github.com/Opencode-DCP/opencode-dynamic-context-pruning | absorbed | **Verified batch 4:** DCP's two mechanisms map to @nexus/context-pruner (963 LOC, verified): LLM-summary compaction w/ placeholder continuation message (LlmCompactor, buildCompactionPrompt/formatCompactSummary/buildCompactSummaryMessage) + automatic cleanup (SlidingWindow/TFIDF/ImportanceWeighted pruners, PrunerChain, BudgetGuard). OpenCode plugin shell is harness glue (upstream itself defers to Sleev) |



| 178 | openhands | https://github.com/All-Hands-AI/OpenHands | partial | **Verified batch 12:** now 'Agent Canvas' — self-hosted developer control center platform (event stream, sandboxed runtime, browser). agent-runtime supplies loop/tools/hooks/sandbox seams; the platform (event-sourced app, cloud) is out of a single package's scope |



| 179 | openllmetry | https://github.com/traceloop/openllmetry | partial | **Batch 6:** traceloop SDK = LLM instrumentation emitting OTel GenAI-semconv spans. Nexus matches the manual-instrumentation core: llm-observability (595 LOC, LLM_SPAN_ATTR GenAI attrs + generation records, verified) + llm-tracer startLlmSpan/recordLlmCompletion + OTLP export (new). Auto-instrumentation wrappers (framework/HTTP) unported |



| 180 | opentelemetry-js-contrib | https://github.com/open-telemetry/opentelemetry-js-contrib | partial | **Batch 6:** official auto-instrumentation catalog. Nexus has manual span API + exporter (new); the auto-instrumentation middleware library itself is not ported |



| 181 | otel-grafana-demo | https://github.com/connorlindsey/otel-grafana-demo | partial | **Batch 6:** demo stack; traces/metrics pillars have Nexus analogues (otlp-exporter new + prometheus-format); demo app content not ported |



| 182 | patchright | https://github.com/Kaliiiiiiiiii-Vinyzu/patchright | partial | **Verified batch 11:** patched Playwright fork (stealth at the driver level). @nexus/stealth-browser's PatchrightDriver wraps real patchright via OPTIONAL dynamic import (probe-first isPatchrightAvailable), patchright-style hardened launch args; pass-56 audit confirms patchright is NOT a package dependency — playback falls back to playwright-core. The patched driver source itself is external to a TS library |



| 183 | patchright-nodejs | https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs | partial | **Verified batch 11:** npm distribution of the patched Playwright driver — note CORRECTED (pass 56): stealth-browser does NOT depend on it (only playwright-core is a dep); PatchrightDriver reaches it via optional dynamic import when isPatchrightAvailable() probes true, else falls back to playwright-core — so parity here is the optional-consumer abstraction, not an absorbed dependency |



| 184 | patchright-python | https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-python | partial | **Verified batch 11:** python distribution of the patched Playwright driver; same family as row 182/183. TS wrapper consumes the npm sibling; the python packaging itself is out of TS scope |



| 185 | pdavis68_RepoMapper | https://github.com/pdavis68/RepoMapper | partial | RepoMap: python tree-sitter importance-scored repo map + MCP server; symbol/import map core present in @nexus/code-map (buildCodeMap/searchSymbol), tree-sitter fidelity + MCP surface unported (Verified batch 21) |



| 186 | pg_knowledge_graph | https://github.com/hiyenwong/pg_knowledge_graph | partial | **Batch 7:** PostgreSQL C extension adding graph algorithms (not portable to TS); Nexus knowledge-graph (1688 LOC: nodes/edges/communities/graph-context) implements the concept in TS — mapping is conceptual |



| 187 | pg_seal | https://github.com/dh-orko/Help-me-get-rid-of-unhumans | missing | CORRUPTED ROW: folder holds an unrelated minified JS anti-bot snippet (dh-orko/Help-me-get-rid-of-unhumans); the PG column-encryption repo the row name claims does not exist here — @nexus/db + secret-guardrail parity unverifiable (Verified batch 32) |



| 188 | pgmnemo | https://github.com/pgmnemo/pgmnemo | partial | **Batch 7:** PG-backed persistent memory for coding agents w/ provenance (commit_sha) + hybrid retrieval, no-LLM write path. @nexus/memory PgVectorStore + hybrid search (BM25+RRF, verified) cover the shape; provenance/lesson schema unverified |



| 189 | pgvectorscale-rag-solution | https://github.com/daveebbelaar/pgvectorscale-rag-solution | partial | → @nexus/retrieval + hybrid-search (tutorial mechanism mirrored: RRF over dense+sparse w/ InMemoryBM25 + reranker (pass 52: rerank is now an engine option — reranker?: Reranker post-fusion cut to limit); the Timescale weighted-alpha blend is now real in @nexus/hybrid-search — weightedAlphaFusion: alpha × maxNorm(dense) + (1−alpha) × maxNorm(sparse), one-sided docs kept, HybridSearchEngine fusion:'alpha' mode, 7 campaign tests; **pass 51 added the hybrid single-query where-filter seam** — HybridSearchEngine now accepts chroma/weaviate-grammar where/whereDocument (pass-50 vocabulary) and filters each leg's candidates pre-fusion, both fusion modes, 14 campaign tests (repo itself contains no hybrid-search code — README-only, so the documented Timescale pattern is the groundable spec); Timescale pgvectorscale DB specifics unported) (Verified sweep + pass 38) **passes 69-70 served-surface note:** the mirrored mechanism is now served end-to-end — createHybridSearchMcpServer (one hybrid_search tool: parallel dense+sparse legs, RRF/alpha fusion, where/whereDocument pre-fusion, rerank opt) with worker + CLI builders, 10 permanent campaign tests; Timescale pgvectorscale DB specifics remain unported |



| 190 | phoenix | https://github.com/Arize-ai/phoenix | partial | **Batch 6:** LLM trace + evals server/platform. Nexus: llm-tracer + evals (both verified real) cover the core shapes; Phoenix's tracing server, UI + eval dataset store unverified |



| 191 | platformatic | https://github.com/platformatic/platformatic | partial | Platformatic Node application platform: apps/api + @nexus/runtime wiring cover platform semantics; full product (DB/plugins/deploy) unported (Verified batch 32) |



| 192 | polycouncil | https://github.com/TrentPierce/PolyCouncil | partial | **Verified batch 13:** QML desktop app for multi-model deliberation — local + hosted models in one workflow, live streaming, full decision trail. Concepts land on @nexus/council + transcript/telemetry packages; the Qt desktop client itself is out of TS-package scope |



| 193 | ppgranger_token-saver | https://github.com/ppgranger/token-saver | partial | **Pass 43-47 (engine + 12 processors landed):** @nexus/llm-compress src/token-saver.ts ports the engine (dispatch/chain/gates) + generic/test + **44:** lint/structured_log/package_list/file_listing/search + **45:** git (diff hunks/status/log/...) + **46:** build_output/cargo_clippy + **47:** kubectlOutputProcessor (get pod healthy roll-up + AGE strip, describe keep/noise-section filtering w/ Warning events, logs head/error-context/tail, apply/delete result retention) + dockerProcessor (ps/images tabular column parse w/ running/stopped grouping + dangling count, logs + compose per-service error grouping, pull layer-progress strip, inspect JSON key summarization, stats last-block, compose up/down) + **48:** terraformOutputProcessor (plan/apply/destroy change-block filtering — created keeps attrs, update keeps changed lines w/ ->, unchanged dropped; init provider-version/success/error retention w/ noise drop; output long-value truncation; state list type grouping + show cap; splitlines-exact gates) + **49:** fileContentProcessor (two-category dispatch: source/sensitive-config NEVER compressed for patching; minified summary; .env-variant secret redaction; lock files npm/yarn/toml/json/go.sum name@version extraction; structured json depth-2 summarization/yaml/toml/xml; log head-5/error-context/tail-5; csv 3+2 w/ omitted marker; doc+unknown truncation; extensionless heuristic log/json/csv detection) — 93 campaign tests. PORT PHASE CLOSED — tail stays out with reasons: gh.py PR/issue surface (product-level), maven/gradle + python_install (covered by packageList/build breadth), oc/kubectl porcelain extras (kubectl processor covers the log/get/describe core), ~4 minor processors, CLI hooks (product shell, not a TS-expressible primitive) |



| 194 | predmarket | https://github.com/ashercn97/predmarket | partial | **Verified batch 20:** unified python (asyncio) SDK over Kalshi + Polymarket — one install/format across venues. The unification is genuinely present in @nexus/prediction-market (audited 1,456+ LOC: MarketBackend abstraction with PolymarketHttpBackend/KalshiHttpBackend/MetaculusHttpBackend, PredictionMarketService, MarketCache); the python async SDK surface and in-dev websocket feed breadth are non-TS |



| 195 | proxygatellm | https://github.com/mulkymalikuldhrs/ProxyGateLLM | partial | **Batch 3:** @nexus/gateway + confidence-circuit-breaker + llm-router verified real cover it; 22-provider/free-no-key catalog not ported |



| 196 | qdrant | https://github.com/qdrant/qdrant | partial | → @nexus/retrieval (Rust server, non-TS; HNSW — its core index — now present as hnsw-index.ts; payload filtering/REST+gRPC out of scope) (Verified sweep) |



| 197 | raft | https://github.com/hashicorp/raft | partial | Raft leader election (terms/votes/majority/heartbeat renewal/step-down) ported into @nexus/session-sync src/raft-election.ts; log replication/commit/snapshots out of scope (Verified batch 22) |



| 198 | rayobrowse | https://github.com/rayobyte-data/rayobrowse | partial | **Verified batch 11:** Dockerized Chromium (CDP-exposed) with a coherent fingerprint across browser APIs/graphics/fonts/language/timezone/WebRTC/automation surfaces/network. The coherent-profile *approach* is mirrored in @nexus/stealth-browser (UA/locale/timezone/canvas/WebGL/WebRTC + batch 11's per-context proxy for network coherence); the self-hosted browser image itself is out of TS scope |



| 199 | rebrowser-patches | https://github.com/rebrowser/rebrowser-patches | partial | **Verified batch 11:** source patches to puppeteer/playwright fixing runtime leaks. TS equivalent surface covered behaviorally: --disable-blink-features=AutomationControlled launch hardening + canvas/WebGL/WebRTC init scripts in @nexus/stealth-browser. The source-patch mechanism itself doesn't apply to a wrapper library |



| 200 | resilience4j | https://github.com/resilience4j/resilience4j | partial | → @nexus/bulkhead + rate-limiter (resilience4j retry/ratelimiter/bulkhead parity unverified this batch) |



| 201 | resilient-llm | https://github.com/gitcommitshow/resilient-llm | partial | → @nexus/llm-router + confidence-circuit-breaker (breaker wrapper verified batch 2; router resilience parity unverified) |



| 202 | routellm | https://github.com/lm-sys/RouteLLM | partial | **Batch 3:** MFBilinearRouter (RouteLLM's paper router) verified inside @nexus/llm-router; serving covered by llm-router + gateway. RouteLLM's router *evaluation* framework not ported. cost-aware-router mapping fixed (no such package) |



| 203 | router-for-me_CLIProxyAPI | https://github.com/router-for-me/CLIProxyAPI | partial | CLI Proxy API: multi-account compatible-API proxy for CLI tools — gateway pass-through + proxy-rotation cover routing; multi-account key rotation + OAuth protocol layer unported (Verified batch 27) |



| 204 | rs-clob-client-v2 | https://github.com/Polymarket/rs-clob-client-v2 | partial | **Verified batch 20 (identity confirmed):** Polymarket's official Rust CLOB client (market data, order book, order placement with crypto signing) — non-TS crate. The CLOB semantics are genuinely covered in TS by @nexus/prediction-market: PolymarketClient + PolymarketHttpBackend, ApiKeyAuthenticator, and the order-book engine (createOrderBook/applyOrderBookDelta/bestBid/bestAsk/bookMidpoint/avgPriceForQuantity/parseClobPrice); Rust EIP-712 signing breadth is out of TS scope |



| 205 | rtk-ai_rtk | https://github.com/rtk-ai/rtk | partial | **Mapping corrected batch 12:** 'Rust Token Killer' — high-performance CLI proxy cutting LLM token consumption 60–90%, NOT an agent runtime. Re-scoped to @nexus/llm-compress + the gateway/proxy family (batch 4/3 themes); language-level (Rust) proxy performance out of TS scope |



| 206 | ruflo | https://github.com/ruvnet/ruflo | partial | **Verified batch 12:** ruvnet's agentic-engineering framework (claude-flow family): swarm orchestration, plugins, RuVector DB, UI. agent-runtime's swarm primitives (SwarmRole/SwarmMemberRecord/ChannelIndex/VersionedPlan) + spawn_agents cover the coordination core; plugin marketplace/RuVector/UI unported |



| 207 | sandbox | https://github.com/sandboxie-plus/Sandboxie | missing | **Batch 8 correction:** Sandboxie is a **Windows desktop app-sandboxing GUI** (isolate Win32 apps' filesystem/registry), not a code-execution sandbox — different domain, no TS analogue, no local clone to verify. Out of scope |



| 208 | semantic-kernel | https://github.com/microsoft/semantic-kernel | partial | **Verified batch 14:** now Microsoft Agent Framework (MAF) — enterprise .NET/Python agent kernel (planners, plugins, personas). The persona/role layer conceptually maps to @nexus/agents' new crew module (RoleAgent); planner concepts were previously agent-runtime/workflow-chain — a real goal→step planner now exists in @nexus/agents planner.ts (planTasks→Crew, 9 tests, pass 40); the framework's .NET/Python surface is out of TS-package scope (Verified pass 40) |



| 209 | sentrux | https://github.com/sentrux/sentrux | partial | **Batch 6:** mapping re-scoped — repo is an agent code-quality *feedback sensor* (structural drift detection for agent edits), not server telemetry. Nexus analogues: evals/judge scoring + agent-audit-handlers + alerts (real); sentrux's drift-detection specifics unverified |



| 210 | shannon | https://github.com/KeygraphHQ/shannon | partial | MIS-MAP corrected: Shannon = AI penetration-testing scanner (OWASP exploit execution, SARIF output), not semantic search — re-homed to @nexus/redteam + browser-automation + agent-runtime (PoC-exploit loop); scanner product unported (Verified batch 28) |



| 211 | Shweta-Mishra-ai_tokenmizer | https://github.com/Shweta-Mishra-ai/tokenmizer | partial | **Batch 4:** drop-in-proxy + compression core maps to llm-compress/gateway; graph-backed memory + session checkpointing are separate concerns (@nexus/memory + knowledge-graph) — parity unverified |



| 212 | smart-llm-router | https://github.com/tashfeenahmed/freellmapi | partial | **Batch 3:** llm-router/gateway/proxy-rotation/api-key-rotation all verified real. **Learned per-key-per-model ceiling counters now ported** (limit-learning.ts in @nexus/gateway, faithful port of FreeLLMAPI ratelimit.ts provider-limit learning + escalation ladder + base.ts parseRetryAfterMs): error-body ceiling learning (axis-aware parseProviderLimit — tpd/tpm/rpd/rpm, day-before-minute + tokens-before-requests precedence, refuses axis guessing; CeilingStore applies conservative fill-unknown/lower-too-high, never raises, per-key+model isolation), 429 cooldown bench (transient 90s no-escalation, exhausted escalation ladder 2m→10m→1h→24h rolling 24h, unknown-limit 2+/hr heuristic capped at 10m guess, authoritative Retry-After override with 24h clamp, success clears hits/bench — reversibility), 23 campaign tests. Honest remainder: SQLite quota-observation persistence + x-ratelimit-* header confidence weighting + canMakeRequest/canUseTokens pre-checks (DB/server machinery), signed model catalog, FreeLLMAPI's 34-provider/635-endpoint catalog breadth (reference content) |



| 213 | SmarterRouter | https://github.com/peva3/SmarterRouter | partial | **Batch 3:** @nexus/llm-router ML routers (svm/mlp/knn/mf) verified real; SmarterRouter's benchmark-data aggregation + offline profiling unverified |



| 214 | spark-bench | https://github.com/CODAIT/spark-bench | partial | **Batch 2:** @nexus/load-test verified real (609 LOC); repo is a JVM/Spark workload generator — Spark-specific DSL not ported |



| 215 | spec | https://github.com/github/spec-kit | partial | Spec Kit (markdown spec-driven dev): @nexus/software-sop (565 LOC) + contracts (201 LOC) cover spec/SOP/contract mechanics; spec-kit CLI + doc-parsing surface unported (Verified batch 32) |



| 216 | swarmclaw | https://github.com/swarmclawai/swarmclaw | partial | **Verified batch 14:** self-hosted TS agent runtime + multi-agent framework. Overlaps @nexus/agents (new RoleAgent/Crew) + @nexus/agent-runtime (spawn_agents, batch 12) + swarm-graph; the swarmclaw product runtime (hosting, dashboard) is out of a single package's scope |



| 217 | t3mp3st | https://github.com/elder-plinius/T3MP3ST | partial | T3MP3ST red-team framework: @nexus/redteam (362 LOC: prompt obfuscation Parseltongue/triggers) + browser-automation + agent-runtime cover its exploit loop primitives; framework orchestration unported (Verified batch 30) |



| 218 | temporal | https://github.com/temporalio/temporal | partial | Temporal durable-execution platform: saga compensation (reverse-order undo on failure/abort, not suspension) now in @nexus/workflow-chain; retries/timers/cron already in task-queue; activities/signals/replay unported (Verified batch 24) **pass 75 ported activities + signals** — @nexus/workflow-chain src/durable.ts (DurableRuntime): first-class named activities with a Temporal-style retry policy (initialIntervalMs x backoffCoefficient^attempt capped at maximumIntervalMs, maximumAttempts, last-error surfaced), invoked by name from a workflow body that waits on completion; named signal delivery that wakes a waiting workflow immediately and BUFFERS send-before-handle signals (delivered in order once the body waits on that name); per-workflow isolation, bounded waits (timeoutMs), 9 campaign tests. Honest remainder unchanged: persistence/replay, worker/task-queue activity dispatch, and heartbeats are Temporal server/runtime machinery (non-TS here) — the port is an in-process engine documented as such |



| 219 | tensorzero | https://github.com/tensorzero/tensorzero | partial | **Batch 3:** @nexus/gateway + telemetry + llm-router verified real cover gateway/observability slice. **Audited pass 80 — config-variant experimentation + feedback-driven optimization stays OUT on evidence, not machinery:** the repo's experimentation subsystem (crates/tensorzero-core/src/experimentation/, ~9k LOC Rust) is a DB/runtime platform: ExperimentationConfig (static weighted candidate_variants + fallback_variants, adaptive) over a gateway + Postgres/ClickHouse dataset/inference/feedback store, adaptive experimentation via asymptotic confidence sequences + track-and-stop probability estimation, plus config-applier (TOML upsert of variants/experiments/evaluations). No faithful TS-expressible core exists with a campaign-owned consumer or host — a config-variant runner would duplicate @nexus/evals' dataset/judge mechanics yet still need a variant-config + inference-store platform layer Nexus does not have (un-hosted machinery, pass-74 discipline). Gateway/observability slice covered as noted; the platform (Rust core, DB stores, UI, feedback API) is non-TS product breadth |



| 220 | the-ai-counsel | https://github.com/jacob-bd/the-ai-counsel | partial | **Verified batch 13:** dual-mode deliberation (LLM Council: answer → anonymous peer review with ranking → chairman; LLM Advisors: named personas debating in rounds to a verdict) + MCP tool. Council flow = DeliberativeCouncil, personas = ARCHETYPES, ranking = batch 13 Borda; the named remaining gap — multi-round ITERATIVE debate with convergence detection and early stopping — is now real in @nexus/debate-engine (multiagent-debate.ts convergence option: positional-stability + consensus detectors, patience/minRounds, roundsRun/converged results, 9 campaign tests); the-ai-counsel's dual-mode orchestration is now composable via createCouncilMcpServer (served council tools over MCP, batch-35/37) + DeliberativeCouncil, and **passes 60-66 expose that composition as in-process tools in Nexus's worker agent loop and CLI local agent with the shared run-transcript.ts artifact per invocation**; the repo's packaged dual-mode MCP tool product remains unported |



| 221 | the-llm-council | https://github.com/sherifkozman/the-llm-council | partial | **Verified batch 13:** Python multi-provider orchestration package — adversarial council workflows across OpenAI/Anthropic/Google/Vertex/OpenRouter/local CLIs, schema-validated verdicts with confidence + cost tracking, routed handoff, eval tooling. Deliberation core overlaps DeliberativeCouncil; the provider/CLI matrix and eval harness are the unported breadth |



| 222 | undetected-chromedriver | https://github.com/ultrafunkamsterdam/undetected-chromedriver | partial | **Verified batch 11:** selenium chromedriver binary patcher (anti Distill/Imperva/DataDome). The undetected-* concept's TS analogue = @nexus/stealth-browser driver abstraction + actor loop (browser-automation) + StealthProfile.proxy; the driver-binary patching approach is inherently outside a TS library |



| 223 | unified-kg-rag-on-aws | https://github.com/awslabs/unified-kg-rag-on-aws | partial | **Batch 7:** AWS-native KG-RAG (multilingual corpus -> KG -> multi-hop traversal). Nexus KG + graphrag-query pipeline (verified) cover the concept; AWS infra + multi-hop specifics unverified **pass 71 served-surface note:** graphrag local/global engines now served (graphrag_local_search/graphrag_global_search) and reachable from agent loops; AWS infra specifics + the repo's multilingual-corpus/multi-hop traversal remain unverified |



| 224 | vectorchord | https://github.com/supervc-stack/VectorChord | partial | → @nexus/retrieval (Postgres extension (Rust), non-TS disk-optimized index; concept analogue = retrieval scoring + hybrid-search) (Verified sweep) |



| 225 | voltagent | https://github.com/voltagent/voltagent | partial | voltagent TS framework (tools/MCP/memory/workflow/supervisors): tool-execution core maps to agent-engine's now-executing loop (previously a stub); workflow engine/guardrails/evals unported (Verified batch 23) |



| 226 | weaviate | https://github.com/weaviate/weaviate | partial | → @nexus/retrieval (Go server, non-TS; HNSW core now present as hnsw-index.ts; **pass 50 added chroma-grammar where/metadata filtering** (src/where.ts + MemoryFilter store wiring, 22 campaign tests) — covering weaviate's metadata-filter/where query semantics. **pass 51 closed the hybrid single-query facade gap**: HybridSearchEngine (single-call dense+sparse+RRF/alpha) now carries the where/whereDocument filter seam applied per-leg pre-fusion, mirroring weaviate's hybrid query where clause (14 campaign tests). **pass 52 wired the rerank stage the hybrid doc advertises**: HybridSearchEngine now takes an optional @nexus/reranker (Reranker/BM25Reranker/FunctionReranker/NullReranker — real package, pre-existing tests) and reranks the fused candidates to limit post-fusion, mirroring weaviate's hybrid rerank tool (7 campaign tests). Honest remainder: object+vector model + modules + server (product, non-TS-expressible here) **passes 69-70 served-surface note:** the hybrid single-query surface is now a served tool (hybrid_search: one call over dense+sparse legs with where/whereDocument + RRF/alpha + per-call rerank, MCP JSON-RPC) reachable from the worker/CLI agent loops; honest remainder unchanged — object+vector model + modules + server (product, non-TS-expressible here) |



| 227 | wilmerai | https://github.com/SomeOddCodeGuy/WilmerAI | partial | **Mapping corrected batch 12:** 'What If Language Models Expertly Routed All Inference?' — LLM API middleware with routing/workflows, NOT an agent runtime. Re-scoped to the @nexus/llm-router + gateway family (batch 3 theme); workflow-routing parity unverified there |



| 228 | wirken | https://github.com/gebruder/wirken | partial | **Mapping corrected batch 12:** enterprise gateway/switchboard between messaging channels (Slack/Teams) and agents — single Rust binary, per-agent spend budgets, security-boxed tool reach. The per-action permission model it centers on is implemented in agent-runtime (ActionTier/PermissionGate, verified in the run loop); the channel-gateway product itself is out of TS-package scope |



| 229 | worker | https://github.com/cloudflare/workers-sdk | partial | Cloudflare Workers SDK: @nexus/worker does not exist — re-homed to @nexus/runtime (15,448 LOC: queue backends/event bus/persistence/runtime wiring) covering Workers-style job+queue semantics; edge-runtime SDK surface unported (Verified batch 31) |



| 230 | xrouter | https://github.com/mondyxue/XRouter | missing | **Correction (batch 3):** repo is an Android ARouter Retrofit-style wrapper (Gradle modules, app routing) — NOT an LLM router. Android navigation middleware, out of scope |



| 231 | xrouter-llm | https://github.com/xorbitsai/xrouter-llm | partial | **Batch 3:** @nexus/llm-router verified real; xorbits router algorithms + cost-savings eval unverified |



| 232 | zeroboot | https://github.com/zerobootdev/zeroboot | partial | Rust/KVM sub-ms VM sandboxes via COW forking — native hypervisor out of TS scope; @nexus/sandbox (prepared execution + shell sessions, audited batch 8) is the TS analogue (Verified batch 26) |



| 233 | air-trust | https://github.com/openblockchains/awesome-tetherino | missing | awesome-tetherino crypto list — out of Nexus scope (Verified sweep) |



| 234 | anomalyco_models.dev | https://github.com/anomalyco/models | missing | models.dev marketing site — out of Nexus scope (Verified sweep) |



| 235 | anomalyco_opencode | https://github.com/anomalyco/opencode | missing | opencode marketing site — out of Nexus scope (Verified sweep) |



| 236 | bernstein | https://github.com/sipyourdrink-ltd/bernstein | partial | 'open-source governance layer for AI agents': governance primitives genuinely covered by @nexus/agent-runtime (ActionTier/PermissionGate/hooks) + audit-logging; governance product unported (Verified sweep) |



| 237 | blackwell-systems_gcf | https://github.com/blackwell-systems/gcf | missing | game closure framework — out of Nexus scope (Verified sweep) |



| 238 | consilium | https://github.com/ZFTurbo/asr_consilium | missing | ASR ensemble (ZFTurbo) — out of Nexus scope (speech recognition) (Verified sweep) |



| 239 | contexto | https://github.com/osintbrazuca/osint-brazuca | missing | OSINT source directory (osintbrazuca, PT) — curation repo, out of Nexus scope (Verified sweep) |



| 240 | DietrichGebert_ponytail | https://github.com/DietrichGebert/ponytail | missing | ponytail CSS framework — out of Nexus scope (UI) (Verified sweep) |



| 241 | jcode | https://github.com/1jehuang/jcode | missing | JVM coding tool — non-TS; no TS parity evidence, code-repl is the analogue (Verified sweep) |



| 242 | kiali_kiali | https://github.com/kiali/kiali | missing | Kiali service-mesh UI — out of Nexus scope (not an LLM concern) (Verified sweep) |



| 243 | lattice-d | https://github.com/keijiro/DxrLattice | missing | DxrLattice GPU voxel lib — out of Nexus scope (Verified sweep) |



| 244 | leninejunior_troglodita | https://github.com/leninejunior/troglodita | partial | Troglodita (PT): token-saving/minified-communication tool — re-homed to @nexus/llm-compress + context-pruning family (batch 4 theme); tool product unported (Verified sweep) |



| 245 | lobehub_lobe-icons | https://github.com/lobehub/lobe-icons | missing | icon set — out of scope unless apps/ui adopts it (Verified sweep) |



| 246 | mitos | https://github.com/BuilderIO/mitosis | missing | BuilderIO/mitosis web-component compiler — out of Nexus scope (UI tooling) (Verified sweep) |



| 247 | network-ai | https://github.com/ludwig-ai/ludwig | missing | Ludwig declarative ML framework — Python, non-TS, out of core Nexus scope (Verified sweep) |



| 248 | omp-best-of | https://github.com/wolfiesch/omp-best-of | missing | best-of dev-tools list — out of Nexus scope (docs candidate) (Verified sweep) |



| 249 | onestardao_WFGY | https://github.com/onestardao/WFGY | missing | WFGY ecosystem landing/marketing repo — out of Nexus scope (Verified sweep) |



| 250 | pesto | https://github.com/PestoTech/curriculum | missing | PestoTech curriculum content — out of Nexus scope (Verified sweep) |



| 251 | pmxt | https://github.com/pmxt-dev/pmxt | partial | 'the ccxt for prediction markets' — re-homed to @nexus/prediction-market (verified: Polymarket/Kalshi/Metaculus backends + order-book engine, batch 20); SDK surface unported (Verified sweep) |



| 252 | rekor | https://github.com/sigstore/rekor | missing | sigstore transparency log — out of Nexus scope (Verified sweep) |



| 253 | router | https://github.com/TanStack/router | missing | TanStack Router — out of Nexus scope (web framework router) (Verified sweep) |



| 254 | sage | https://github.com/roots/sage | missing | roots/sage WordPress starter theme — out of Nexus scope (Verified sweep) |



| 255 | toon-format_toon | https://github.com/toon-format/toon | missing | code formatter tool — out of Nexus scope (Verified sweep) |



| 256 | trillian | https://github.com/trillian/trillian | missing | transparency log (merkle) — out of Nexus scope (security infra) (Verified sweep) |



| 257 | v2 | https://github.com/2dust/v2rayN | missing | v2rayN VPN client — out of Nexus scope (Verified sweep) |



| 258 | xyflow_xyflow | https://github.com/xyflow/xyflow | missing | React flow/graph UI library — out of scope unless apps/ui adopts it (Verified sweep) |







## Next batch







**Batch 2 — ratings/arena/resilience verification** (verify against @nexus/elo-rating, llm-arena, gauntlet, evals, load-test, task-queue, confidence-circuit-breaker):



local-llm-compare, golf, nyt-connections, lm-evaluation-harness, llm-coding-benchmark, llm-speed-benchmark, spark-bench, opossum, bull-board, circuit-breaker-agents, resilient-llm, hystrix, resilience4j.







**Batch 3 (preview) — routing theme** (verify against @nexus/llm-router, gateway, provider-registry): LLMRouter, SmarterRouter, bitrouter, routellm, smart-llm-router, llm-switchboard, llm-cascade-router, xrouter, xrouter-llm, tensorzero.



