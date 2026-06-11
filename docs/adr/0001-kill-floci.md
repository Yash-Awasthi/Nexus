<!-- SPDX-License-Identifier: Apache-2.0 -->
# 0001 — Kill Floci

**Status:** Accepted
**Date:** 2026-06-11

## Context
GhostStack ships with `apps/floci/` — a 16 MB Maven Java project that emulates AWS services (S3, SQS, DynamoDB, Lambda, etc.) locally. NEXUS is a finance signal and AI orchestration platform. It has no use case for a local AWS emulator. The Java dependency adds build complexity, CI time, and maintenance burden without any benefit.

## Decision
Delete `apps/floci/` and all `orchestration/floci-*.ts` adapter files (approximately 10 files) from the GhostStack import. Do not replace with an alternative AWS emulator — NEXUS does not need one.

## Consequences
- Build time and repo size decrease significantly (~16 MB).
- CI no longer requires a JVM.
- Any future AWS integration uses real AWS SDKs with test mocks, not a local emulator.
- GhostStack's `FlociAdapter` is removed; its `IExecutionAdapter` slot is left for domain adapters.
