<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Testing

The suite is Vitest (unit/integration) + Playwright (e2e/a11y), with k6 for load and
shell scripts for chaos. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the contribution
workflow and the pre-commit gate.

## Unit & integration (Vitest)

```bash
pnpm test                          # Full suite (all packages, via Turbo)
pnpm --filter @nexus/council test  # Single package (much faster)
pnpm --filter @nexus/evals test    # Eval suite
pnpm test:unit                     # Unit-only target
```

Integration tests that need a live database/Redis are env-guarded with
`describe.runIf(...)` — bring infra up first:

```bash
docker compose up -d postgres redis
```

## End-to-end & accessibility (Playwright)

```bash
pnpm test:e2e     # Playwright e2e (see playwright.config.ts)
pnpm test:a11y    # Accessibility checks
```

## Load testing (k6)

```bash
k6 run infra/k6/smoke.js   # Quick smoke test
k6 run infra/k6/soak.js    # 200 VU, 5-minute soak
```

## Chaos testing

```bash
bash infra/chaos/pod-kill.sh            # Pod kill scenario
bash infra/chaos/network-partition.sh   # Network partition scenario
```

## The full gate

Before opening a PR, run what CI runs:

```bash
pnpm typecheck && pnpm test && pnpm lint
```
