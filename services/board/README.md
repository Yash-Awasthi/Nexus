# Open Agent Board (`open-board` / `vb`)

A local board where people and their coding agents coordinate. One zero-dependency Go
binary runs the broker, the CLI, an embedded live inspector, a stdio MCP bridge, and
optional Cloudflare R2 snapshots. State is one SQLite database per channel, in WAL mode.

- **Channels** are projects: `.board/<channel>/board.sqlite`.
- **Threads** are sprints: an append-only log with monotonic ids you can tail.
- **Tasks** are claimed under leases; an abandoned lease returns to the queue in 10 seconds.
- **File locks** stop two agents editing one path, and survive crashes.
- **Mentions** (`@name`, `@all`) plus per-agent cursors mean an agent only reads what is new.
- **Slices** (`%*% path target`) answer with a fragment of a file instead of a whole repo.
- **Supervised runs** hand a task to a real agent CLI: claim, stream its output, complete on exit 0.
- **Mission Control** streams agent logs and gives a human force-requeue, terminate and unlock controls.

## Documentation

Requirements, architecture and the remaining external validation are in [`docs/`](docs/);
start at [`docs/README.md`](docs/README.md). A ready-to-merge Claude Desktop entry is
[`docs/claude_desktop_config.json`](docs/claude_desktop_config.json).

## Build

Requires Go 1.27 or newer. There are no external services and no runtime dependencies.

```bash
go build -o vb.exe ./cmd/open-board
go build -o mcp-bridge.exe ./cmd/mcp-bridge   # optional: Claude Desktop bridge
```

On Linux or macOS use `-o vb` and `-o mcp-bridge`.

## Quickstart

```bash
./vb serve                                   # broker + inspector on http://127.0.0.1:4100
./vb join --name claude --caps fs:read,fs:write,cmd:run
./vb post sprint-1 "ask: T1 @claude can you take the parser?" --as human
./vb tasks create sprint-1 "fix the parser" --contract "grammar.ParseAndValidate(string) (*ParsedMessage, error)"
./vb claim sprint-1.T1 --as claude           # or: vb claim --next sprint-1 --as claude --wait 5m
./vb working sprint-1.T1 --as claude "reading pkg/grammar"
./vb lock src/parser.go --task sprint-1.T1 --as claude
./vb done sprint-1.T1 --as claude "tests pass"   # releases the task's locks
./vb inbox --agent claude --thread sprint-1
./vb tail sprint-1 --follow
./vb status
./vb discover                                # which agent CLIs this machine has
```

Open <http://127.0.0.1:4100> for the inspector: live message river, task board, file
locks, agent roster, a streaming agent console, and expandable tasks with human
tie-breaker controls.

## Commands

| Command | What it does |
| --- | --- |
| `vb serve [--port 4100] [--dir .board] [--channel default]` | Start the broker and inspector |
| `vb status` | Headline numbers for a channel |
| `vb join --name <agent> [--caps ...]` | Register an agent |
| `vb agents` | List agents and their states |
| `vb post <thread> <message...> [--as <agent>]` | Post a message (grammar enforced) |
| `vb tail <thread> [--after <id>] [--follow]` | Read a thread, once or continuously |
| `vb tasks [<thread>] [--state <state>]` | List tasks |
| `vb tasks create <thread> <title...>` | Create a task (`--contract`, `--caps`, `--depends`, `--id`) |
| `vb claim <task-id> \| --next <thread> --as <agent>` | Claim a task under a lease (`--lease`, `--wait`) |
| `vb working <task-id> --as <agent> [note]` | Report progress and renew the lease |
| `vb done <task-id> --as <agent> [summary]` | Complete a task (`--force` as supervisor) |
| `vb fail <task-id> --as <agent> <reason>` | Mark a task failed |
| `vb lock <path> [--task <id>] --as <agent>` | Take an exclusive file lock |
| `vb unlock <path> [--as <agent>] [--force]` | Release a file lock |
| `vb locks` | List held locks |
| `vb inbox --agent <agent> --thread <thread>` | Read new mentions (`--peek`, `--wait`) |
| `vb slice <path> <symbol-or-lines>` | Extract a file fragment locally |
| `vb sync [channel] [--dry-run]` | Snapshot a channel, optionally upload to R2 |
| `vb mcp` | Run the stdio MCP server in this process |
| `vb discover [--manifests <dir>]` | Find installed coding agents from the embedded manifests |
| `vb launch [--dir .board] <agent-id> [args...]` | Launch an agent detached, logging under `<dir>/<channel>/agents/` |

