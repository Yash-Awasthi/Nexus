<!-- SPDX-License-Identifier: Apache-2.0 -->

# 0004 — TypeScript/Python Boundary via OpenAPI

**Status:** Accepted
**Date:** 2026-06-11

## Context

NEXUS uses Python (FastAPI) for the ingest service because fin-scrape's scrapers and Scrapling are Python-native and high-quality. All other services are TypeScript. The TS↔Python boundary must be type-safe and testable.

## Decision

OpenAPI 3.1 is the source of truth for the TS↔Python interface. Both sides generate their types from the same spec:

- TypeScript: `openapi-typescript` → `packages/contracts/src/ingest.gen.ts`
- Python: `datamodel-code-generator` (pydantic v2) → `services/ingest/src/nexus_ingest/contracts/`

CI verifies that generated files match the spec on every push (`git diff --exit-code`). Schemathesis runs property-based tests against both endpoints to verify behavioural equivalence.

## Consequences

- Any drift between TS and Python is caught at CI time, not runtime.
- Adding a new field requires updating the OpenAPI spec first, then regenerating.
- No hand-written DTOs at the boundary.
