# Phase 6 Status: Real Agents + Mission Control

**Document:** `docs/PLAN.md`  
**Status:** Complete — Phases 6.1 and 6.2 implemented and tested; only in-app UI checks need a human.  
**Date:** November 21, 2026

---

## 1. Verified Realities & Baseline Truth

1. **Host environment:** drive `D:` is ignored and no local models (Ollama or similar) are used.
2. **Claude Desktop App is installed:** package `Claude_6.28899.6.0_x64__pzs8sxrjxfjjc`, with the MCP entry in
   `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
   pointing at `C:\GITHUB\open\mcp-bridge.exe` (`docs/claude_desktop_config.json` is the merged entry).
3. **OpenCode CLI is installed:** `C:\Users\Yash\AppData\Roaming\npm\opencode.cmd`, reporting `v2.3.2`.
   The `opencode` manifest ships in the binary and its `chat.args` are `run --format json`.
4. **Git:** no repository operations are performed for this phase.

---

## 2. Milestone 6.1 — Real Agent Execution Harness (complete)

- **Thinker:** Claude Desktop reaches the board over stdio JSON-RPC through `mcp-bridge.exe`;
  `board_inbox`, `board_post` and `board_slice` remain the review surface.
- **Doer:** OpenCode runs as a supervised child process. `POST /api/agents/run` claims the task as
  the agent, resolves its manifest, launches `opencode run --format json <prompt>`, and records the
  process in `pkg/agents/supervisor.go`.
- **Claim before launch:** the handler uses the normal atomic claim under a 30-minute lease, so a
  second agent gets `409` rather than double work. A launch failure returns the task to the queue.
- **Live output:** stdout/stderr go to `<board dir>/<channel>/agents/<agent>-supervisor.log`, which
  is also what the inspector streams. `Supervisor.LogPath` is the single naming source.
- **Exit handling:** the server waits on the supervised process; exit code `0` completes the task as
  its owner (force-complete only if ownership was lost), releases its locks, posts the `done:`
  event, and marks the agent idle. A non-zero exit remains wired to the broker's `OnFailure` hook,
  which requeues every claimed/working task owned by that agent and posts a `failed:` event.
- **Manifests:** `ManifestChat` parses the manifest's `chat.args`, so headless chat turns use the
  adapter's own arguments; an explicit `args` list still overrides them.
- **Termination:** `Supervisor.Terminate` ends the whole Windows process tree (`taskkill /T /F`) or
  the POSIX process, waits briefly for the exit, and lets the failure hook recover the work.

## 3. Milestone 6.2 — Mission Control Web Inspector (complete)

`web/index.html` now adds, without a framework or new assets:

1. **Agent console card** — an SSE terminal for `/api/agents/logs?channel=<c>&agent=<a>`. It tails
   the last 32 KiB of the supervisor log, follows appends every 250 ms, waits for a log that does
   not exist yet, and reports connecting/streaming/reconnecting. Agent names are suggested from the
   roster and the supervisor's live processes; output can be cleared or auto-follow toggled.
2. **Human supervisor tie-breakers** — task cards expose `Run with <agent>`, `Mark done`,
   `Force requeue`, and `Terminate @owner`; every file lock has `Unlock`. These call
   `/api/agents/run`, `/api/done` (force), `/api/tasks/requeue`, `/api/agents/terminate`, and
   `DELETE /api/locks?force=true`.
3. **Expandable task drawer** — clicking a card opens its interface contract, required caps,
   dependency, owner, thread, associated file locks, and a live lease countdown (warn under 60 s,
   expired in red). Card expansion and selection survive roster refreshes.
4. **Sprint task creator** — the existing inline form injects tasks with thread, contract, caps and
   a dependency without a terminal.

New or extended HTTP routes:

| Route | Purpose |
| --- | --- |
| `POST /api/agents/run` | Claim a task and launch its agent under supervision |
| `GET /api/agents/logs` | SSE tail/follow of `<channel>/agents/<agent>-supervisor.log` |
| `POST /api/agents/terminate` | End a supervised process tree |
| `POST /api/tasks/requeue` | Force any task back to `queued` and release its locks |
| `GET /api/agents` | Registered agents plus `running` supervisor processes |
| `GET /api/overview` | Now includes `running` processes |

## 4. Milestone 6.3 — Verification

Automated coverage added in this phase:

- `pkg/api/agents_test.go`
  - `TestAgentRunClaimsExecutesAndCompletes`: a helper manifest claims a task, writes the task
    prompt, streams output to the supervisor log, exits 0, and the task becomes `done` with a
    `done:` event; the SSE log endpoint serves the same output.
  - `TestForceRequeueOverHTTP`: a claimed task is force-requeued with its contract intact, and a
    missing task is `404`.
- `pkg/agents/supervisor_test.go`
  - `TestSupervisorStartTaskPassesPromptAndTaskID`: prompt and task id reach the child and the log.
  - `TestSupervisorTerminateStopsARunningAgent`: the whole process stops and cannot be terminated
    twice.
  - `TestSupervisorRefusesASecondTaskForARunningAgent`: one agent process cannot silently take on
    a second task while its first is live.
- `pkg/db/force_requeue_test.go`: force requeue clears owner/lease, keeps the contract, and leaves
  the task claimable.

Full verification commands and results:

```
go build ./...                                  PASS
go test -count=1 ./...                          PASS (all packages)
bash scripts/race-windows.sh ./...              PASS (go test -race, all packages, zero races)
go test -bench=. -benchmem ./pkg/grammar        0 B/op, 0 allocs/op
bash scripts/check-docs.sh                      DOC CHECK PASS
```

Live broker smoke (temporary manifest, no model call): a task was created, claimed by the
supervisor, executed by a stub agent, streamed from its log over SSE, and completed on exit 0.

## 5. External-only checks (not blockers)

- **Claude Desktop in-app review:** requires the desktop UI; the stdio bridge itself is covered by
  `cmd/mcp-bridge/harness_test.go` and the App's config points at the built binary.
- **A real OpenCode model turn:** would spend the user's cloud model credits and is deliberately not
  run; the executable and manifest are verified (`vb discover`), and the launch path is tested with a
  process-level helper.
- **Live R2/B2 upload:** needs `CLOUDFLARE_R2_*` and `OPEN_BOARD_SNAPSHOT_PASSPHRASE`; encrypted
  snapshot behavior is covered locally.
