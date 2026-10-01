<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Testing

Install with Node >=22.12 and `pnpm install --frozen-lockfile`, then `pnpm build`.
On Windows PowerShell, use `pnpm.cmd` if the PowerShell shim does not execute.
See [LOCAL-READINESS.md](LOCAL-READINESS.md) for the latest local evidence and limitations.

## Unit and integration suites

CI runs these distinct owners; a root Vitest pass is not an API/UI/desktop pass:

```sh
pnpm exec vitest run --coverage
pnpm --filter @nexus/api test
pnpm --filter @nexus/ui test
pnpm --filter @nexus/desktop test
```

The root `vitest.config.ts` includes package tests, worker/CLI tests and UI
colocated `app/**/*.test.ts`. It excludes `apps/api/tests/**`, `apps/ui/tests/**`,
`apps/desktop/tests/**` and worker E2E tests. Each excluded app has its own config.
The root schema tests need a placeholder `DATABASE_URL`, as in CI:
`postgresql://test:test@127.0.0.1:1/nexus_ci`.

API setup mocks `pg`, points Ollama at a closed local port and uses fixed embeddings.
Run API lib/route selections through the API config, for example:

```sh
pnpm --filter @nexus/api exec vitest run tests/lib
pnpm --filter @nexus/api exec vitest run tests/routes/health.test.ts
```

Some suites override mocks or require infrastructure: inspect their prerequisites
before running them. The worker signal-pipeline CI job provisions PostgreSQL 16
with pgvector, applies the schema in its disposable database, then runs:

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

## Python ingest

Use a dedicated virtual environment (Python >=3.11; CI uses 3.11):

```sh
cd services/ingest
python -m venv .venv
# Activate .venv/bin/activate (Unix) or .venv/Scripts/Activate.ps1 (Windows)
python -m pip install -e '.[dev]'
python -m pytest --tb=short -q
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
Load tests (`k6 run infra/k6/smoke-test.js` and `load-test.js`) require an explicitly
provisioned disposable stack and are separate from the offline gate.
