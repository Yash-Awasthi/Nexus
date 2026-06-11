<!-- SPDX-License-Identifier: Apache-2.0 -->

# 0007 — EventBus: GhostStack Wins

**Status:** Accepted
**Date:** 2026-06-11

## Context

Three repos implement event buses:

- workspace: `MessageBus` (EventEmitter, pub/sub, request/response, 30-second timeout, in-memory log)
- GhostStack: `IEventBus` interface + `EventBus` implementation (typed events, correlation IDs, replay, persistence interface)
- fin-scrape: Python `asyncio.Queue`-based internal events

GhostStack's `IEventBus` is an interface — it can be implemented against Redis or in-memory. workspace's `MessageBus` is a concrete class with no interface, no persistence, and no replay.

## Decision

GhostStack's `IEventBus` interface and implementation win. workspace's `MessageBus` is retired and replaced by `@nexus/runtime`'s event bus. fin-scrape's Python events remain Python-internal and surface only through the OpenAPI boundary.

## Consequences

- One event bus contract across all TypeScript services.
- workspace's 18 agents (converted to adapters in M7) no longer need a separate MessageBus.
- Redis pub/sub is the production backend; in-memory is the test/offline backend.
