<!-- SPDX-License-Identifier: Apache-2.0 -->
# 0005 — Naming Registry

**Status:** Accepted
**Date:** 2026-06-11

## Context
Four repos use inconsistent naming (GhostStack, ghoststack, ghost-stack; Judica council vs council service vs deliberation engine; etc.). A canonical naming registry prevents confusion.

## Decision
See Section 4 of README.md for the authoritative naming table. Key entries:

| Concept | Canonical name |
|---------|---------------|
| Master project | NEXUS |
| Runtime kernel | `@nexus/runtime` |
| Council engine | `@nexus/council` |
| Governance | `@nexus/governance` |
| Ingest service | `nexus-ingest` |
| Adapters | `@nexus/adapter-<name>` |

All code, docs, and CI must use these names. No aliases.

## Consequences
- One-time rename effort during M2 pruning.
- Documentation stays consistent automatically.
