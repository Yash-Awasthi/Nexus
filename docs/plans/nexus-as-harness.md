# Plan: Nexus as a Coding-Agent Harness

Status: **design** (foundational; not yet implemented)
Branch: `claudecode`
Date: 2026-06-23

Goal: make Nexus usable **as a coding-agent harness** (like Claude Code / jcode) and,
later, as a **parallel multi-agent orchestrator** (the Conductor model). Derived from a
research pass over jcode, hermes-agent, conductor.build, and g0dm0d3 (reference clones at
`~/.cache/harness-research/`), cross-referenced against the current Nexus codebase.

---

## Headline finding: Nexus is ~80% a harness already — it is just **unwired**

`packages/agent-runtime/src/index.ts` already implements a **real iterative tool-use loop**:
`AgentRuntime.run(instruction, signal)` streams the LLM, `ToolStreamParser` extracts
`[TOOL:name]{json}[/TOOL]` calls, `RuntimeToolSet.invoke()` executes them, results feed the
next step, repeating to `maxSteps`. It ships `StrReplaceProcessor` (file edits),
`makeSpawnAgentsTool` (concurrent child runtimes), `llmDriverToStreamFn` (bridge to
`@nexus/llm-drivers`), and jcode-derived swarm primitives (roles, lifecycle, channel pub/sub).

**But it is effectively dead code in production:** the only consumer,
`apps/api/src/routes/api-bridge.ts`, imports just `type AgentDefinition` — no endpoint or
worker instantiates `AgentRuntime`. **The work is integration, not greenfield.**

Known weaknesses to fix while wiring: `maxSteps` default `5` (too low for coding); no
persistent growing message history (each step rebuilds a synthetic "continue" prompt);
`totalTokens` hardcoded `0` (no accounting); custom `[TOOL]` bracket protocol instead of
native provider tool-calling.

---

## Reuse map — what exists vs. what's a gap

| Harness capability            | Nexus today                                                                                                    | Action                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Agent loop                    | `@nexus/agent-runtime` (real, **unwired**)                                                                     | Wire it; fix maxSteps, add message history, native tool-calling |
| Tool dispatch                 | `@nexus/tool-registry` (typed JSON-schema, live in `gateway.ts`)                                               | Bridge into the loop                                            |
| File-edit primitives          | `packages/runtime/src/code-agent-pool.ts` CodeEditor (real disk writes + **path-traversal guard**)             | Convert single-shot agents → loop _tools_                       |
| MCP                           | `@nexus/mcp-client` + per-user encrypted registry (`routes/mcp-servers.ts`) + inbound server (`routes/mcp.ts`) | Wrap `McpClient.callTool()` as loop tools                       |
| Shell / exec                  | `@nexus/sandbox` (Docker `--network=none --cap-drop=ALL`), `@nexus/code-repl`                                  | Wrap `executeCode` as a `run_command` tool                      |
| Multi-model quality           | council / gauntlet / consortium / best-of-n / multi-reviewer (mature)                                          | Use as gates, not default-on (token cost)                       |
| Job substrate                 | `apps/worker` BullMQ priority queues + `IExecutionAdapter` seam (`task-executor.ts`)                           | Run agent sessions as `agent.run` jobs                          |
| Governance                    | `GovernanceEngine` (allow/deny + approval gates)                                                               | Gate dangerous tool calls                                       |
| Parallel / worktree isolation | —                                                                                                              | **Gap** → Conductor model + Nexus Drive                         |
| Learning loop (skills/memory) | file memory exists                                                                                             | **Gap** → hermes-style forked background review                 |
| CLI front-end                 | `apps/cli` (no `nexus code`)                                                                                   | **Gap** → add `nexus code <task>`                               |
| True sandbox                  | Docker only; self-documents gVisor/Firecracker "not yet implemented"                                           | Nexus Drive Firecracker spike (separate initiative)             |

---

## Borrowed architecture (ideas only; map to Nexus)

- **hermes-agent → Programmatic Tool Calling (PTC).** The model writes _one_ script that calls
  tools over RPC; **only stdout returns to context** — a 20-step pipeline collapses into one
  turn at near-zero context cost. Highest-leverage token saver. Also: forked background
  memory/skill review (reuses warm prompt cache), summary-only subagent delegation with a hard
  "never mutate past context — re-inject as a fresh turn" invariant, and the declarative
  `ProviderProfile` pattern for BYOK. (MIT — adaptable with attribution.)
