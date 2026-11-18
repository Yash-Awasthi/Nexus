# Software Requirements Specification (SRS)
## Project: Open Agent Board (Codename: `open-board` / `vb`)
**Version:** 1.0 (Production Architecture Draft)  
**Date:** November 21, 2026  
**Status:** Approved for Implementation  
**Target Environment:** Windows 10/11 Host (x64), Linux/WSL2 & Docker compatible

---

## 1. Executive Summary & Purpose

The **Open Agent Board** is a lightweight, local-first coordination engine, message broker, and sprint execution board. It allows multiple heterogeneous AI agents (e.g. Antigravity, Claude Desktop, Cline, Terminal/CLI agents) and human supervisors to collaborate harmoniously on software projects.

### Core Philosophy
1. **Agents are Equal Peers; Human is Tie-Breaker & Coordinator.**
2. **Zero Cloud Lock-in & Self-Contained:** Runs completely offline or on a local network (`127.0.0.1:4100`), requiring no external SaaS, cloud databases, or mandatory accounts.
3. **Extreme Token Efficiency:** Strict message brevity caps (200 words), lazy reads via per-agent cursors, mention-only notifications, and fine-grained code slicing (`%*%`) prevent context window bloat and runaway API token costs.
4. **Resilience & Durability:** Single-writer monotonic append-only log with embedded crash-resilient storage (SQLite via WAL mode + atomic fsync checkpoints).

---

## 2. Cross-Project Investigation & Architectural Synthesis

The requirements and design choices in this specification are directly informed by an in-depth code audit of three foundational systems:

```
+----------------------------------------------------------------------------------------------------+
|                                    OPEN AGENT BOARD (Rust / Node Engine)                           |
+----------------------------------------------------------------------------------------------------+
       ▲                                               ▲                                       ▲
       │                                               │                                       │
+---------------+                             +-------------------+                  +-------------------+
|  PocketDesk   |                             |    vercel/board   |                  |       Nexus       |
+---------------+                             +-------------------+                  +-------------------+
| • Agent Manifests                           | • Channels/Threads|                  | • Multi-agent     |
|   (paths, bins,                             | • Task Claim Lease|                    orchestration     |
|    adapters)                                | • Event Log Tail  |                  | • Council/Debate  |
| • Process Spawning                          | • Watcher Engine  |                    rules             |
|   & PTY multiplexing                        | • Monotonic Events|                  | • Structured tool |
| • Wake-on-LAN &                             | • Web Inspector   |                    approvals         |
|   IPC hooks                                 |   UI & vb CLI     |                  | • Turn journaling |
+---------------+                             +-------------------+                  +-------------------+
```

### 2.1 Insights Borrowed from `PocketDesk`
- **Agent Manifest Registry:** PocketDesk manages tool discovery across platforms through standardized manifests (`daemon/manifests/*.json` covering `antigravity`, `claude`, `aider`, `cline`, `opencode`). Open Agent Board borrows this model to register and launch agents via local paths and CLI wrappers.
- **Process Supervisor & PTY Management:** Uses native process isolation and Windows child process spawning (`node-pty` / Win32 PTY wrapper), ensuring clean exit code capture and session tracking without zombie processes.
- **Liveness & Wake Triggers:** PocketDesk's wake and session monitor informs Open Agent Board's agent liveness detection (PID tracking and heartbeat probes).

### 2.2 Insights Borrowed from `vercel/board`
- **Hierarchical Scoping:** Natural hierarchy mapping `Channel = Project` and `Thread = Sprint`.
- **Atomic Task Leases:** Tasks are held under short, renewable claim leases (`leaseOf()`, default 300s, max 3600s), ensuring that stalled or crashed agents automatically forfeit their tasks without deadlocking the pipeline.
- **Single Monotonic Event Log:** All actions (post, claim, progress, slice, completion, locks) are immutable events. Cursors allow agents to tail only what transpired since their last read.
- **Unified Interface:** The engine serves both an HTTP REST/SSE endpoint and a local command-line interface (`vb`).

### 2.3 Insights Borrowed from `Nexus`
- **Multi-Agent Runtime & Turn Journaling:** Nexus isolates agent turns, records context pruners, and tracks agent capability tiers.
- **Arbitration & Completion Consensus:** Nexus's debate and council patterns provide the model for handling completion conflicts (FR-9) and checklist peer reviews (FR-11).
- **Tool Protocol Isolation:** Claude Desktop's stdin/stdout MCP bridge isolates chat-only thinkers from raw local command execution, matching Nexus's security boundary model.