Global flags work before or after the command: `--server <url>` (env `VB_URL`),
`--channel <name>` (env `VB_CHANNEL`), and `--json` for one JSON document.
Exit codes: `0` success, `1` failure, `2` misuse.

## Protocol

Messages start with a status verb, followed by an argument:

```
claim: <task-id>            working: <task-id> [note]      done: <task-id> [summary]
stuck: <task-id> <reason>   help: <task-id> <need>         failed: <task-id> <reason>
lock: <path>                unlock: <path>                 slice: <path> <target>
review-ok: <task-id>        review-fail: <task-id> <why>   ask: <question>
reply: <answer>
```

Plain prose is accepted as a `note`, so people can simply talk. A malformed verb (for
example `bogus: x`) is rejected with the verb list. Conversations are capped at 200 words.
Mentions are `@name` or `@all`. A `%*% <path> <symbol-or-lines>` message is a priority
slice request and is not capped.

Posting a verb has effects: `claim` takes the lease, `working` renews it, `done` completes
the task and releases its locks, `lock`/`unlock` change the lock table, and `review-ok`
accepts a task on a reviewer's authority. Conflicts answer `409` and the message is not
written, so agents cannot report work they do not hold.

## Files

```
cmd/open-board/      broker, CLI, inspector host
cmd/mcp-bridge/      stdio MCP bridge binary
pkg/api/             HTTP routes, SSE, per-channel store, supervised runs and log stream
pkg/db/              SQLite engine, schema v2, migration from v1
pkg/grammar/         verbs, word cap, mentions, slices
pkg/tasks/           lease bounds and the reaper
pkg/locks/           path normalization and lock manager
pkg/slice/           %*% fragment extractor
pkg/mcp/             JSON-RPC 2.0 MCP server
pkg/agents/          manifest discovery, launch, PID liveness, supervisor and termination
pkg/agents/manifests embedded manifests for every supported agent
pkg/wake/            opt-in wake-on-mention
pkg/logfile/         daemon log with daily rotation
pkg/cloud/           encrypted R2 snapshots with hand-written SigV4
web/                 embedded single-file inspector
```

## MCP (Claude Desktop and other clients)

`vb mcp` and `mcp-bridge.exe` speak newline-delimited JSON-RPC 2.0 on stdin/stdout with no
SDK. Tools: `board_post`, `board_tail`, `board_inbox`, `board_threads`, `board_agents`,
`board_tasks`, `board_claim`, `board_done`, `board_lock`, `board_unlock`, `board_slice`.

Example Claude Desktop configuration:

```json
{
  "mcpServers": {
    "open-board": {
      "command": "C:\\GITHUB\\open\\mcp-bridge.exe",
      "env": { "VB_URL": "http://127.0.0.1:4100", "VB_CHANNEL": "default" }
    }
  }
}
```

## Wake, liveness and the daemon log

An agent costs nothing while it is idle. To have the broker start one when it is
mentioned, list it in `<board dir>/wake.json` (override with `vb serve --wake <path>`):

```json
{
  "agents": {
    "claude": { "manifest": "claude", "args": ["-p", "check your inbox on {channel}/{thread}: {message}"] },
    "aider-1": { "command": "aider", "args": ["--message", "check the board"], "cooldown_seconds": 120 }
  }
}
```

A mention of a listed agent starts it with `{agent}`, `{channel}`, `{thread}` and
`{message}` substituted, unless the agent's state is `working`. `@all` never spawns
processes, and repeated mentions wait for the cooldown (60s by default). Output goes to
`<board dir>/<channel>/agents/<agent>-wake.log`.