- **conductor.build → "workspace = git worktree = unit of delegation; branch/PR = unit of
  integration."** Each parallel agent gets its own worktree + branch + **PORT range** + context;
  no central scheduler — _decomposition is the orchestration_. Lifecycle hooks
  (`setup`/`run`/`archive`) as committed config; merge-gating on aggregated checks. Maps onto
  **Nexus Drive**. (Closed-source; ideas only.)
- **g0dm0d3 → race-with-early-exit + synthesize-reducer + EMA AutoTune.** Already maps onto
  Nexus gauntlet/consortium/drift; adopt the _patterns_ (wave-staggered launch, `minResults` +
  grace + AbortController early-exit, `ParamDelta` transparency, a scorer-calibration test
  harness). **AGPL-3.0 — never copy code; clean-room from description only.** Its jailbreak
  layer (godmode prompt, Parseltongue) is **out of scope**.
- **jcode** (Rust harness) — swarm primitives are _already partially in_ `agent-runtime`. Full
  inspection still pending (the inspector hit a rate-limit cap during research).

---

## Phased build plan

### Phase 0 — Wire the loop (highest value, lowest risk)

Promote `AgentRuntime` to a first-class executor.

- Implement an `IExecutionAdapter` (`canExecute`/`execute`, see `task-executor.ts`) that runs
  `AgentRuntime.run()` for `code*` task types — replacing single-shot `CodeAgentPool` dispatch.
- Add a BullMQ `agent.run` job in `apps/worker` and stream progress over the existing SSE bus.
- Fix the loop: raise `maxSteps`, add a real growing message array, wire token accounting,
  prefer native provider tool-calling.
- **DoD:** a multi-step coding task runs end-to-end on a trusted dir and streams steps.

> **Status (2026-06-23): substantially implemented** (uncommitted, branch `claudecode`).
> Done: native tool-calling across `@nexus/llm-drivers` (Anthropic + 15 OpenAI-compat;
> Gemini/Ollama text-only follow-up); `ToolAgentRuntime` + `llmDriverToToolFn` bridge in
> `@nexus/agent-runtime` (real message history, configurable `maxSteps`=50, token
> accounting; old `[TOOL]` text loop kept for back-compat); `AgentRuntimeAdapter`
> (`IExecutionAdapter`) in `@nexus/runtime` + optional `adapters` in
> `createGhostStackOrchestrator`; `agent.run` BullMQ job + BYOK driver factory in
> `apps/worker`. All five packages typecheck; 145 unit tests pass (llm-drivers +
> agent-runtime). **Remaining for true end-to-end:** Phase 1 tools wired into the
> `RuntimeToolSet` (the loop runs single-turn until then) and a worker→API SSE relay
> for live step streaming.

### Phase 1 — Tools

Give the loop real capabilities.

