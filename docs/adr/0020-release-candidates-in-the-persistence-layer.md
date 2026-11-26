<!-- SPDX-License-Identifier: Apache-2.0 -->

# 0020 — Four pre-release dependencies, and the conditions that end each one

**Status:** Accepted
**Date:** 2026-11-25

## Context

`node scripts/prerelease-audit.mjs` reads every manifest and the `catalog:` block of
`pnpm-workspace.yaml` and finds four installed packages whose version is a release
candidate or a beta:

| Package                | Installed       | Why a stable release does not work           |
| ---------------------- | --------------- | -------------------------------------------- |
| `drizzle-orm`          | `1.0.0-rc.6`    | 0.44 is a different API, not an older subset |
| `drizzle-kit`          | `1.0.0-rc.6`    | must match the runtime exactly               |
| `@monaco-editor/react` | `4.8.0-rc.3`    | 4.7 does not make Monaco SSR-safe            |
| `node-pty`             | `1.2.0-beta.15` | 1.1 has no Node 26 prebuild, so it compiles  |

A release candidate is not a licence problem and not a security problem by itself. It is
a schedule problem: an RC can change its API without a semver major, and nobody notices
because a lockfile keeps the old build green. The failure this ADR prevents is the quiet
one — a dependency nobody decided to keep, still installed two years later because
removing it looked risky and nobody remembered why it was there.

## Decision

Keep all four, with three things recorded per package in
`.github/prerelease-policy.json`: an owner (the domain, not a person), the reason a
stable release does not work, and the exit condition — the concrete event that ends the
exception. Every entry points back to this ADR.

The audit is a gate, not a report. It fails when a pre-release is installed that the
policy does not name, when the policy names a version the tree no longer uses (an
acceptance that outlived its dependency is a stale claim), when an entry has no owner,
reason or exit, and when the ADR it cites does not exist. `--write` regenerates the
table in `docs/OPS.md` §6, so the prose and the tree cannot disagree.

## Exit conditions, one at a time

- **Drizzle GA.** Replace both `1.0.0-rc.6` entries with `^1.0.0`, delete the two policy
  entries, regenerate, and re-run `apps/api/tests/lib/migrate-forward-only.test.ts` and
  `scripts/migrations-forward-only.mjs` — the migration splitter is the part an RC can
  change under us.
- **`@monaco-editor/react` 4.8.x stable.** The only API in use is `<Editor>` with
  `onMount`, so the change is a version bump plus one screenshot of the editor page.
- **`node-pty` 1.2.0 stable, or 1.1 gaining a Node 26 prebuild.** Either removes the beta;
  the second also removes the compile step from every install.

## What would make this ADR wrong

If an RC ships a behaviour change that no test covers, keeping it becomes a risk rather
than a schedule. The exit conditions above are the answer to that, and the audit's
version check is what makes them visible: a bumped RC fails the gate until somebody
writes down what the bump means.