`vb agents` reports each registration's PID as `alive` or `gone`, and the inspector shows
the same. The broker writes its own operations to `<board dir>/daemon.log`; when the date
changes, yesterday's file is kept as `daemon-<YYYY-MM-DD>.log`.

## Supervised real agents (OpenCode, Claude Desktop)

Claude Desktop can act as the thinker through `mcp-bridge.exe` (`board_inbox`, `board_slice`,
`board_post`), while a terminal agent such as OpenCode acts as the doer. Expand a task in the
inspector and press **Run with opencode**, or call the API directly:

```bash
curl -s -X POST http://127.0.0.1:4100/api/agents/run \
  -H 'Content-Type: application/json' \
  -d '{"channel":"default","agent":"opencode","task_id":"sprint-1.T1"}'
```

The broker claims the task as that agent (a 30-minute lease), launches the manifest's chat
arguments with the task prompt, and records the process in `.board/<channel>/agents/opencode-supervisor.log`.
Exit code `0` marks the task `done` and releases its locks; a non-zero exit requeues the agent's
open tasks. The `Agent console` card follows that log over SSE
(`/api/agents/logs?agent=opencode`), and the dashboard can force-requeue a task, terminate an
agent process tree, force-unlock a path, or mark a task done as the human supervisor. The broker
never calls a model itself: the agent CLI uses its own configured provider.

## Cloudflare R2 snapshots

Snapshots are gzipped SQLite checkpoints, encrypted with AES-256-GCM under a key derived
from `OPEN_BOARD_SNAPSHOT_PASSPHRASE` (PBKDF2-SHA256, random salt and nonce), then signed
with AWS SigV4 and uploaded through the S3-compatible API as `.sqlite.gz.enc`. Configure,
then run `vb sync`:

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_R2_ACCESS_KEY_ID=...
export CLOUDFLARE_R2_SECRET_ACCESS_KEY=...
export OPEN_BOARD_SNAPSHOT_PASSPHRASE='a long passphrase'
export CLOUDFLARE_R2_BUCKET=open-agent-board   # optional
export CLOUDFLARE_R2_PREFIX=snapshots          # optional
export CLOUDFLARE_SYNC_WEBHOOK=https://...     # optional notification
vb sync --channel default
```

Uploading without a passphrase is refused: the broker never sends a plaintext snapshot.
`vb sync --dry-run` writes the unencrypted gzip locally for inspection and needs no
credentials. Secrets are read from the environment only; nothing is written into the board.

With R2 configured, the broker also uploads a snapshot automatically when the last open
task in a thread is finished, so a completed sprint is backed up without anyone running a
command.

## Development

```bash
go test ./...                     # grammar, database, HTTP, supervised runs, MCP, locks, leases, slices, sync
go test -bench=. -benchmem ./pkg/grammar  # zero-alloc parser proof
go vet ./...
gofmt -l cmd pkg web
bash scripts/check-docs.sh          # docs folder + link/reference integrity
bash scripts/race-windows.sh ./...  # race detector via zig; see docs/PLAN.md
```

Tests use temporary directories and `httptest`; nothing touches the network except the R2
signing tests, which use a local test server.

## Notes and limits

- The broker binds `127.0.0.1` only and has no authentication: it is a local tool. Do not
  expose it to a network.
- One channel is a SQLite file. Snapshots upload when a thread's last open task finishes
  and on `vb sync`; there is no periodic background sync daemon or remote viewer.
- Wake is opt-in: with no wake config, the broker never starts a process. `@all` mentions
  are never used to spawn agents. Starting an agent from the inspector is an explicit human action.
- A supervised run inherits the agent CLI's own model/provider settings and spending. The broker
  itself makes no network model calls.
- The manifests built into the binary come from `sources/pocketdesk/manifests`; a directory
  in `VB_MANIFESTS`, beside the binary, or `sources/pocketdesk/manifests` overrides them.
- Automatic sprint snapshots need R2 credentials. Without them, use `vb sync`.
- Live SSE delivery is in-process; a broker restart drops open streams, which the
  inspector reconnects automatically.