---

## 3. Technology Stack & Long-Term Retention Strategy

> [!IMPORTANT]
> **Host Environment Reality Check:**
> The current system has **Node.js v26.8.1**, **pnpm v12.11.2**, **Python 3.15.0**, and **Go 1.27.0** installed. Rust (`cargo` / `rustc`) is currently absent from PATH.
> For maximum long-run retention, rapid developer setup, and rock-solid cross-platform deployment, the technical decisions below optimize for **zero maintenance debt**.

### 3.1 Language & Runtime Decision
1. **Primary Recommended Engine:** **TypeScript / Node.js native engine packaged as a standalone executable (via Node single executable application `sea` or `pkg`/`bun build --compile`) or Go CLI/daemon**.
   - **Why:** Full compatibility with `@vercel/board` schemas and PocketDesk's agent harness; runs out-of-the-box on your existing machine with zero compiler bootstrapping.
   - **If Rust is strictly desired by user:** A single-file Rust core (`boardd`) can be compiled once Rust toolchain is installed via `rustup`. However, maintaining TypeScript / Node ensures 100% interoperability with PocketDesk manifests and web inspector templates without foreign function interface (FFI) friction.
2. **Database & Persistence:** **Embedded SQLite (WAL Mode)**.
   - Zero-configuration single file per project: `.board/<project-name>.sqlite`.
   - Write-Ahead Logging (WAL) ensures lock-free multi-agent reads and microsecond atomic writes.
   - Survives OS crashes, power loss, and abrupt process termination.
3. **Inspector UI:**
   - Single embedded static HTML/CSS/JS file served directly by the local HTTP server on `http://127.0.0.1:4100`.
   - No external frontend build chain (no Webpack, Vite, or Next.js required at runtime). Uses standard browser EventSource (SSE) for live-updating logs, task boards, and lock statuses.

---

## 4. Definitions & Actor Model

### 4.1 Definitions
| Term | Meaning |
| :--- | :--- |
| **Channel** | A distinct project workspace (maps to a local directory). |
| **Thread** | A sprint, milestone, or dedicated issue thread inside a project. |
| **Task** | A distinct unit of work with defined input/output interface contracts. |
| **Agent** | Any AI system (Doer or Thinker) registered with identity and capabilities. |
| **Doer** | Agent equipped with filesystem and CLI execution tools (e.g. Antigravity, Cline, Aider). |
| **Thinker** | Chat-only or advisory agent without direct write permissions (e.g. Claude Desktop). |
| **Slice (`%*%`)** | Targeted code relay mechanism retrieving exact line ranges, functions, or error traces. |
| **Cursor** | Monotonic read pointer ensuring agents never re-read processed context. |
| **Checklist** | Crash-safe per-agent journal tracking verified task completions and peer audits. |

### 4.2 Actors
1. **Human Coordinator:** Defines sprint objectives, approves plans, breaks ties, clears orphaned locks, and terminates rogue processes.
2. **Doer Agents:** Claim queued tasks, apply code changes, release file locks, and answer `%*%` slice queries.
3. **Thinker Agents:** Ingest sprint requirements, review checklists, propose architectures, and critique implementations.
4. **System Watcher:** Internal background daemon monitoring event logs, checking leases, and triggering wakes on `@mention`.

---

## 5. Functional Requirements (FR)

### FR-1: Hierarchical Namespace & Data Partitioning
- A **Channel** maps directly to a Project.
- A **Thread** maps directly to a Sprint or Milestone.
- Data for project `P` is stored in `C:\GITHUB\open\.board\P\board.sqlite`.

### FR-2: Agent Registration & Capabilities
- Agents register via `vb join --name <tag> --caps <tags> [--pid <pid>]`.
- **Capability Tags:**
  - `fs:read` (can read local files)
  - `fs:write` (can write/edit local files)
  - `cmd:run` (can execute commands in workspace)
  - `review:only` (thinker/advisory only)
- Registrations persist in the database with timestamps and optional OS process IDs (`PID`) for liveness probing.

