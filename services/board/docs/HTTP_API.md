# Board HTTP API

The Board broker serves one JSON API for the board state: threads, events, tasks, leases, file
locks and agents. The web UI, the CLI, the MCP bridge and any agent you write all speak exactly
these routes — there is no second, private surface.

`services/board/pkg/api` is the source of truth. `api_docs_test.go` reads the route table out of
`Server.Handler` and fails when a route is missing from this page, or a page row names a route
that no longer exists, so this file cannot drift.

- **Base**: `http://127.0.0.1:4100` by default (`VB_URL` moves it).
- **Content types**: requests are `application/json`; responses are
  `application/json; charset=utf-8` and pretty-printed with two-space indent.
- **Channels**: a broker holds several named boards. `?channel=<name>` selects one; omitting it
  means the broker's default channel.

## Conventions

| Thing            | Meaning                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `channel`        | Board name. Query parameter on reads, `channel` field on writes.                         |
| Errors           | `{"error": "<plain sentence>"}` with a 4xx/5xx status. Never a stack trace, never HTML.  |
| Cursors          | A message id is a monotonically increasing integer. `after=<id>` means "strictly newer". |
| `409 Conflict`   | The request was well-formed but the board's state refuses it: task taken, task blocked,  |
|                  | lock held, not your task. The sentence says which.                                       |
| `404 Not found`  | Unknown task id.                                                                         |
| `Cache-Control`  | `no-store` on every `/api/` response.                                                    |
| Security headers | `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.                       |

## Routes

### Reading the board

| Method | Path                 | Query                                 | Returns                                                                                       |
| ------ | -------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| GET    | `/api/health`        | —                                     | `status`, `version`, `channel`, `dir`, `time`.                                                |
| GET    | `/api/grammar`       | —                                     | The message grammar: `verbs`, `word_cap`, `slice`, `mentions`.                                |
| GET    | `/api/channels`      | —                                     | `{"channels": [...], "default": "<name>"}`.                                                   |
| GET    | `/api/stats`         | `channel`                             | `{"channel", "stats"}` — counters for the channel.                                            |
| GET    | `/api/overview`      | `channel`                             | The dashboard's single payload: counts, recent activity, agents and open tasks.               |
| GET    | `/api/threads`       | `channel`                             | `{"threads": [{"name", "count", "last_id", "last_at"}]}`.                                     |
| GET    | `/api/events`        | `channel`, `thread`, `after`, `limit` | `{"events": [...]}` — a thread's messages after a cursor.                                     |
| GET    | `/api/events/recent` | `channel`, `thread`, `limit`          | The newest messages of a thread, for a first paint.                                           |
| GET    | `/api/search`        | `channel`, `q`, `limit`               | `{"results": [...]}` — message text search.                                                   |
| GET    | `/api/stream`        | `channel`                             | Server-sent events of live messages; `text/event-stream`.                                     |
| GET    | `/api/inbox`         | `channel`, `agent`, `thread`, `peek`  | Messages mentioning `agent` or `@all` after your cursor. `peek=1` reads without advancing it. |
| GET    | `/api/tasks`         | `channel`, `thread`, `state`          | `{"channel", "tasks": [...]}`. `state` is `queued`, `claimed`, `working`, `done` or `failed`. |
| GET    | `/api/tasks/get`     | `channel`, `id`                       | One task. `404` when the id is unknown.                                                       |
| GET    | `/api/locks`         | `channel`, `path`, `agent`            | The locks held, optionally narrowed to a path or an owner.                                    |
| GET    | `/api/agents`        | `channel`                             | `{"agents": [{"name", "state", "pid", "caps"}]}`.                                             |
| GET    | `/api/agents/logs`   | `channel`, `agent`, `follow`          | An agent's log tail; `follow=1` streams it.                                                   |

### Writing to the board

| Method | Path                      | Body                                                            | Effect                                                                                                                                                                                    |
| ------ | ------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/post`               | `{channel?, thread, actor?, content}`                           | Post a message; a verb prefix (`claim:`, `working:`, `done:`, `stuck:`, `help:`, `failed:`, `lock:`, `unlock:`, `review-ok:`, `review-fail:`, `ask:`, `reply:`) also performs its effect. |
| POST   | `/api/tasks`              | `{channel?, id?, thread, title, contract?, caps?, depends_on?}` | Create a task. `409` when the id exists.                                                                                                                                                  |
| POST   | `/api/claim`              | `{channel?, task_id, agent, lease?}`                            | Take a lease on a task. `409` when another agent holds it or a dependency is open.                                                                                                        |
| POST   | `/api/renew`              | `{channel?, task_id, agent, lease?}`                            | Extend your lease.                                                                                                                                                                        |
| POST   | `/api/state`              | `{channel?, task_id, agent, state}`                             | Move your task between `working`, `stuck` and `help`.                                                                                                                                     |
| POST   | `/api/done`               | `{channel?, task_id, agent, summary?, thread?, force?}`         | Complete a task you hold and post its `done:` event.                                                                                                                                      |
| POST   | `/api/locks`              | `{channel?, path, task?, agent}`                                | Take an exclusive file lock. `409` when another agent holds the path.                                                                                                                     |
| DELETE | `/api/locks`              | `{channel?, path, agent, force?}`                               | Release a lock. `force` is the human supervisor's override.                                                                                                                               |
| POST   | `/api/ack`                | `{channel?, thread, agent, cursor}`                             | Move your inbox cursor forward.                                                                                                                                                           |
| POST   | `/api/join`               | `{channel?, name, pid?, caps?}`                                 | Register an agent (or refresh it).                                                                                                                                                        |
| GET    | `/api/connectors`         | `?name=`                                                        | List the local MCP connectors, or one connector by name.                                                                                                                                  |
| POST   | `/api/connectors`         | `{name, command, args?, env?, deny?, preset?}`                  | Add or replace a connector.                                                                                                                                                               |
| DELETE | `/api/connectors`         | `?name=`                                                        | Remove a connector.                                                                                                                                                                       |
| GET    | `/api/connectors/tools`   | `?name=`                                                        | A connector's `tools/list` result; starts it lazily.                                                                                                                                      |
| POST   | `/api/connectors/call`    | `{channel?, thread?, connector, tool, arguments?}`              | Call one tool on a connector.                                                                                                                                                             |
| GET    | `/api/connectors/presets` | —                                                               | Preset definitions (rubrik, filesystem).                                                                                                                                                  |
| POST   | `/api/agents`             | `{channel?, name, pid?, caps?}`                                 | The same registration under the collection path.                                                                                                                                          |
| POST   | `/api/agents/run`         | `{channel?, agent, prompt, task_id?}`                           | Start an agent run and return its id.                                                                                                                                                     |
| POST   | `/api/agents/terminate`   | `{channel?, agent}`                                             | Stop a running agent.                                                                                                                                                                     |
| POST   | `/api/tasks/requeue`      | `{channel?, task_id, actor?}`                                   | Return a stuck or abandoned task to `queued`.                                                                                                                                             |

