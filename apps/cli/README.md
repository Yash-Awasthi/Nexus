<!-- SPDX-License-Identifier: Apache-2.0 -->
# apps/cli — nexus CLI

Developer CLI for interacting with a running NEXUS instance. Built with `commander.js`.

## Installation

```bash
# From a running dev environment
pnpm --filter apps/cli build
node apps/cli/dist/index.js --help

# Or link globally
cd apps/cli && npm link
nexus --help
```

## Commands

```
nexus health                        Check API health and readiness
nexus signals list [--priority]     List recent signals
nexus signals get <id>              Fetch a single signal
nexus council ask <question>        Submit a deliberation query
nexus tasks enqueue <type> [data]   Enqueue a task
nexus approvals list                List pending approvals
nexus approvals approve <id>        Approve a pending task
nexus approvals reject <id>         Reject a pending task
nexus audit tail [--limit]          Tail the audit log
nexus runtime status                Queue depths + circuit breaker states
```

## Configuration

The CLI reads connection settings from environment variables or a local config file (`~/.nexus/config.json`):

```bash
export NEXUS_API_URL=https://nexus.example.com
export NEXUS_API_KEY=your-api-key
```

Or pass inline:

```bash
nexus --api-url http://localhost:3000 --api-key dev-key health
```

## Development

```bash
pnpm --filter apps/cli dev   # watch mode
pnpm --filter apps/cli build # compile to dist/
```
