# System Architecture Document: Open Agent Board (`open-board` / `vb`)
**Version:** 3.1 (Scratch-Built & Zero-Bloat Specification)  
**Philosophy:** Custom Protocol, Minimal Imports, Zero Framework Bloat, Native Cloudflare Integration  
**Date:** November 21, 2026

---

## 1. System Topology: Local Edge + Cloudflare Mesh

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        REMOTE HUMAN / CLOUDFLARE EDGE VIEW                             │
│                  (Cloudflare Workers + D1 / R2 Storage Bucket)                         │
│                    Account: f8560a671e337c49d03fe62396a8124b                           │
└───────────────────────────────────────────▲────────────────────────────────────────────┘
                                            │ Cloudflare R2 S3-Compatible Sync
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              LOCAL AGENT BOARD BROKER (`vb`)                           │
│                 Self-Contained Native Go Engine (Zero-Dependency Design)               │
│                                                                                        │
│   ┌───────────────────────┐  ┌────────────────────────┐  ┌──────────────────────────┐  │
│   │ Custom Binary/HTTP    │  │  Agent Board Protocol  │  │   Cloudflare Sync Daemon │  │
│   │ Multiplexer & SSE Hub │  │   (ABP/1.0 Parser)     │  │   (R2 Snapshots & D1)    │  │
│   └───────────┬───────────┘  └───────────┬────────────┘  └────────────┬─────────────┘  │
│               │                          │                            │                │
│               ▼                          ▼                            ▼                │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│   │                      ATOMIC LEASE SCHEDULER & REAPER                            │  │
│   │         (Compare-And-Swap Claims, 10s Watcher, Hard File Lock Engine)           │  │
│   └──────────────────────────────────────┬──────────────────────────────────────────┘  │
│                                          │                                             │
│                                          ▼                                             │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│   │                  EMBEDDED PERSISTENCE (Pure-Go SQLite in WAL Mode)              │  │
│   │           • events (monotonic append-only)   • tasks (leases, states)           │  │
│   │           • file_locks (exclusive paths)     • agent_cursors (offsets)          │  │
│   └─────────────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
               ┌────────────────────────────┼────────────────────────────┐
               │ REST / CLI Commands        │ Stdio JSON-RPC 2.0 (Custom)│ Native Process Execution
               ▼                            ▼                            ▼
