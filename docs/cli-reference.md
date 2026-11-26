<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- verified: c6e5d6c 2026-11-24 -->

# Nexus CLI Reference

**Package:** `@nexus/cli`  
**Binary:** `nexus`  
**Config:** `NEXUS_API_URL` (default `http://localhost:3000`), `NEXUS_API_KEY`

---

## Installation

```bash
# From repo (dev)
node apps/cli/src/index.ts

# Global (once published)
npm install -g @nexus/cli
nexus --version
```

---

## Global options

| Option      | Description               |
| ----------- | ------------------------- |
| `--version` | Print CLI version         |
| `--help`    | Show help for any command |

---

## `nexus doctor`

Check the local toolchain before the first run. One line per prerequisite, each
with the fix; `--json` prints the rows for a script. Exits 1 when a required
check fails. Embedded PGlite and the in-process queue count as ready when
`DATABASE_URL`/`REDIS_URL` are unset.

```bash
nexus doctor
# ✓ node           v26.8.1
# ✓ pnpm           12.21.0
# ✓ postgres       embedded PGlite (DATABASE_URL unset)
# ✗ docker         not found  fix: install Docker Desktop; sandboxed code execution needs it
```

`--bundle [dir]` writes a redacted diagnostic bundle for a bug report instead of printing the
table: `nexus-bundle.json` (doctor rows plus the API's `/status` and `/health`, when reachable)
and a README naming what redaction removed. It creates the directory. Credentials are removed on
the way in — provider-key shapes, JWTs, AWS keys, webhook signatures, passwords in a `DATABASE_URL`
and secrets in a query string — but read it before attaching it.

```bash
nexus doctor --bundle ./report
# ✓ wrote ./report/nexus-bundle.json
#   redacted: credentials in a URL
```

---

## `nexus health`

Check API health.

```bash
nexus health
# ✓ API is ok
```

---

## `nexus tasks`

### `nexus tasks list [options]`

List runtime tasks.

| Option       | Type   | Default | Description                                                                          |
| ------------ | ------ | ------- | ------------------------------------------------------------------------------------ |
| `--status`   | string | —       | Filter: `queued`, `running`, `completed`, `failed`, `cancelled`, `awaiting_approval` |
| `--priority` | string | —       | Filter: `low`, `medium`, `high`                                                      |
| `--limit`    | number | 20      | Max results                                                                          |
| `--offset`   | number | 0       | Pagination offset                                                                    |

```bash
nexus tasks list --status queued
nexus tasks list --status failed --limit 50
```

### `nexus tasks submit`

Submit a new task for execution.

| Option       | Required | Description                                 |
| ------------ | -------- | ------------------------------------------- |
| `--type`     | ✅       | Task type, e.g. `github.create-issue`       |
| `--payload`  | ✅       | JSON string payload                         |
| `--priority` | —        | `low`, `medium`, `high` (default: `medium`) |

```bash
nexus tasks submit \
  --type "github.create-issue" \
  --payload '{"owner":"acme","repo":"myapp","title":"Bug: login fails"}' \
  --priority high
```

### `nexus tasks get <taskId>`

Fetch a single task by UUID.

```bash
nexus tasks get 550e8400-e29b-41d4-a716-446655440000
```

### `nexus tasks cancel <taskId>`

Cancel a queued task. Only works on tasks in `queued` state.

```bash
nexus tasks cancel 550e8400-e29b-41d4-a716-446655440000
```

---

## `nexus approvals`

### `nexus approvals list [options]`

List governance approval requests.

| Option     | Default   | Description                                  |
| ---------- | --------- | -------------------------------------------- |
| `--status` | `pending` | `pending`, `approved`, `rejected`, `expired` |
| `--limit`  | 20        | Max results                                  |

```bash
nexus approvals list
nexus approvals list --status approved --limit 100
```

### `nexus approvals approve <approvalId>`

Approve a pending request.

| Option     | Required | Description                   |
| ---------- | -------- | ----------------------------- |
| `--by`     | ✅       | Your identity (name or email) |
| `--reason` | —        | Optional justification        |

```bash
nexus approvals approve 550e8400-e29b-41d4-a716-446655440001 \
  --by "alice@acme.com" \
  --reason "Reviewed and confirmed safe to execute"
```

### `nexus approvals reject <approvalId>`

Reject a pending request.

```bash
nexus approvals reject 550e8400-e29b-41d4-a716-446655440001 \
  --by "alice@acme.com" \
  --reason "Outside approved scope"
```

---

## `nexus council`

### `nexus council deliberate`

Run a council deliberation (calls all 14 archetypes via Groq).

| Option        | Required | Description                                     |
| ------------- | -------- | ----------------------------------------------- |
| `--title`     | ✅       | Proposal title                                  |
| `--desc`      | —        | Proposal description                            |
| `--budget`    | —        | LLM cost cap in USD (default: `0.10`)           |
| `--signal-id` | —        | Link to existing signal UUID                    |
| `--json`      | —        | Print the raw verdict as JSON, for CI/scripting |
| `--out`       | —        | Write that JSON to a file (kept on failure too) |

```bash
nexus council deliberate \
  --title "Should we deploy the new pricing algorithm?" \
  --desc "New algorithm optimises for LTV, potential 12% revenue uplift" \
  --budget 0.15

# ● Outcome: APPROVED
#   Consensus: 78%
#   Summary: Council approved. 7 YES / 2 NO / 0 ABSTAIN. Majority: YES.
```

For a pipeline, `--json` prints the verdict and exits **1** on a rejection or a failed
deliberation, so a shell step can gate on it:

```bash
nexus council deliberate --title "Ship it?" --json --out verdict.json || exit 1
```

### `nexus council verdict <verdictId>`

Fetch a council verdict by UUID.

```bash
nexus council verdict 550e8400-e29b-41d4-a716-446655440002
```

---

## `nexus ingest`

### `nexus ingest event`

Submit a raw event for ingestion.

| Option       | Required | Description                                     |
| ------------ | -------- | ----------------------------------------------- |
| `--source`   | ✅       | Adapter source, e.g. `github`, `gmail`, `slack` |
| `--type`     | ✅       | Event type, e.g. `pr.opened`, `email.received`  |
| `--payload`  | ✅       | JSON string                                     |
| `--priority` | —        | Queue tier: `high`, `medium`, `low`             |
| `--key`      | —        | Idempotency key (prevents duplicate processing) |

```bash
nexus ingest event \
  --source github \
  --type pr.opened \
  --payload '{"repo":"acme/api","pr":42,"title":"feat: add rate limiting"}' \
  --priority medium
```

---

## `nexus audit`

### `nexus audit log [options]`

View paginated audit log entries.

```bash
nexus audit log --limit 100
```

### `nexus audit verify`

Re-derive the HMAC chain and verify integrity.

```bash
nexus audit verify
# ✓ Chain intact — 1247 entries checked

# If compromised:
# ✗ Chain COMPROMISED
# exits with code 1
```

---

## `nexus security check [--all]`

Run the deployment's security check (admin account required). Lists every setting that leaves a
gap, with what to change; `--all` also lists the checks that pass. Exits with code 1 when any
check fails, so it can gate a deploy.

```bash
nexus security check
# ✗ The audit chain has its own HMAC key
#     Without NEXUS_AUDIT_KEY the chain is signed with a key published in the source, ...
#     fix: Set NEXUS_AUDIT_KEY (openssl rand -hex 32) before the first audit entry; ...
# 15 passed, 1 warnings, 1 failed
```

---

## `nexus org`

Run a company of agents from the terminal. Commands that act on one company take
`-c, --company <id or name>` when you have more than one.

```bash
nexus org companies                 # every company, running agents, month spend
nexus org status -c "Acme"          # agents, tasks and what waits on you
nexus org ask "What shipped this week?" -c Acme
nexus org inbox                     # what waits on you, numbered
nexus org inbox approve 2           # approve, reject, unblock, accept or reassign by number
nexus org approve <approvalId>
nexus org reject <approvalId>
nexus org wake <agent> -t ACME-12   # start a run now, optionally on one task
```

---

## `nexus code <task>`

Launch a coding-agent run through the API and stream it, or run the loop in-process with
`--local` on a key from your environment.

```bash
nexus code "Add a health check to the worker" --repo . --base main
nexus code "Fix the failing test" --local --dir ./my-app --provider groq
```

Shell commands ask for approval once; `--yes` approves them for this run. `--no-wait`
returns after launch.

---

## `nexus gateway`

```bash
nexus gateway models                         # model aliases and whether you can reach each
nexus gateway chat "Hello" -m nexus/free     # one message through the gateway
nexus gateway cost-report --limit 10         # your model spend and most recent calls
```

---

## `nexus memory`

```bash
nexus memory store "The staging server is Osprey" --category infra --tags servers,staging
nexus memory list --limit 20 --category infra   # newest first
```

---

## `nexus research`

```bash
nexus research submit "How do tides work?"   # the synthesis, then its sources
nexus research submit "..." --max 5          # cap results per source (default 10, max 50)
nexus research citations 3f2a91c0            # the sources recorded for that run
```

One request does the work and answers with the report, so the command waits for it.
Research runs are held in memory: a run survives until the API restarts.

Web search uses the first search key you saved (Exa, Brave, Serper, Tavily or SearXNG), else DuckDuckGo.

---

## `nexus admin`

Admin accounts only.

```bash
nexus admin routes    # gateway aliases and where each routes
nexus admin stats     # requests, tokens, errors and latency per alias
nexus admin traces    # recent request traces
```

---

## `nexus models seed`

Fill the model catalog from a models.dev-shaped JSON file (`--file`), or the built-in copy.

---

## Route families

Every family of routes the API publishes, and how to reach it from a shell. A family is
the first real segment of the path after `/api` (`/api/v1/gateway/models` is `gateway`).
`API only` means there is no `nexus` command for it and the HTTP API is the way in;
`scripts/cli-parity.mjs` fails when a family appears or disappears without this table
moving with it, or when a row names a command that does not exist.

| Route family       | Reached by        | Routes |
| ------------------ | ----------------- | ------ |
| `(root)`           | `nexus health`    | 2      |
| `openai`           | API only          | 10     |
| `admin`            | `nexus admin`     | 18     |
| `agent`            | `nexus code`      | 2      |
| `agents`           | API only          | 4      |
| `analytics`        | API only          | 4      |
| `archetypes`       | API only          | 2      |
| `archive`          | API only          | 1      |
| `audit`            | `nexus audit`     | 2      |
| `auth`             | API only          | 23     |
| `billing`          | API only          | 12     |
| `board`            | API only          | 2      |
| `bots`             | API only          | 3      |
| `browser-agent`    | API only          | 7      |
| `channels`         | API only          | 1      |
| `chat`             | API only          | 1      |
| `chat-suggestions` | API only          | 2      |
| `code-agent`       | API only          | 5      |
| `context`          | API only          | 4      |
| `costs`            | API only          | 7      |
| `council`          | `nexus council`   | 7      |
| `csp-report`       | API only          | 1      |
| `dashboard`        | API only          | 1      |
| `deliberations`    | API only          | 2      |
| `diff`             | API only          | 3      |
| `discussion`       | API only          | 1      |
| `doc-pipeline`     | API only          | 2      |
| `exec`             | `nexus code`      | 4      |
| `feature-flags`    | API only          | 2      |
| `feedback`         | API only          | 2      |
| `gateway`          | `nexus gateway`   | 7      |
| `governance`       | `nexus approvals` | 4      |
| `groups`           | API only          | 2      |
| `hooks`            | API only          | 3      |
| `ingest`           | `nexus ingest`    | 4      |
| `kb`               | API only          | 7      |
| `kg`               | API only          | 6      |
| `libertas`         | API only          | 2      |
| `llm`              | API only          | 7      |
| `llm-oauth`        | API only          | 5      |
| `local`            | API only          | 6      |
| `lsp`              | API only          | 3      |
| `mail-ingest`      | API only          | 5      |
| `mcp`              | API only          | 9      |
| `memory`           | `nexus memory`    | 9      |
| `metrics`          | API only          | 1      |
| `mfa`              | API only          | 5      |
| `missions`         | API only          | 3      |
| `moderation`       | API only          | 3      |
| `negation`         | API only          | 3      |
| `nlp`              | API only          | 5      |
| `notifications`    | API only          | 8      |
| `oauth`            | API only          | 7      |
| `org`              | `nexus org`       | 63     |
| `plugins`          | API only          | 2      |
| `projects`         | API only          | 5      |
| `providers`        | API only          | 1      |
| `reactions`        | API only          | 4      |
| `redteam`          | API only          | 1      |
| `registry`         | API only          | 3      |
| `researcher`       | `nexus research`  | 3      |
| `rlhf`             | API only          | 7      |
| `runtime`          | `nexus tasks`     | 2      |
| `sandbox`          | API only          | 4      |
| `scim`             | API only          | 6      |
| `scraping`         | API only          | 8      |
| `search`           | API only          | 1      |
| `secrets`          | API only          | 4      |
| `session-sync`     | API only          | 3      |
| `settings`         | API only          | 2      |
| `skills`           | API only          | 4      |
| `specialisation`   | API only          | 5      |
| `sse`              | `nexus code`      | 3      |
| `system`           | API only          | 5      |
| `tasks`            | API only          | 3      |
| `threads`          | API only          | 3      |
| `tokens`           | API only          | 2      |
| `traces`           | API only          | 4      |
| `tts`              | API only          | 1      |
| `user`             | API only          | 2      |
| `users`            | API only          | 1      |
| `workflows`        | API only          | 3      |
| `workspaces`       | API only          | 7      |

---

## Environment variables

| Variable        | Required | Description                                 |
| --------------- | -------- | ------------------------------------------- |
| `NEXUS_API_URL` | —        | Base URL, default `http://localhost:3000`   |
| `NEXUS_API_KEY` | —        | Bearer token (required if API auth enabled) |

---

## Exit codes

| Code | Meaning                                         |
| ---- | ----------------------------------------------- |
| 0    | Success                                         |
| 1    | Error (HTTP failure, chain broken, parse error) |

---

## `nexus run`

Run a stored workflow without opening the UI. This is the loop for editing a workflow's prompts:
save the file, see the output, save again.

| Option        | Required | Description                                                        |
| ------------- | -------- | ------------------------------------------------------------------ |
| `--watch`     | —        | Run again whenever a file changes (Ctrl-C to stop)                  |
| `--file`      | —        | File or directory to watch; comma-separate several (default: `.`)   |
| `--input`     | —        | Run input as JSON                                                   |
| `--json`      | —        | Print the raw result as JSON                                        |
| `--out`       | —        | Write that JSON to a file                                           |

```bash
nexus run wf_8f21 --input '{"query":"weekly digest"}'

#   started   gather
#   finished  gather
#   started   decide
#   finished  decide
#
# Workflow wf_8f21: success
# { "answer": "3 decisions this week" }
```

In watch mode the output is one block per run, so a terminal scrollback reads as a history of
edits. Writes are debounced: an editor that saves three times in a second causes **one** run, and
a change that arrives while a run is in flight queues exactly one more rather than starting a
second run whose output would interleave with the first. A failed run does not stop the watch —
the next save is usually the fix.

```bash
nexus run wf_8f21 --watch --file prompts/digest.md
```

The exit code is `1` when the workflow ends in `error`, so `nexus run ... --json` works as a CI
step without parsing the output.
