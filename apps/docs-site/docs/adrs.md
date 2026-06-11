---
id: adrs
title: ADR Index
sidebar_position: 12
---

# Architecture Decision Records

All 18 locked architectural decisions for NEXUS.

> **These are locked.** Do not re-litigate decided ADRs. Open a new ADR if circumstances have materially changed.

- [0001-kill-floci: 0001 — Kill Floci](https://github.com/Yash-Awasthi/Nexus/blob/main/docs/adr/0001-kill-floci.md)
- [0002-postgres-sole-state: 0002 — Postgres as Sole State Store](https://github.com/Yash-Awasthi/Nexus/blob/main/docs/adr/0002-postgres-sole-state.md)
- [0003-council-deduplication: 0003 — Council Deduplication: Judica Wins](https://github.com/Yash-Awasthi/Nexus/blob/main/docs/adr/0003-council-deduplication.md)
- [0004-ts-python-boundary: 0004 — TypeScript/Python Boundary via OpenAPI](https://github.com/Yash-Awasthi/Nexus/blob/main/docs/adr/0004-ts-python-boundary.md)
- [0005-naming-registry: 0005 — Naming Registry](https://github.com/Yash-Awasthi/Nexus/blob/main/docs/adr/0005-naming-registry.md)
- [0006-apache-2-license: 0006 — License: Apache-2.0](https://github.com/Yash-Awasthi/Nexus/blob/main/docs/adr/0006-apache-2-license.md)
- [0007-eventbus-from-ghoststack: 0007 — EventBus: GhostStack Wins](https://github.com/Yash-Awasthi/Nexus/blob/main/docs/adr/0007-eventbus-from-ghoststack.md)
- [0008-plugin-sdk-first-class: 0008 — Plugin SDK is First-Class](https://github.com/Yash-Awasthi/Nexus/blob/main/docs/adr/0008-plugin-sdk-first-class.md)
- [0009-versioned-api: 0009 — Versioned API (/v1/…)](https://github.com/Yash-Awasthi/Nexus/blob/main/docs/adr/0009-versioned-api.md)
- [0010-hmac-chained-audit-log: 0010 — Audit Log is HMAC-Chained](https://github.com/Yash-Awasthi/Nexus/blob/main/docs/adr/0010-hmac-chained-audit-log.md)
- [0011-telemetry-opt-out: 0011 — Telemetry Opt-Out by Default](https://github.com/Yash-Awasthi/Nexus/blob/main/docs/adr/0011-telemetry-opt-out.md)
- [0012-reproducible-builds: 0012 — Reproducible Builds](https://github.com/Yash-Awasthi/Nexus/blob/main/docs/adr/0012-reproducible-builds.md)
- [0013-conventional-commits-changesets: 0013 — Conventional Commits + Changesets](https://github.com/Yash-Awasthi/Nexus/blob/main/docs/adr/0013-conventional-commits-changesets.md)
- [0014-i18n-ready-strings: 0014 — i18n-Ready Strings](https://github.com/Yash-Awasthi/Nexus/blob/main/docs/adr/0014-i18n-ready-strings.md)
- [0015-a11y-wcag-2-1-aa: 0015 — Accessibility Target: WCAG 2.1 AA](https://github.com/Yash-Awasthi/Nexus/blob/main/docs/adr/0015-a11y-wcag-2-1-aa.md)
- [0016-data-residency-retention: 0016 — Data Residency and Retention](https://github.com/Yash-Awasthi/Nexus/blob/main/docs/adr/0016-data-residency-retention.md)
- [0017-coverage-floor-80: 0017 — Mandatory Code Coverage Floor: 80%](https://github.com/Yash-Awasthi/Nexus/blob/main/docs/adr/0017-coverage-floor-80.md)
- [0018-pinned-base-images: 0018 — Pinned Base Images, No `latest` Tags](https://github.com/Yash-Awasthi/Nexus/blob/main/docs/adr/0018-pinned-base-images.md)

## ADR template

New ADRs follow the template at `docs/adr/_template.md`:

```markdown
# ADR-NNNN: Title

**Status:** Proposed / Accepted / Deprecated / Superseded by ADR-XXXX
**Date:** YYYY-MM-DD
**Author:** Name

## Context

What is the situation forcing this decision?

## Decision

What was decided?

## Consequences

What are the trade-offs and implications?
```
