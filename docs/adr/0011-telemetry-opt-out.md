<!-- SPDX-License-Identifier: Apache-2.0 -->

# 0011 — Telemetry Opt-Out by Default

**Status:** Accepted (amended 2026-06-18 — per-service opt-in replaces global flag)
**Date:** 2026-06-11

## Context

Many developer tools silently send usage telemetry. This erodes trust, especially for a self-hosted AI platform that may process sensitive data.

## Decision

Zero telemetry is sent unless the operator explicitly provides credentials:

| Service     | Opt-in mechanism              | What it controls                         |
|-------------|-------------------------------|------------------------------------------|
| PostHog     | `POSTHOG_API_KEY`             | Product analytics (page views, events)   |
| Sentry      | `SENTRY_DSN`                  | Error reporting + crash capture          |
| OTel traces | `OTEL_EXPORTER_OTLP_ENDPOINT` | Distributed tracing to any backend       |

Telemetry code ships in the build but is completely dormant when credentials are absent — the server uses `InMemoryAnalyticsClient` (no-op) and a no-op Sentry reporter. The original `NEXUS_TELEMETRY=1` global flag is **removed** in favour of per-service env vars, giving operators granular control.

## Consequences

- Privacy remains the default: no external calls without operator action.
- Operators can enable only the telemetry services they trust.
- Telemetry code paths are visible and auditable even when inactive.
- Deprecate `NEXUS_TELEMETRY=1` — remove from any `.env` files.
