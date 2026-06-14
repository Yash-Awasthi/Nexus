<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS CLI Reference

**Package:** `@nexus/cli`  
**Binary:** `nexus`  
**Config:** `NEXUS_API_URL` (default `http://localhost:3000`), `NEXUS_API_KEY`

---

## Installation

```bash
# From repo (dev)
pnpm --filter @nexus/cli build
node apps/cli/dist/index.js

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

| Option        | Required | Description                           |
| ------------- | -------- | ------------------------------------- |
| `--title`     | ✅       | Proposal title                        |
| `--desc`      | —        | Proposal description                  |
| `--budget`    | —        | LLM cost cap in USD (default: `0.10`) |
| `--signal-id` | —        | Link to existing signal UUID          |

```bash
nexus council deliberate \
  --title "Should we deploy the new pricing algorithm?" \
  --desc "New algorithm optimises for LTV, potential 12% revenue uplift" \
  --budget 0.15

# ● Outcome: APPROVED
#   Consensus: 78%
#   Summary: Council approved. 7 YES / 2 NO / 0 ABSTAIN. Majority: YES.
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
