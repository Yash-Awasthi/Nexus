<!-- SPDX-License-Identifier: Apache-2.0 -->

# 0007 — Council Fans Out with Promise.allSettled

**Status:** Accepted
**Date:** 2026-09-28

## Context

A council deliberation asks several models the same question at once. Any one of them can time out, hit a rate limit, or throw. With `Promise.all`, a single failure rejects the whole deliberation and discards the votes that did arrive.

## Decision

The deliberation engine (`packages/council/src/engine.ts`) runs every member's vote concurrently and collects them with `Promise.allSettled`. Each vote also catches its own errors and records an `abstain` with the reason, so a failing member lowers participation instead of failing the council. The tally counts only yes/no votes.

## Consequences

- One slow or broken provider never sinks a deliberation.
- A council where most members fail still answers, so outcomes near the threshold can rest on few votes; the abstentions and their reasons are in the result.
- Total latency is bounded by the slowest member, capped by the per-vote timeout.
