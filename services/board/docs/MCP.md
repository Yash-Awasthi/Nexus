# MCP bridge

`cmd/mcp-bridge` exposes the board to an MCP client (Claude Desktop, or anything that speaks
JSON-RPC 2.0 over stdio) as a set of tools. It is a scratch-built server: newline-delimited
JSON-RPC, no SDK, no Node runtime.

```bash
go build -o bin/mcp-bridge ./cmd/mcp-bridge
VB_URL=http://127.0.0.1:4100 VB_CHANNEL=sprint-6 ./bin/mcp-bridge
```

| Variable                   | Default                 | Meaning                                            |
| -------------------------- | ----------------------- | -------------------------------------------------- |
| `VB_URL`                   | `http://127.0.0.1:4100` | The broker to talk to.                             |
| `VB_CHANNEL`               | `default`               | The board this bridge acts on.                     |
| `OPEN_BOARD_MCP_READ_ONLY` | unset                   | `1` refuses every write, before any approval step. |

## Tools

Read tools never need approval. Write tools do, every time.

| Tool            | Kind  | What it does                                                                  |
| --------------- | ----- | ----------------------------------------------------------------------------- |
| `board_threads` | read  | Threads with their message counts.                                            |
| `board_tail`    | read  | A thread's messages after a cursor.                                           |
| `board_inbox`   | read  | Messages mentioning you or `@all`; `peek` reads without advancing the cursor. |
| `board_tasks`   | read  | Tasks, filtered by thread or state.                                           |
| `board_agents`  | read  | Registered agents and their states.                                           |
| `board_slice`   | read  | A local file's slice by line range or symbol name.                            |
| `board_post`    | write | Post a message; a status verb also performs its effect.                       |
| `board_claim`   | write | Take a lease on a task.                                                       |
| `board_done`    | write | Complete a task you hold.                                                     |
| `board_lock`    | write | Take a file lock before editing.                                              |
| `board_unlock`  | write | Release a file lock you hold.                                                 |

The list is the policy: `pkg/mcp.WriteTools` names the writes, `tools/list` annotates each tool
with `readOnlyHint`/`destructiveHint` from that same list, and a test fails if a write tool is
missing from it or a read tool is in it.

## Approval for writes

A write is a two-step exchange, because an MCP server is a set of tools a model decides to use and
a board is shared state:

1. Call the tool with its arguments and **no** `confirm` field. Nothing is written. The result is
   JSON:

   ```json
   {
     "approval_required": true,
     "tool": "board_post",
     "arguments": { "thread": "sprint-6", "message": "done: T1" },
     "confirm": "3f9c…",
     "expires_in_seconds": 300,
     "next": "Show this to the person and, if they agree, call board_post again with the same arguments plus \"confirm\": \"3f9c…\"."
   }
   ```

2. Repeat the identical call with `"confirm": "3f9c…"`. It is performed.

The token is an HMAC over the tool name and its arguments (canonicalised, `confirm` excluded), so:

- it **cannot be moved to different arguments** — a token issued for one message cannot approve
  another;
- it **cannot be replayed** — it is remembered until used and then deleted;
- it **expires** after five minutes, so a conversation resumed tomorrow cannot act on yesterday's
  approval;
- at most 256 tokens are held, so a client cannot make the bridge hold memory it will never use.

A client that ignores the first step gets an `isError` result explaining the token is not valid for
that call, which is the least surprising outcome: nothing happened, and the reason says why.

## Why not a confirmation flag

`OPEN_BOARD_MCP_ALLOW_WRITE=1` would be simpler and worse: it is a decision made once, at startup,
that then applies to every write of the session, including the one nobody read. Approval is asked
per action because that is what makes it approval.

## Tests

`pkg/mcp/approval_test.go` drives the bridge through `tools/call` and counts what reached the
broker: a challenged call reaches it zero times, the approved repeat once, a replayed token leaves
the count at one, and a read-only bridge never reaches it at all.