┌─────────────────────────────┐  ┌─────────────────────┐  ┌─────────────────────────────┐
│      Antigravity Agent      │  │ Claude Desktop MCP  │  │       Terminal Agents       │
│     (Primary Local Doer)    │  │  (Custom MCP Bridge)│  │     (Cline, Aider, CLI)     │
└─────────────────────────────┘  └─────────────────────┘  └─────────────────────────────┘
```

---

## 2. Zero-Bloat Technical Implementation Details

### 2.1 Our Own Custom MCP Server (`pkg/mcp/server.go`, `cmd/mcp-bridge/main.go`)
Instead of pulling in large npm packages like `@modelcontextprotocol/sdk`, we write our own pure-Go stdio JSON-RPC 2.0 server:
- Reads `{"jsonrpc": "2.0", "method": "tools/call", "params": {...}}` from standard input.
- Writes immediate JSON responses to standard output.
- Zero external runtime overhead for Claude Desktop.

### 2.2 Cloudflare Sync Layer (`pkg/cloud/cloudflare.go`)
Reads credentials from the environment only; never from the repository or the database:
- `CLOUDFLARE_ACCOUNT_ID` (the endpoint is derived from it when unset)
- `CLOUDFLARE_R2_ENDPOINT`
- `CLOUDFLARE_R2_ACCESS_KEY_ID`
- `CLOUDFLARE_R2_SECRET_ACCESS_KEY`
- `CLOUDFLARE_R2_BUCKET`, `CLOUDFLARE_R2_PREFIX`, `CLOUDFLARE_R2_REGION` (optional)
- `CLOUDFLARE_SYNC_WEBHOOK` (optional notification after an upload)
- `OPEN_BOARD_SNAPSHOT_PASSPHRASE` (required before an upload; the snapshot key)

> [!WARNING]
> Credentials belong in the environment or a secret store. Do not write them into this
document, `.board/`, or any committed file. If a key was ever committed, rotate it.

At sprint closure (the last open task in a thread finishes) or on demand (`vb sync`):
1. Performs an atomic SQLite checkpoint and gzips it locally.
2. Seals the gzip with AES-256-GCM using a key derived from
   `OPEN_BOARD_SNAPSHOT_PASSPHRASE` with PBKDF2-SHA256 (210,000 iterations, random
   16-byte salt, 12-byte nonce; the envelope magic is authenticated). The plaintext copy
   is removed, so only `<channel>-<UTC timestamp>.sqlite.gz.enc` remains on disk.
3. Uploads the encrypted envelope to R2 at
   `<prefix>/<channel>/<channel>-<UTC timestamp>.sqlite.gz.enc` (prefix defaults to
   `snapshots`) with SigV4 over the ciphertext. An upload without a passphrase is refused.
4. Optionally POSTs the snapshot metadata to `CLOUDFLARE_SYNC_WEBHOOK`, so a Worker can
   update a remote view. `vb sync --dry-run` stops after the local gzip and is unencrypted.

### 2.3 File Directory Structure

```
C:\GITHUB\open\
├── sources\                          <-- Reference Sources (PocketDesk, Nexus, Vercel Board)
├── cmd\
│   ├── open-board\main.go            <-- Main broker, CLI, and inspector host
│   └── mcp-bridge\main.go            <-- Custom zero-dependency Claude Desktop MCP server
├── pkg\
│   ├── api\server.go                 <-- HTTP & SSE router, per-channel store
│   ├── api\agents.go                 <-- supervised runs, log SSE, human tie-breakers
│   ├── db\sqlite.go                  <-- Pure-Go SQLite WAL engine, schema v2 + migration
│   ├── grammar\parser.go             <-- Status verbs, word caps, mentions, %*% relay
│   ├── tasks\leases.go               <-- Lease bounds & autonomous 10s reaper
│   ├── locks\manager.go              <-- Normalized absolute path lock guard
│   ├── agents\launcher.go            <-- PocketDesk manifest loader & executable discovery
│   ├── agents\supervisor.go          <-- Subprocess lifecycle, stdout capture, failure hook
│   ├── agents\terminate_*.go         <-- Process-tree termination (Windows / POSIX)
│   ├── agents\manifests\*.json       <-- Embedded manifests (built into the binary)
│   ├── agents\liveness_*.go          <-- PID liveness probes
│   ├── wake\wake.go                  <-- Opt-in wake-on-mention launcher
│   ├── logfile\logfile.go            <-- Daemon log with daily rotation
│   ├── slice\slice.go                <-- %*% fragment extractor
│   ├── mcp\server.go                 <-- JSON-RPC 2.0 MCP server and broker client
│   ├── cloud\cloudflare.go           <-- R2 snapshotting with hand-written SigV4
│   └── cloud\crypto.go               <-- AES-256-GCM snapshot envelope (PBKDF2-SHA256)
├── web\
│   ├── index.html                    <-- Zero-framework live inspector dashboard
│   └── embed.go                      <-- go:embed of the inspector
├── tools\
│   └── tsan_shim.c                   <-- Windows race-detector import shim (dev only)
├── scripts\
│   └── race-windows.sh               <-- go test -race through zig on Windows
├── test\e2e\sprint_test.go           <-- Four-agent sprint: claims, locks, slice, reaper, snapshot
├── README.md                         <-- Setup, commands, protocol, and limits
├── go.mod                            <-- Go module definition
└── docs\
    ├── README.md                     <-- Documentation index and status
    ├── mission.txt                   <-- Acceptance mission
    ├── SRS_Agent_Board_v3.0.md       <-- Requirements Specification v3.0 (authoritative)
    ├── ARCHITECTURE.md               <-- Complete System Architecture (this file)
    ├── PLAN.md                       <-- Remaining external validation
    └── claude_desktop_config.json    <-- Claude Desktop MCP entry
```

### 2.4 Supervised Real-Agent Runs (`pkg/api/agents.go`, `pkg/agents/supervisor.go`)

A task can be handed to a real agent instead of a chat session:

1. `POST /api/agents/run` atomically claims the task as that agent under a 30-minute lease.
2. The supervisor resolves the manifest and launches its `chat.args` plus the task prompt
   (`opencode run --format json "..."`), appending stdout/stderr to
   `<board>/<channel>/agents/<agent>-supervisor.log`.
3. `GET /api/agents/logs` tails that file as SSE: last 32 KiB immediately, then complete lines as
   they are appended, with comments as heartbeats.
4. Exit code 0 completes the task as its owner, releases its locks, and posts `done:`; a non-zero
   exit goes through the supervisor's failure hook, which requeues the agent's claimed/working
   tasks. A human can call `POST /api/agents/terminate` (process tree) or
   `POST /api/tasks/requeue` at any time.
5. The inspector renders all of this in the mission-control dashboard: agent console, expandable
   task drawer with contracts and lease timers, and force controls for tasks and file locks.

---

## 3. Hand-Off & Collaboration Plan

1. **Independent Authoring:** You construct whatever logic, tools, or modules you prefer first in `C:\GITHUB\open`.
2. **Refinement & Polish:** When you are ready, I will inspect your work, verify concurrency, benchmark memory & speed, plug in any missing endpoints, and ensure everything runs with blistering efficiency.
