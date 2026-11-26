<!-- SPDX-License-Identifier: Apache-2.0 -->

# Support

Nexus is maintained by one person. That shape decides what support can honestly promise, so
this page says what is offered rather than implying more.

## Before you ask

Three checks answer most reports in under a minute:

1. **Is it down for everyone?** `curl -s $NEXUS_URL/status` returns one row per dependency with
   what was measured. `degraded` means something optional is out; `down` means the service
   cannot answer.
2. **Is it your key?** `GET /api/user/provider-keys` shows the prefix of each stored key, never
   the value. A key revoked at the provider still appears here.
3. **Is it the last deploy?** `GET /health` names the commit this instance is running.

## Where to go

| What you have                        | Where it goes                                                                 | Response                  |
| ------------------------------------ | ----------------------------------------------------------------------------- | ------------------------- |
| A reproducible bug                   | a [bug report](.github/ISSUE_TEMPLATE/bug.yml) — the form asks for the version, the command and what you expected | best effort, in the open  |
| A feature request                    | a [feature request](.github/ISSUE_TEMPLATE/feature.yml)                       | triaged in the open       |
| A new provider, adapter or policy    | an [adapter proposal](.github/ISSUE_TEMPLATE/adapter-proposal.yml)            | in the open               |
| A security vulnerability             | **never** the issue tracker — [`SECURITY.md`](SECURITY.md)                    | privately, acknowledged within 72h |
| A question about how something works | [discussions](../../discussions), or read [`docs/`](docs/) first              | community                 |
| A paid deployment is broken          | the private channel in your contract                                          | paged, per [`docs/slos.md`](docs/slos.md) |

## What a good report contains

The bug template asks for all of it; a report missing any of it usually takes two round trips:

- the version (`nexus --version`, or the commit from `GET /health`), the OS and Node version;
- the exact command or request, with keys and tokens replaced by `redacted`;
- what happened, and what you expected instead;
- the smallest input that shows it — a workflow `JSON`, a thread, a prompt;
- the output of `GET /status` if the failure looks like an outage;
- **the diagnostic bundle**, if you want to hand over the environment in one file:
  `nexus doctor --bundle ./report` writes `nexus-bundle.json` with the doctor rows and the API's
  own `/status` and `/health`, with credentials redacted on the way in (see
  [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)). Read it before you attach it.

Logs help, but **delete anything secret before pasting**: provider keys, session tokens, the
contents of `~/.nexus/` (it holds credentials), and any `DATABASE_URL` with a password in it.

## What is not supported

- **No phone or chat support.** There is no number to call and no live queue.
- **Self-hosted deployments are not covered by any SLO.** The SLOs in `docs/slos.md` describe the
  hosted deployment's instrumented surfaces; your instance has its own, and the runbook is the
  documentation for operating it.
- **No support for modifications.** A fork that changes the model driver, the database schema or
  the auth layer is yours to run; reports about it are welcome but cannot be a commitment.
- **No deadline on community issues.** They are read and triaged; a date is not promised.
- **A vulnerability is not a support request.** It goes through `SECURITY.md` so it can be fixed
  before it is public.

## Running a single test while you debug

The fastest loop is one file, not the whole suite:

```bash
# one API test
cd apps/api && ../../node_modules/.bin/vp test run tests/routes/webhooks.test.ts

# one UI test
cd apps/ui && ../../node_modules/.bin/vp test run tests/command-palette.test.ts

# one Go package
cd services/board && go test ./pkg/mcp/ -run TestApproval -v

# one Node script test
node --test scripts/actions-pinned.test.mjs
```

Every app suite is `vite-plus/test`; import from `vite-plus/test`, not `vitest`. Add `-t "name
of the test"` to run a single case, and `--watch` to rerun on save while you work.

To debug rather than test: `pnpm dev` runs every app in watch mode, `node --inspect-brk` on a
built CLI entry gives you a debugger at the first line, and `LOG_LEVEL=debug` on the API prints
one line per request with the route and the timing (pino's default redaction keeps the body out).
