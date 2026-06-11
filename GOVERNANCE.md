<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS Governance

## Model

NEXUS currently operates under a **BDFL** (Benevolent Dictator For Life) model with a defined path to lazy consensus as the contributor base grows.

**BDFL:** Yash Awasthi (@Yash-Awasthi)

The BDFL has final say on all architectural decisions, ADRs, and release timing. This is intentional at the current scale — it prevents design-by-committee and preserves the architectural coherence described in the README.

## Decision process

| Category          | Process                                                          |
| ----------------- | ---------------------------------------------------------------- |
| Bug fixes         | PR + 1 maintainer approval                                       |
| Feature additions | PR + ADR (if architectural) + 1 maintainer approval              |
| Breaking changes  | RFC issue → discussion period (7 days min) → ADR → BDFL approval |
| New ADR           | Draft in PR, 3-day comment window, BDFL merges                   |
| Release           | BDFL triggers release workflow                                   |

## Path to lazy consensus

Once NEXUS has ≥ 3 regular contributors (≥ 5 merged PRs each), the project will move to **lazy consensus**: any maintainer can merge PRs that pass CI and have been open ≥ 48 hours with no objections, unless marked `needs-bdfl-review`.

## Roles

| Role        | Criteria                          | Responsibilities                              |
| ----------- | --------------------------------- | --------------------------------------------- |
| Contributor | Any merged PR                     | Follow CONTRIBUTING.md, DCO sign-off          |
| Maintainer  | ≥ 10 merged PRs + BDFL nomination | Review PRs, triage issues, cut releases       |
| BDFL        | Founder                           | Final architectural authority, release gating |

## Conflict resolution

1. Discuss in the relevant PR or issue.
2. If unresolved after 72 hours, escalate to a GitHub Discussion.
3. BDFL makes the final call.

## Amendments

Changes to this document require a PR with a 7-day comment period and BDFL approval.
