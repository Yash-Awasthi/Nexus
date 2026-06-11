<!-- SPDX-License-Identifier: Apache-2.0 -->
# 0003 — Council Deduplication: Judica Wins

**Status:** Accepted
**Date:** 2026-06-11

## Context
Two repos implement multi-model deliberation independently:
- Judica: full TypeScript council with 5 providers, 4 deliberation modes (classic/blind/debate/ultraplinian), streaming, cost tracking, session persistence, 375 spec files.
- fin-scrape: `agents/council.py` (223 LOC) with weighted consensus, dissent detection, and finance personas. Entirely Python, no streaming, no persistence.

Running two councils creates divergent behaviour and maintenance overhead.

## Decision
Judica is the sole council implementation. It becomes `@nexus/council`. fin-scrape's `AgentCouncil` is deleted. fin-scrape's `personas.py` and `market_personas.py` are extracted as JSON persona presets and donated to `@nexus/council/src/presets/finance.*`.

## Consequences
- One council codebase, one API, one test suite.
- Finance personas are preserved as JSON presets — no Python dependency for deliberation.
- fin-scrape's Python service (nexus-ingest) handles scraping only; it calls `@nexus/council` via the TypeScript API.