- Bridge `@nexus/tool-registry` tools into `RuntimeToolSet`.
- `edit_file` (reuse CodeEditor's apply + path-traversal guard), `find_files`, `read_file`.
- `run_command` wrapping `@nexus/sandbox` (Docker runner).
- MCP tools: wrap `McpClient.callTool()` from the per-user registry.
- **DoD:** the agent can locate, read, edit, run, and call external MCP tools.

### Phase 2 — Sessions, permissions & compaction

Concrete design from jcode (`crates/jcode-base/src/safety.rs`, `jcode-compaction-core`,
`jcode-session-types`); see `~/.cache/harness-research/_jcode_conductor_findings.md`.

- **Permission gate (two-tier).** `ActionTier::{AutoAllowed, RequiresPermission}`. Auto-allow the
  read-only allowlist (`read, glob, grep, ls, list_files, memory, todo*, *_search`); everything
  that mutates (`write_file, edit_file, run_command`, MCP calls) requires approval. Back it with
  Nexus's existing `GovernanceEngine` (allow/deny + approval gates); queue requests
  (`{id, action, description, rationale, urgency}`) and surface approve/deny over the SSE/event bus;
  auto-deny requests whose session died. Pass a `ToolContext` (session/abort/workingDir) into each
  tool handler — widen `RuntimeTool.handler` to `(args, ctx?)` (back-compatible).
- **Context compaction.** Add a compactor to `ToolAgentRuntime`: budget 200k, compact at 80%,
  hard-compact at 95%, keep last 10 turns verbatim, flat-charge images at ~1.6k tokens (NOT raw
  base64 length — that causes compaction loops), ~18k system+tools overhead. Summarize older turns
  with a 4-section prompt (Context / What we did / Current state / User preferences).
- **Session persistence/resume.** Persist `ToolRuntimeResult.messages` + a `SessionStatus`
  (Active/Closed/Crashed/Compacted/RateLimited/Error — types already in `@nexus/agent-runtime`).
- **DoD:** sessions resume; mutating ops require approval; long sessions compact instead of 4xx-ing.

### Phase 3 — Parallel orchestration (Conductor model)

Concrete config contract from Conductor docs (verbatim in the findings doc).

- Worktree-backed workspaces: per-agent git worktree off `origin/<base>` **after a fetch**,
  one-branch-one-worktree; converges with **Nexus Drive**.
- **`.nexus/settings.toml`** mirroring `.conductor/settings.toml`: `[scripts] setup/run/archive` +
  `run_mode = concurrent|nonconcurrent` (nonconcurrent for a single shared port/DB/Docker). Scripts
  run from the workspace dir.
- **Per-workspace env:** allocate a 10-port range (`NEXUS_PORT`..`NEXUS_PORT+9`) +
  `NEXUS_ROOT_PATH` / `NEXUS_WORKSPACE_PATH` / `NEXUS_WORKSPACE_NAME`. Process stop:
  SIGHUP → 200ms grace → SIGKILL.
- **Merge gating ("checks"):** aggregate git status + PR + CI + todos; soft-gate merge while todos
  open / checks fail; round-trip review comments back as the next agent prompt.
- Archive-not-delete with restore (incl. transcript). Decomposition drives parallelism — no scheduler.
- **DoD:** N agents run in parallel on isolated worktrees; results return via branch/PR.

### Phase 4 — Learning loop + PTC

- Forked background pass proposing `MEMORY.md`/skill updates (reuse warm cache or a digest).
- PTC: expose the tool layer to a sandboxed child over local RPC; only stdout returns.
- **DoD:** the harness captures skills/memory autonomously and collapses pipelines via PTC.

### Front-end (parallelizable with Phase 1+)

- Add `nexus code <task>` to `apps/cli` (currently HTTP-client only, no agent command).

---

## Risks & open decisions

- **AGPL contamination.** g0dm0d3 is AGPL-3.0; Nexus is Apache-2.0. Use its ideas only —
  clean-room implementations from this doc, never copied source.
- **Sandbox is dev-isolation, not a security boundary.** Current child_process/Docker isolation
  is inadequate for untrusted multi-tenant code (the packages say so). Untrusted execution waits
  on the Nexus Drive Firecracker spike — do not block the harness on it; run single-tenant /
  Docker first.
- **Don't over-build the planner.** `planning-engine.ts` is AWS-infra-shaped; for coding, let the
  agent loop self-plan and use the orchestrator mainly for governance, queueing, and retries.
- **Multi-model gating.** council/gauntlet multiply spend — gate behind config, never default-on.
- **Tool protocol.** Decide native provider tool-calling vs. the existing `[TOOL]` bracket
  protocol before Phase 1 hardens around either.

---

## References

- Reference clones: `~/.cache/harness-research/{jcode,hermes-agent,g0dm0d3,ponytail,caveman}`
- **Phase 2/3 source-level findings: `~/.cache/harness-research/_jcode_conductor_findings.md`** (jcode permission/compaction/session internals + Conductor settings.toml/env/run_mode, verbatim)
- Conductor docs: https://www.conductor.build/docs/
- Related Nexus docs: `.claude/NEXUS_DRIVE_SANDBOX.md`, `docs/ARCHITECTURE.md`
- Memory: `nexus-as-harness`, `nexus-working-branch`, `nexus-drive-feature`
