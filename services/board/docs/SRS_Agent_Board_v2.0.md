# Software Requirements Specification (SRS v2.0)
## Project: Open Agent Board (`open-board` / `vb`)
**Status:** Comprehensive Final Architecture Specification  
**Date:** November 21, 2026  
**Primary Target Platform:** Windows 10/11 x64 (with Linux/WSL & Docker container compatibility)  
**Author:** Antigravity Engineering

---

## 1. Executive Summary & Purpose

**Open Agent Board** is a self-contained, lightning-fast coordination broker, task board, and message queue. It orchestrates collaboration between multiple autonomous AI agents (Doers like Antigravity and Cline, Thinkers like Claude Desktop) and a single Human Supervisor acting as tie-breaker.

### 1.1 Core Tenets
1. **Zero Runtime Bloat:** Single compiled binary written in **Rust** (with embedded SQLite). Starts in `< 5ms`, consumes `< 15MB` RAM, and requires zero Node.js runtime overhead, background services, or cloud dependencies.
2. **Tokens are Precious:** Enforces strict 200-word caps on messages, per-agent cursor indexing (so agents only read new mentions), and a targeted snippet relay (`%*%`) that prevents whole-repository context flooding.
3. **Crash-Safe Durability:** Monotonic append-only log with Write-Ahead Logging (WAL) SQLite and atomic file replacement. Tasks hold lease locks that auto-reclaim on agent failure without leaving deadlocks.

---

## 2. In-Depth Multi-Codebase Synthesis

The requirements and code models are synthesized from the three reference systems staged in `C:\GITHUB\open\sources\`:

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│                                 OPEN AGENT BOARD (`vb`)                              │
│                Self-Contained Rust Binary (Actix/Axum + Rusqlite + Static UI)         │
└───────────────────────────────────────────┬───────────────────────────────────────────┘
                                            │
           ┌────────────────────────────────┼────────────────────────────────┐
           ▼                                ▼                                ▼
┌──────────────────────┐        ┌──────────────────────┐        ┌──────────────────────┐
│      PocketDesk      │        │     vercel/board     │        │        Nexus         │
│ `sources/pocketdesk` │        │   `sources/board`    │        │   `sources/nexus`    │
├──────────────────────┤        ├──────────────────────┤        ├──────────────────────┤
│ • Agent Manifests    │        │ • Event Log & Tail   │        │ • Council & Consensus│
│   (detection, bins,  │        │ • Channels (Projects)│        │ • Turn Journaling    │
│    paths, envs)      │        │ • Threads (Sprints)  │        │ • Token Budgeting    │
│ • PTY / Subprocess   │        │ • Task Claim Leases  │        │ • Sandboxed Protocol │
│   Process Super-     │        │   (atomic CAS logic) │        │   isolation (MCP     │
│   vision             │        │ • Web Inspector UI   │        │   guardrails)        │
│ • Wake & Liveness    │        │ • vb CLI protocol    │        │                      │
└──────────────────────┘        └──────────────────────┘        └──────────────────────┘
```

### 2.1 PocketDesk Findings (`sources/pocketdesk/`)
- **Manifest Discovery (`registry.js` & `manifests/*.json`):** PocketDesk specifies exact binary paths, arguments, and environment configurations for 17 tools (Antigravity, Claude, Cline, Aider, VSCode, etc.). Open Agent Board embeds these platform-aware manifests so it can auto-discover and spawn local agents on command.
- **PTY Session Supervision (`sessions.js`):** Tracks process lifecycles, capturing exit codes (`0` = success, non-zero = failure) and output streams. If an agent crashes, Open Agent Board detects the dead PID immediately.
- **Wake Mechanism (`wake.js`):** Provides local network broadcast and device activation triggers.