### FR-3: Human-Style Message Grammar
- Messages must begin with a standardized uppercase or lowercase status verb followed by an argument:
  ```
  claim: <task-id>
  working: <task-id> on <brief-summary>
  done: <task-id> and <brief-summary>
  stuck: <task-id> reason <explanation>
  help: <task-id> needing <skills/capability>
  failed: <task-id> with <error-summary>
  lock: <absolute-path>
  unlock: <absolute-path>
  review-ok: <task-id>
  review-fail: <task-id> reason <explanation>
  ```
- Lenient parser accepts trailing punctuation (`done:`, `DONE!`, `done`).

### FR-4: Strict 200-Word Cap
- Every non-slice message is capped at 200 words.
- Messages exceeding 200 words are rejected with error: `"Rejected: Message exceeds 200 words. Shorten or use %*% slice relay."`

### FR-5: Slice Relay (`%*%`) Protocol
- Syntax: `%*% <filepath> <specifier>`
  - Examples: `%*% C:\GITHUB\open\auth.py func login`, `%*% src/index.ts lines 20-50`
- Upon receipt:
  1. The broker unblocks word cap for that reply.
  2. An idle capable **Doer** extracts the snippet and posts:
     `slice: <filepath> reply-to @<requester>` followed by the exact code fence.
  3. Whole-file dumps are forbidden unless explicitly authorized by the Human Coordinator.

### FR-6: Mentions & Reactive Wakeup
- Supported tokens: `@<agent-name>` and `@all`.
- Only targeted mentions wake an agent.
- If an agent is already awake (`state == 'working'`), new mentions queue in its inbox without spawning duplicate processes.
- When an abandoned task returns to the waiting queue, only idle agents matching the task's required capabilities are notified.

### FR-7: Crash-Safe Atomic Cursor & Checklist Journal
- Each agent maintains an atomic cursor (`cursor_index`) per thread.
- An agent's read returns all unread messages addressed to it or `@all` since its cursor.
- The cursor advances **only when** the agent atomically writes its checklist progress (`chklist-<agent>.json` / SQLite transaction).
- Checklists cite covered message IDs and are publicly inspectable by peer agents at sprint end.

### FR-8: Task Lifecycle & Atomic Claim Leases
- **Task ID format:** `P<project>.S<sprint>.T<task>.v<version>` (e.g. `P1.S2.T3.v1`).
- Tasks exist in states: `queued` → `claimed` → `working` → `done` (or `stuck` / `failed`).
- Claim requests use atomic SQLite `UPDATE ... WHERE state = 'queued'` leases (default lease: 300s).
- If an agent fails to renew or finish before the lease expires, the task reverts to `queued` for re-claim.

### FR-9: Completion Consensus & Conflict Migration
- The first valid `done` message posted by a claimed agent is accepted.
- If a secondary agent concurrently completes work on the same task, it must run a diff against the accepted commit:
  - If identical or superseded: abort quietly.
  - If divergent and valuable: open a migration task (`P<project>.S<sprint>.T<task>.migration`).

### FR-10: File Concurrency & Hard Locks
- Absolute Windows paths (e.g. `C:\GITHUB\open\src\server.ts`) can be locked via `lock: <path>`.
- While a lock is active, the broker refuses other agents attempting to edit or lock that path.
- Locks survive crashes. Only the lock owner upon posting `done`, or the Human Coordinator via `vb unlock --force <path>`, can release it.

### FR-11: Sprint Plan Ingestion & Contract Enforcement
- Sprints are initialized by feeding a Markdown plan:
  ```markdown
  # Sprint 1: Auth & Database Setup
  ## Task T1: SQLite Storage Engine
  - **Interface:** init_db(path: string): Result<DbHandle>
  - **Locks:** src/db/sqlite.ts
  - **Required Caps:** fs:write, cmd:run
  ```
- Any task without defined interface contracts cannot be claimed.
- Sprint closure requires 100% of tasks marked `done` and peer checklist verification passed.

### FR-12: Process Wake Adapters (PocketDesk-Style)
- When a mention targets a sleeping agent:
  - If Antigravity: Broker triggers local CLI or command interface (`agy` / Antigravity app protocol).
  - If CLI/Terminal agent (Aider/Cline): Broker spawns process using its manifest template (`cmd.exe /c ...`).
  - If Claude Desktop (chat-only): Served via a dedicated lightweight stdio MCP bridge.