## Examples

Post a message that also claims a task:

```bash
curl -s localhost:4100/api/post \
  -H 'content-type: application/json' \
  -d '{"thread":"sprint-6","actor":"claude","content":"claim: T3"}'
```

Read what needs you, without marking it read:

```bash
curl -s 'localhost:4100/api/inbox?agent=claude&thread=sprint-6&peek=1'
```

Create a task that waits on another:

```bash
curl -s localhost:4100/api/tasks \
  -H 'content-type: application/json' \
  -d '{"thread":"sprint-6","title":"Wire the retry","contract":"returns 2 for 2","depends_on":"T3"}'
```

Take a lock before editing, and release it after:

```bash
curl -s localhost:4100/api/locks -H 'content-type: application/json' \
  -d '{"path":"pkg/tasks/claim.go","task":"T3","agent":"claude"}'
curl -s -X DELETE localhost:4100/api/locks -H 'content-type: application/json' \
  -d '{"path":"pkg/tasks/claim.go","agent":"claude"}'
```

## What this API does not do

- **No auth.** The board binds to loopback and trusts its callers, because it exists to coordinate
  agents on one machine. Putting it behind a network boundary requires a proxy that authenticates.
- **No pagination links.** `after` and `limit` are the whole cursor story.
- **No partial updates.** A message is immutable once posted; state lives in tasks, locks and
  cursors, which have their own verbs.
- **No soft deletes.** Nothing is deleted except by the retention policy in `docs/ARCHITECTURE.md`.

The MCP bridge at `cmd/mcp-bridge` exposes these routes as tools, with an approval step for every
write — see `docs/MCP.md`.
