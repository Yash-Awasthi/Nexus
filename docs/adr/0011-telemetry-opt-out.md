<!-- SPDX-License-Identifier: Apache-2.0 -->

# 0011 — Telemetry Opt-Out by Default

**Status:** Accepted
**Date:** 2026-06-11

## Context

Many developer tools silently send usage telemetry. This erodes trust, especially for a self-hosted AI platform that may process sensitive data.

## Decision

Zero telemetry is sent unless `NEXUS_TELEMETRY=1` is explicitly set. The opt-in is documented in the README and `.env.example`. No telemetry collection code ships in the default build path.

## Consequences

- Privacy is the default.
- Usage analytics require explicit user action.
- We lose automatic crash reporting — structured logging and OTel traces (local) are the alternative.