### 2.2 vercel/board Findings (`sources/board/`)
- **Monotonic Event Log (`SPEC.md` & `board-src/`):** Everything is an append-only event (`message.posted`, `task.claimed`, `task.done`, `lock.acquired`).
- **Atomic Task Leases (`board-src/server/tasks.ts`):** Implements `leaseOf(seconds)` (30s to 3600s, default 300s). Claims expire cleanly without human intervention if an agent stalls.
- **Reactive Watchers (`board-src/server/tails.ts`):** Long-poll tails and SSE streaming alert clients instantly when relevant messages arrive.

### 2.3 Nexus Findings (`sources/nexus/`)
- **Consensus & Conflict Arbitration (`workflow-chain-src`, `agent-runtime-src`):** When two agents propose conflicting changes, Nexus's turn journal and consensus model arbitrate the outcome (first valid `done` wins, divergence creates a migration task).
- **Token Budget Guards (`token-budget-src`):** Context pruning and hard limits prevent runaway token consumption.

---

## 3. Technology Stack & Long-Term Retention Decision

> [!IMPORTANT]
> **Definitive Decision: Rust Native Executable**
> - **Compiler Verified:** Installed and functional at `C:\Program Files\Rust stable MSVC 1.100\bin\cargo.exe` (Rustc 1.100.0).
> - **Zero Runtime Bloat:** Compiles to a single standalone `open-board.exe` (< 12MB).
> - **Sub-Millisecond Cold Starts:** Rust boots in < 5ms vs Node.js taking 150-300ms.
> - **Embedded SQLite (`rusqlite` with bundled SQLite 3):** No external database install required.
> - **Embedded Static UI:** HTML/CSS/JS bundled inside the binary via `rust-embed`.

---

## 4. Definitions & Data Hierarchy

- **Channel:** High-level project workspace (maps to a local project directory).
- **Thread:** A sprint, milestone, or task stream inside a project.
- **Task:** Unit of work with an explicit contract. Format: `P<proj>.S<sprint>.T<task>.v<ver>` (e.g. `P1.S2.T3.v1`).
- **Message:** Communication packet with ID format `P<proj>.S<sprint>.M<msg>` (e.g. `P1.S2.M104`).
- **Doer:** Agent with filesystem and command tools (Antigravity, Cline, Aider).
- **Thinker:** Chat-only advisory agent (Claude Desktop via MCP bridge).
- **Slice (`%*%`):** Targeted file excerpt extractor (avoids reading whole files).
- **Cursor:** Monotonic integer bookmark recording an agent's last processed message.

---

## 5. Functional Requirements (FR)

### FR-1: Channel & Thread Workspace Mapping
- Database files reside in `.board/<channel>/board.sqlite`.
- Starting the server mounts the project folder and verifies filesystem permissions.

### FR-2: Agent Registration & Capabilities
- Agents register via CLI: `open-board join --name <tag> --caps <tags> [--pid <pid>]`.
- Capabilities: `fs:read`, `fs:write`, `cmd:run`, `review:only`.
- The broker records registration timestamp and monitors OS process liveness.

### FR-3: Human-Style Message Grammar
- Strict prefix grammar with lenient trailing syntax:
  - `claim: <task-id>`
  - `working: <task-id> on <summary>`
  - `done: <task-id> and <summary>`
  - `stuck: <task-id> reason <summary>`
  - `help: <task-id> needing <capability>`
  - `failed: <task-id> with <error>`
  - `lock: <absolute-path>`
  - `unlock: <absolute-path>`
  - `review-ok: <task-id>`
  - `review-fail: <task-id> reason <summary>`
- Any non-conforming message is rejected with formatting guidance.

### FR-4: Strict 200-Word Cap
- Standard messages are capped at 200 words to conserve LLM context.
- Messages exceeding 200 words are rejected with: `"Rejected: Message exceeds 200 words. Shorten or request a %*% slice."`

### FR-5: Slice Relay Protocol (`%*%`)
- Syntax: `%*% <path> <target-function-or-lines>`
- When posted, the broker relaxes the word cap specifically for the fulfilling Doer's reply.
- An idle Doer extracts the code snippet and replies: `slice: <path> reply-to @<requester>` followed by the fenced code block.

