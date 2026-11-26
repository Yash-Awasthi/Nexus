<!-- SPDX-License-Identifier: Apache-2.0 -->

# 0019 — Keep an installed dependency that carries no licence, because nothing imports it

**Status:** Accepted
**Date:** 2026-11-24

## Context

`node scripts/license-audit.mjs` walks the installed tree and fails on any package in
the production closure whose licence it cannot read. Two packages fail that walk but
not in the same way:

- `@giscus/react@3.1.0` declares no licence in `package.json`, ships no licence file,
  and the npm registry has no licence for it either. Its upstream repository
  (`giscus/giscus-component`) is MIT, so the grant exists — the tarball just does not
  say so. That resolves as an entry in `.github/license-exceptions.json` naming MIT
  and the repository the answer came from.
- `@splinetool/runtime@0.9.526` declares no licence, ships no licence file, has no
  licence on the registry, and the repository its `package.json` points at returns 404. There is no grant anywhere to record.

Both arrive the same way, and neither is a dependency we chose: the UI app depends on
`@lobehub/icons`, which declares `@lobehub/ui` as a **peer**, which declares both of
these. pnpm installs peers, so they are on disk whether or not anyone imports them.

## Decision

Keep `@splinetool/runtime` in `node_modules` and treat it as **not distributable**:
no code from it may be imported, bundled or shipped. Record that as an exception
entry naming this ADR, so the gate is green while the fact stays visible.

The evidence that it is not in the build is that nothing imports `@lobehub/ui` — the
only mention of it in the repository is `apps/ui/vite.config.ts`, which names it in
the pre-bundler's `include` list so the optimizer never discovers it mid-session. No
route module imports the package, so neither the package nor the Spline runtime
reaches the bundle. `@lobehub/icons` ships its icons without going through
`@lobehub/ui` at runtime.

Revoking this decision is cheap in either direction: the gate prints the package on
every run, so the moment `@lobehub/icons` drops the peer, `license-audit` reports a
stale exception and the entry is deleted.

## Consequences

- `.github/license-audit.mjs` fails the build on a **new** unlicensed package, and on a
  strong copyleft licence with no ADR. This one is accepted by name, not by accident.
- If a future change imports `@lobehub/ui` (or `@lobehub/icons` starts forwarding to it),
  the Spline runtime would enter the bundle and this ADR would be wrong. The check
  before doing that: `grep -r splinetool apps/ui/dist` after a build must stay empty,
  and `@splinetool/runtime` would have to be replaced or removed first.
- `@lobehub/ui` is an unused dependency of an unused peer: removing `@lobehub/icons`,
  or pinning `auto-install-peers=false` for that package, would delete three packages
  from the tree. Not done here — it is a UI decision, not a licensing one.
- `NOTICE` carries both packages in its generated block, so the attribution travels with
  the distribution even though the code does not.
