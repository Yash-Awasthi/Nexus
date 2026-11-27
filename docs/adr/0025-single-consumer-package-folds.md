# ADR 0025 — Fold single-consumer packages, keep the boundaries that earn their keep

**Status:** Accepted
**Date:** 2026-11-25

## Context

The workspace holds 46 packages and 7 apps for one product. A package boundary buys three things:
two consumers can share one implementation, a dependency direction can be enforced by the build
graph, and a public API can be versioned and published on its own. A package that has none of those
pays for all of them anyway — a `package.json`, a `tsconfig` project reference, a lockfile entry, a
line in every dependency-cruiser-style check, and an extra step in the release notes.

`docs/ARCHITECTURE.md` already generates a "Packages with one consumer" table from
`package.json` files, so the count is measured rather than argued about: 32 of 46 are imported by
exactly one other workspace package. Four of those have now been folded — `@nexus/gateway-log`,
`@nexus/tool-registry` and `@nexus/escalation-breaker` into `apps/api/src/lib`, and
`@nexus/llm-translate` into `packages/gateway/src` — each one a move of one to three files plus the
test file, with no behaviour change and no new import edge.

Two of the four folds found something the boundary was hiding. The `llm-translate` fold left
`packages/gateway/tsconfig.json` pointing a project reference at a directory that no longer existed,
which fails the build with "Tsconfig not found" rather than degrading quietly; the `gateway-log` fold
left the API suite's worker count at one-per-file, which oversubscribed a 20-core machine and lost a
test or two per run to timeouts until it was capped.

## Decision

A package whose only consumer is another workspace package is folded into that consumer when all of
the following hold:

1. It has no runtime dependencies of its own beyond `node:*`.
2. It is not published, or is published only by accident — a `private: false` package nobody outside
   the repository imports is not an API, and removing it needs a **major** changeset rather than a
   silent deletion.
3. It has no test that needs the package to exist as a package (a fixture that imports
   `@nexus/foo` to prove resolution keeps its own package).

Otherwise it stays, and the table is the record of why. Publishing, a second consumer, or a
dependency direction the build graph should enforce are all reasons to keep a boundary; "it is
tidier to have small packages" is not, because the cost is paid per import, per install and per
release.

Folds are done one per commit, so a review can reject one without rejecting the policy. Each fold
updates the importer, the `tsconfig` references (root **and** per-package), the lockfile, the
workspace count in `docs/STATUS.md`, the generated layer diagrams, the lib-inventory domain rule for
the module's new home, and the changeset if the package was published.

## Consequences

The workspace count has fallen from 50 to 46, and the "one consumer" table fell from 33 to 32 because
the folds removed entries faster than the table was regenerated — which is the table doing its job.
Each fold makes a future refactor local instead of cross-package, and removes one release-notes and
publishing question.

The cost is a behavioural one: a package boundary is a suggestion that stays visible in review, and a
file inside `apps/api/src/lib` is easier to reach into from a second route later. That is acceptable
here because the alternative — 32 packages with one consumer each — makes the dependency graph
unreadable, and an unreadable graph is where cycles and layering mistakes come from.

The policy does not apply to the packages that make up the product's own surface (`@nexus/sdk`,
`@nexus/cli`, `@nexus/plugin-sdk`, `@nexus/contracts`, `@nexus/llm`), which have external consumers by
design.
