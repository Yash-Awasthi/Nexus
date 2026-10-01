<!-- SPDX-License-Identifier: Apache-2.0 -->

# 0018 — BullMQ Repeatable Jobs for Domain Feed Polling

**Status:** Accepted
**Date:** 2026-09-28

## Context

Domain feeds (weather, crypto, news, RSS, port congestion) must be refreshed on their own schedules. A `setInterval` in each API or worker process would poll once per replica and forget its schedule on restart.

## Decision

The worker registers each feed as a BullMQ repeatable job (`queue.add(name, data, { repeat: { every } })`) at startup. Redis holds the schedule, so exactly one worker runs each refresh however many replicas are up, and the schedule survives restarts.

## Consequences

- Polling scales with workers without duplicate refreshes.
- Scheduled refreshes need Redis and a running worker.
- Changing an interval means changing the repeat options; BullMQ keys repeatables by them, so the old schedule must be removed.
