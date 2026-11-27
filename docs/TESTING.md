<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- verified: 8065a84 2026-11-25 -->

# Nexus — Testing

Install with Node >=24 and `pnpm install --frozen-lockfile`, then `pnpm build`.
On Windows PowerShell, use `pnpm.cmd` if the PowerShell shim does not execute.
The measured results on this tree are in [plan.md](../plan.md#measured-on-this-tree).

## Unit and integration suites

CI runs these distinct owners; a root Vitest pass is not an API/UI/desktop pass:

```sh
pnpm exec vp test run --coverage
pnpm --filter @nexus/api test
pnpm --filter @nexus/ui test
pnpm --filter @nexus/desktop test
```

The root `vitest.config.ts` includes package tests, worker/CLI tests and UI
colocated `app/**/*.test.ts`. It excludes `apps/api/tests/**`, `apps/ui/tests/**`,
`apps/desktop/tests/**` and worker E2E tests. Each excluded app has its own config.
The desktop suite includes `tests/updater.test.ts`, which generates an Ed25519
keypair and drives the feed and download paths without a network: a tampered
manifest, a wrong key, a non-Ed25519 key, a mismatched sha256 and an oversized
body are all refusals, and a staged installer is only handed to `spawn` after a
fresh hash check. The UI suite covers the chat-stream 429 message
(`app/lib/deliberate-errors.test.ts`): a throttled turn names the `Retry-After`
wait instead of reading as a failure. `pnpm --filter @nexus/desktop measure:launch`
is the manual packaged-app timing check, not part of CI.

### Coverage floors

The root config carries a global threshold, and `scripts/coverage-floors.mjs`
holds each package to its own floor from `.github/coverage-floors.json` — one
package at 40% cannot hide behind twenty at 95%. Floors are per metric
(statements, branches, functions, lines), computed as weighted sums of the
per-file counts in `coverage/coverage-summary.json` (a 10-line file must not weigh
as much as a 1000-line one).

```sh
pnpm exec vp test run --coverage     # writes coverage/coverage-summary.json
node scripts/coverage-floors.mjs     # check every package against its floor
node scripts/coverage-floors.mjs --record   # raise floors to what was measured
```

`--record` only ever raises a floor: a drop needs a hand edit to the JSON and a
reason in the commit. The `unit` job runs the check with `--strict` after its
coverage pass, so a missing summary there fails instead of passing quietly, and
`scripts/coverage-floors.test.mjs` covers the arithmetic (weighted sums, the
ratchet, a package with no floor).

`pnpm check:release` is the static release gate: it reads
`electron-builder.yml`, `release.yml` and the desktop package version and fails
on a renamed artifact, a notarise hook moved under `mac`, a missing
`node_modules` resource, an unsigned-feed path, or a tag that cannot be matched
against the app version. `pnpm release:verify --dir <downloads> --public-key
<embedded.pem>` checks `SHA256SUMS`, the detached manifest signature and each
artifact's size and sha256 from a release page, without installing anything.
The root schema tests need a placeholder `DATABASE_URL`, as in CI:
`postgresql://test:test@127.0.0.1:1/nexus_ci`.

API setup mocks `pg`, points Ollama at a closed local port and uses fixed embeddings.
Run API lib/route selections through the API config, for example:

```sh
pnpm --filter @nexus/api exec vitest run tests/lib
pnpm --filter @nexus/api exec vitest run tests/routes/health.test.ts
```

Some suites override mocks or require infrastructure: inspect their prerequisites
before running them. The worker signal-pipeline CI job provisions pgvector on
PostgreSQL 18, applies the schema in its disposable database, then runs:

```sh
pnpm --filter @nexus/worker test -- --reporter=verbose tests/e2e/
```

## Browser E2E

```sh
node --test scripts/e2e-server.test.mjs
pnpm exec playwright install chromium
pnpm test:e2e
# Bounded smoke selection:
pnpm test:e2e landing.spec.ts auth.spec.ts dashboard.spec.ts --global-timeout=120000
```

Build first. Playwright starts its own API on `127.0.0.1:3999` and refuses to reuse
an existing server. `scripts/e2e-server.mjs` allocates new PGlite/storage directories
under the OS temp directory and passes an allowlisted environment. It skips the
checkout `.env`, inherits no provider keys or database URLs, and disables API
outbound TCP/fetch using `scripts/e2e-offline.cjs`. `PLAYWRIGHT_BASE_URL` is not used.
Temporary data is retained for local debugging; remove only directories belonging
to your finished runs. The `browser` CI job runs this offline suite separately from
the worker signal-pipeline job.

Model-dependent specs are skipped unless `E2E_MODELS` is set; do not set it for this
offline harness. This suite does not verify paid providers or live model behavior.
There is no root `test:unit` or `test:a11y` script. Browser tests include phone-width
layout assertions, not a comprehensive accessibility audit.

### Waiting, and when a spec is quarantined

A fixed sleep is a guess about a machine, and the guess is wrong on any machine
slower than the one the test was written on — that is the flake somebody re-runs
until it passes. Two rules, enforced by `node --test scripts/e2e-waits.test.mjs`
(run in the lint job and in `make verify`):

- no spec calls Playwright's `waitForTimeout()`;
- a `setTimeout` wait of 200 ms or more lives inside a polling helper whose name
  says so (`waitFor…`, `poll…`, `…until…`, `…settle…`), never in a test body.

The rule has a canary: the test fails if it finds fewer than 15 spec files, so a
reorganised suite cannot leave the rule passing while checking nothing.

Stability protocol: run the selection five times
(`pnpm test:e2e <specs>` ×5). A spec that is not 5/5 is quarantined rather than
retried in place — `test.fixme` with the reason and the failing step written in the
spec — and it comes back only with a fix. The two specs that failed on the Windows
development host during the M1.1 baseline (`chat-history`, `skills`) still need
that decision, and it needs a machine with browsers: `needs-verify`.

## Skipped tests

A skip is a test that exists and does not run. Each one is listed here with the
condition that turns it on, so a skip cannot hide a dead test indefinitely. The
list is generated, not remembered:

```sh
node scripts/baseline.mjs --skips        # units (16 on a host without python/deno)
node scripts/baseline.mjs --json         # adds the e2e counts
```

All 27 current skips are intentional; none is dead.

### Unit skips (16)

| Test                                                                                                  | Why it is skipped                                                                                                 | Runs when                                                                             |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/code-repl/tests/python-cell.test.ts` — 3 tests, "InterpreterProcess (python)"               | No `python`/`python3` on `PATH` (`describe.skipIf(!python)`)                                                      | Any host with a Python 3 interpreter installed                                        |
| `packages/lsp/src/integration.test.ts` — 2 tests, "real typescript-language-server"                   | The configured LSP binary does not resolve on `PATH` (`it.skip`)                                                  | The `NEXUS_LSP_*_CMD`/`typescript-language-server`/`pyright-langserver` binary exists |
| `packages/lsp/src/transport-spawn.test.ts` — 1 test, "resolveSpawn leaves a POSIX command unchanged"  | POSIX-only (`it.runIf(process.platform !== "win32")`); Windows has its own two cases                              | Linux or macOS                                                                        |
| `packages/plugin-sdk/tests/plugin-sandbox.test.ts` — 5 tests, "DenoPluginRunner with a real deno"     | `deno` does not resolve (`describe.skipIf(!hasDeno)`)                                                             | `deno` installed; the five cover run/output, network, env, write and read denial      |
| `packages/sandbox/tests/drive-run.test.ts` — 1 test, "drive run permissions"                          | POSIX directory modes (`it.skipIf(process.platform === "win32")`)                                                 | Linux or macOS                                                                        |
| `apps/api/tests/lib/migrate-concurrent.test.ts` — 1 test, "concurrent migrations on Postgres"         | `NEXUS_TEST_POSTGRES_URL` unset (`describe.runIf(PG_URL.length > 0)`)                                             | The `migrations` CI job, which provisions PostgreSQL 18                               |
| `apps/api/tests/routes/provider-keys.test.ts` — 3 tests, "BYOK /api/user/provider-keys (integration)" | Needs `DATABASE_URL`, `NEXUS_SECRETS_KEY`, `NEXUS_JWT_SECRET` and `NEXUS_API_KEY` all set (`describe.runIf(RUN)`) | All four are present, i.e. a provisioned instance with secrets                        |

### Browser E2E skips (11)

All 11 are in `apps/ui/tests/e2e/org-models.spec.ts` and are skipped unless a model
is configured (`E2E_MODELS=1`, plus `E2E_PRICED` for the ones that price a replay).
They exercise answers, budget hard stops, hire approval, discussion threads, replay
diffs and scorecard-driven model moves — all of which need a live model, which the
offline harness deliberately does not provide. The other specs (`org.spec.ts`,
`terminals.spec.ts`) skip individual cases when `GET /api/local/status` does not
answer 200, i.e. on a hosted server.

### Where the skips actually run

A skip with a switch that nothing ever flips is a dead test with better manners. Of
the 27, four run in CI on Linux: the two POSIX-only cases above, and
`apps/api/tests/lib/migrate-concurrent.test.ts` in the `migrations` job. The rest
run only on a host that has the missing piece — a local Python or Deno install, an
LSP binary, the four secret variables, or `E2E_MODELS`. That is deliberate for the
model-dependent ones and the offline harness must not set it; a local run is the
place to exercise them.

## Offline acceptance

```sh
pnpm check:offline
```

One pass/fail line per offline-track check: the API boots with `DATABASE_URL` unset
(PGlite) and outbound sockets blocked, the sandbox image runs Python under
`--network=none`, the desktop main process and UI build exist, and — when reachable —
the model answers one short turn and SearXNG returns hits. SearXNG is a metasearch front
end, so it answers without the WAN but its results still come from upstream engines. A
missing prerequisite reports `skip` with the reason; anything attempted and failed exits

1. Set `SEARXNG_URL` (for example `http://127.0.0.1:4000`) to include the search check,
   and `NEXUS_SANDBOX_IMAGE` to probe a different image.

## Python ingest

The service pins Python 3.14 and locks its dependencies in `uv.lock`:

```sh
cd services/ingest
uv sync --extra dev
uv run pytest --tb=short -q
```

Tests mock DB, Redis and scraping. Avoid inherited service configuration or a local
`.env` when testing; the readiness report records the explicit isolated invocation.

## Complete CI gate

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm check:headers
pnpm openapi:check
pnpm types:check
```

Also run the separate test owners above. Coverage thresholds live in
`vitest.config.ts`; do not replace coverage checks with a smoke selection.

`pnpm lint` derives its targets from `pnpm-workspace.yaml` (`scripts/lint-targets.mjs`),
and four assertions keep that honest — every workspace package must have a source
directory, a `tsconfig.json`, a lint target and a reference in
`tsconfig.build.json`:

```sh
node --test scripts/lint-targets.test.mjs
```

A new package that skips any of those fails here instead of going unverified.
Load tests (`k6 run infra/k6/smoke-test.js` and `load-test.js`) require an explicitly
provisioned disposable stack and are separate from the offline gate.