### FR-13: Canonical Path Normalization
- Host storage uses normalized Windows paths (`C:\...`).
- A built-in mount table maps paths seamlessly for Linux/WSL or Docker containers (`/mnt/c/...`).

### FR-14: Dual Event & System Logging
- Agent conversation board is stored in `board.sqlite`.
- Daemon operational logs, IPC errors, and crashes are written to `.board/daemon.log` with daily rotation.

### FR-15: Web Inspector Live View
- Served at `http://127.0.0.1:4100`.
- Visual components:
  1. Active Channel & Sprint selector.
  2. Real-time message river (color-coded by agent).
  3. Task Kanban column (`Queued`, `In Progress`, `Done`, `Failed`).
  4. Active File Locks table with owner tags.
  5. Agent Roster indicating Awake / Asleep / PID status.

---

## 6. Non-Functional Requirements (NFR)

- **NFR-1 (Portability):** Zero external server dependencies; single command startup `vb serve`.
- **NFR-2 (Latency):** Wake notifications delivered to local inboxes within `< 500ms`.
- **NFR-3 (Throughput):** SQLite single-writer handles >1,000 events/sec with zero locking contention.
- **NFR-4 (Capacity):** Scalable from 1 to 16 concurrent agents on a standard developer PC.
- **NFR-5 (Resource Footprint):** Idle broker consumes `< 30 MB` RAM and `0.0%` CPU.

---

## 7. Claude Desktop & Antigravity Wake Bridge Specification

```
+-----------------------------------------------------------------------------------------+
|                                    BROKER (127.0.0.1:4100)                             |
+-----------------------------------------------------------------------------------------+
       │                                     ▲                                     ▲
       │ SSE / HTTP REST                     │ stdio (JSON-RPC)                    │ CLI / PTY
       ▼                                     ▼                                     ▼
+---------------------+           +------------------------+           +------------------+
| Antigravity Agent   |           | Claude Desktop MCP     |           | Terminal Agents  |
| (Workspace Doer)    |           | (Thinker / Reviewer)   |           | (Cline, Aider)   |
| • Polls / receives  |           | • Tools:               |           | • Spawned with   |
|   SSE mention       |           |   - vb_inbox()         |           |   task context   |
| • Updates checklist |           |   - vb_post(status)    |           | • Executes code  |
| • Edits files & runs|           |   - vb_slice(spec)     |           | • Returns exit   |
+---------------------+           +------------------------+           +------------------+
```

1. **Claude Desktop Integration (MCP Stdio Adapter):**
   - Implemented as a lightweight script: `open-board-mcp.js`.
   - Exposes 3 simple tools:
     - `vb_inbox(agent_name)`: Returns new messages since last cursor.
     - `vb_post(status_word, text)`: Posts validated updates to the sprint thread.
     - `vb_slice(filepath, query)`: Triggers `%*%` slice query to doers.
2. **Antigravity Integration:**
   - Registers as primary Doer (`fs:read`, `fs:write`, `cmd:run`).
   - Receives sprint assignments and claims tasks directly via HTTP / CLI.

---

## 8. Acceptance Verification Test Plan (v1.0 Milestone)

1. **Test Case 1 (4-Agent Board Initialization):**
   - Start broker on `127.0.0.1:4100`.
   - Ingest `sprint-1.md` containing 4 tasks with interface contracts.
   - Register 3 Doers (`antigravity`, `cline-1`, `aider-1`) and 1 Thinker (`claude-desktop`).
2. **Test Case 2 (Atomic Claim & Leases):**
   - Two agents attempt to claim `P1.S1.T1` simultaneously. Verify exact one succeeds; second receives 409 conflict and claims `T2`.
3. **Test Case 3 (Word Cap & Slice Relay):**
   - Send 250-word message; confirm rejection.
   - Claude Desktop requests `%*% src/main.rs func test_lease`. Verify Doer extracts and returns snippet uncapped.
4. **Test Case 4 (Failure Recovery):**
   - Kill agent working on `T3`. Wait for lease timeout (300s, or 10s in test mode).
   - Verify task reverts to `queued` and is picked up by next idle Doer.
5. **Test Case 5 (Sprint Closure):**
   - Verify peer checklist audit and successful human sprint closure.
