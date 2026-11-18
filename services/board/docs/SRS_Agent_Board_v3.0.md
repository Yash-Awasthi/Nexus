# Software Requirements Specification (SRS v3.0)
## Project: Open Agent Board (`open-board` / `vb`)
**Architecture Paradigm:** Zero-Bloat, Scratch-Built Native Architecture & Custom Multi-Agent Protocol  
**Cloud & Sync Tier:** Cloudflare Workers + Durable Objects / D1 + Cloudflare R2 Sync  
**Local Tier:** Single Zero-Dependency Binary (Go 1.27 + Embedded WAL SQLite)  
**Date:** November 21, 2026  
**Status:** Approved Blueprint for Independent Construction

---

## 1. Executive Vision: "Build From Scratch, Beyond Conventions"

Most multi-agent frameworks suffer from massive dependency bloat (hundreds of npm packages, gigabytes of Python wheels, complex docker compose networks, sluggish cold-starts). 

**Open Agent Board completely departs from this convention:**
1. **Zero External Library Bloat:** Minimal imports. Every critical engine mechanism—the **custom binary/JSON message protocol**, the **task lease arbiter**, the **scratch-built MCP stdio server**, and the **lock table**—is authored in clean, raw Go code with zero third-party framework overhead.
2. **Custom Multi-Agent Wire Protocol (`ABP - Agent Board Protocol`):** Replaces heavy HTTP/REST roundtrips with an ultra-lightweight, pipelined local broker protocol (`abp://` / raw unix/named pipes / low-overhead HTTP keep-alive) and SSE.
3. **First-Party Cloudflare Edge Mesh:** Local execution is paired with your personal Cloudflare infrastructure (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_R2_*`):
   - **Local Cache & Execution:** Microsecond local SQLite (WAL mode).
   - **Cloud Sync & Remote View:** Direct sync to Cloudflare D1 / Durable Objects and Cloudflare R2 for immutable artifact backups and remote dashboard access.
4. **Our Own Scratch-Built MCP Engine (`open-board-mcp`):** A custom JSON-RPC 2.0 stdio server without SDK dependencies, giving Claude Desktop direct access to `inbox`, `post`, and `%*%` code slicing in under 5ms.

---

## 2. Ingested Intelligence from Reference Audits (`sources/`)

1. **`sources/pocketdesk` (Process & Discovery Engine):**
   - Reused concept: Pure JSON manifests (`antigravity.json`, `claude.json`, `cline.json`, `aider.json`) for zero-configuration local agent discovery.
   - Replaced implementation: Replaced Node child-process spawning with native Go OS process control (`os/exec`, Windows Job Objects) to guarantee zero orphaned zombie processes.
2. **`sources/board` (Monotonic Event Log & Lease Mathematics):**
   - Reused concept: Channels (Projects), Threads (Sprints), atomic compare-and-swap leases (`tasks.ts`), and 25-second long-poll tails (`tails.ts`).
   - Replaced implementation: Replaced Vercel API and Node server with a custom Go event multiplexer and Cloudflare R2 / D1 edge sync.
3. **`sources/nexus` (Turn Journaling & Conflict Arbitration):**
   - Reused concept: First-wins consensus with automatic migration task generation (`workflow-chain`).
   - Replaced implementation: Inlined directly into the SQLite atomic transaction handler.

---

## 3. Technology Stack & Memory-Speed Benchmarks

| Layer | Traditional Frameworks | **Open Agent Board (From Scratch)** | Gain |
| :--- | :--- | :--- | :--- |
| **Language & Engine** | Python / Node.js + LangChain | **Go 1.27 Native Single Binary** | **30x faster startup (<5ms), 95% less RAM (<15MB)** |
| **Broker Protocol** | REST JSON + Heavy Middleware | **Custom ABP (Agent Board Protocol)** | **Zero allocation, sub-millisecond parsing** |
| **Storage Engine** | PostgreSQL / Redis / Docker | **Pure-Go Embedded SQLite (WAL)** | **Zero daemon setup, crash-proof ACID** |
| **Remote Sync & Backup**| AWS S3 + Complex IAM | **Cloudflare R2 + Workers / D1** | **Native global edge sync via your Cloudflare env** |
| **MCP Integration** | `@modelcontextprotocol/sdk` (150MB) | **Custom Stdio JSON-RPC Bridge (120 lines)** | **Instant launch, zero npm dependencies** |
| **Live Web Inspector** | React / Next.js / Tailwind build | **Single Embedded HTML/SSE (<100KB)** | **No build step, runs anywhere** |

---

## 4. Custom Multi-Agent Protocol Specification (`ABP/1.0`)

### 4.1 Message Framing & Grammar
All communications adhere to the human-and-agent status verb grammar:
```
<VERB>: <TASK-OR-REF> [ARGUMENT]
```
- **Supported Verbs:** `claim:`, `working:`, `done:`, `stuck:`, `help:`, `failed:`, `lock:`, `unlock:`, `review-ok:`, `review-fail:`, `slice:`, `ask:`, `reply:`.
- **Enforced Word Cap:** 200 words strictly enforced for all conversational events.
- **Slice Relay Escape (`%*%`):** Any line beginning with `%*% <filepath> <symbol-or-lines>` is routed as a priority code request, temporarily uncapping the single response from a Doer.

### 4.2 Mentions & Zero-Token Idle State
- Tokens: `@<agent-name>` and `@all`.
- Agents stay in an idle/sleeping state consuming **0 tokens** until a targeted mention arrives.
- The broker writes to the agent's cursor-indexed inbox and triggers process wakeup only when an agent is not already active.

---

## 5. Functional Requirements (FR)

### FR-1: Channel & Thread Local Isolation
- Every channel maps to a folder: `.board/<channel>/board.sqlite`.
- Crash resilience guaranteed via SQLite Write-Ahead Logging (`WAL`) and `PRAGMA synchronous = NORMAL`.

### FR-2: Custom Agent Manifest Discovery
- Built-in embedded parser for PocketDesk manifests (`sources/pocketdesk/manifests/*.json`).
- Automatically resolves local executable paths for Antigravity, Claude, Cline, Aider, and shell harnesses on Windows.

### FR-3: Atomic Claim Leases & Autonomous Reaper
- Task claims utilize atomic SQLite Compare-And-Swap:
  ```sql
  UPDATE tasks SET state='claimed', owner=?, lease_until=datetime('now', '+300 seconds')
  WHERE id=? AND (state='queued' OR lease_until < datetime('now'));
  ```
- Background goroutine reclaims orphaned tasks every 10 seconds if an agent disconnects or crashes.

### FR-4: Hard File Concurrency Locks
- Exclusive path locks prevent race conditions: `lock: C:\project\src\db.go`.
- Locks persist across reboots in `file_locks` table.
- Only the lock owner (via `done` or `unlock`) or the Human Supervisor (via `vb unlock --force`) can release.

### FR-5: Custom Zero-Dependency MCP Server (`mcp-bridge`)
- Self-contained binary `mcp-bridge.exe` communicating with Claude Desktop over stdin/stdout.
- Implements tools: `inbox`, `post`, `claim`, `slice_request` without requiring Node or external packages.

### FR-6: Cloudflare Edge & R2 Replication
- Built-in snapshot sync to Cloudflare R2 using the provided credentials (`CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_ENDPOINT`):
  - Every sprint completion triggers an encrypted immutable snapshot to bucket `agent-board-backups`.
  - Enables viewing sprint progress remotely through a Cloudflare Worker without exposing local ports.

### FR-7: Embedded Single-File Web Inspector
- Served directly at `http://127.0.0.1:4100`.
- Native SSE event river, live Kanban columns, active lock indicators, and agent roster.

---

## 6. Acceptance Criteria for Manual & Refinement Stages

1. [x] Sources cataloged and staged in `C:\GITHUB\open\sources\`.
2. [x] Cloudflare credentials identified and mapped in architecture.
3. [x] You write and construct the core modules/logic in `C:\GITHUB\open`.
4. [x] Antigravity reviews, optimizes, verifies concurrency, and refines the implementation for maximum speed and memory efficiency.

All four criteria are met in this repository (build, tests and the race suite in `docs/PLAN.md`).
The only validation left is external; it is tracked in [`PLAN.md`](PLAN.md).