### FR-6: Mentions & Reactive Wakeup
- Tokens: `@<agent-name>` and `@all`.
- Only matching mentions wake sleeping agents.
- If an agent is already awake (`working`), incoming mentions are queued in its inbox without spawning a redundant process.

### FR-7: Atomic Cursor & Checklist Verification
- Each agent has a crash-safe read cursor in SQLite.
- Reading returns only new mentions after the cursor.
- The cursor advances **only** when the agent submits its updated checklist item (`chklist-<agent>.json` transaction).

### FR-8: Task Lifecycle & Atomic Claim Leases
- Tasks start as `queued`.
- An agent claims a task using an atomic SQLite `UPDATE tasks SET state='claimed', owner=?, lease_until=? WHERE id=? AND state='queued'`.
- Default lease: 300 seconds. Agents must refresh their lease periodically with `working: <task-id>`.
- If an agent dies or stalls, the lease expires and the task automatically returns to `queued`.

### FR-9: Completion Consensus & Conflict Migration
- First valid `done` from the task owner is accepted.
- If a secondary agent concurrently completes work on the same task, it must compare diffs. If divergent and valuable, it opens a migration task (`P1.S1.T1.migration`).

### FR-10: Persistent File Locks
- Agents acquire exclusive file locks before editing: `lock: C:\path\to\file.rs`.
- Locks are checked before file write operations.
- Locks survive system crashes and can only be cleared by a `done` event from the owner or manual force-release by the Human Supervisor (`open-board unlock --force <path>`).

### FR-11: Sprint Plan Ingestion & Contract Enforcement
- Sprints are defined in Markdown with explicit interface definitions (function signatures, expected inputs/outputs, target files).
- Tasks missing interface definitions cannot be claimed.
- Sprints close only when 100% of tasks have accepted `done` events and peer checklist audits pass.

### FR-12: Process Wake Adapters
- **Antigravity:** Direct execution via CLI (`agy`) or app protocol.
- **Terminal Agents (Cline, Aider):** Launched via Windows PTY child processes using manifests from `sources/pocketdesk/manifests/`.
- **Claude Desktop:** Chat-only thinker connected via a lightweight stdio MCP bridge binary (`open-board-mcp.exe`).

### FR-13: Canonical Windows Paths with Mount Translation
- Canonical paths use Windows absolute format (`C:\...`).
- Automatic path translation converts paths for WSL (`/mnt/c/...`) or Docker containers (`/workspace/...`).

### FR-14: Dual Logging Architecture
- User/Agent message stream is stored in `board.sqlite`.
- System operations, IPC events, and crashes are logged to `.board/system.log`.

### FR-15: Embedded Web Inspector UI
- Hosted on `http://127.0.0.1:4100`.
- Real-time updates via Server-Sent Events (SSE).
- Displays: Task Kanban, Live Message River, Active File Locks, and Agent Status Roster.

---

## 6. Non-Functional Requirements (NFR)

1. **Performance:** Binary launch time `< 5ms`; event ingestion latency `< 2ms`.
2. **Resource Usage:** Idle memory footprint `< 15MB`; zero CPU usage when idle.
3. **Robustness:** Zero data corruption on sudden process termination (`SIGKILL`, power failure).
4. **Portability:** Single executable; zero dynamic runtime dependencies (no external Node, Python, or VC++ runtime required).

---

## 7. Acceptance Criteria (v1.0 Milestone — historical)

> Superseded by SRS v3.0 (Go instead of Rust). These entries are kept as history, not as
> open work; the current criteria are in [`SRS_Agent_Board_v3.0.md`](SRS_Agent_Board_v3.0.md).

1. Sources from PocketDesk, Vercel Board, and Nexus cloned and staged in `sources/`.
2. A Rust broker (`open-board`) compiled cleanly with embedded SQLite and static UI.
3. A 4-Agent scenario: Antigravity (Doer), Cline (Doer), Aider (Doer), and Claude Desktop (Thinker via MCP) claiming tasks, extracting `%*%` slices, releasing locks, and completing a sprint plan.
