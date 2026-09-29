<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Roadmap

Open work only. What ships is described by the code and `docs/`; git history is the record. When
an item is done, its line goes.

**Gate** = needs an operator action or an outside account. Nexus is free and open: "billing" below
means spend guards on the user's own keys, never charging for Nexus.

## Gated

- **LLM provider OAuth live round trip** — signing in to Google Vertex or Microsoft Entra for
  model access needs a GCP or Azure project; unit coverage is in `packages/llm-oauth/tests/`.
- **Desktop packaging** — code-signing certificates and macOS notarization; auto-update refuses
  unsigned builds.
- **Mobile app** — an Expo client for approvals, runs and alerts, with push notifications that
  carry ids and titles, never content; needs Apple and Google developer accounts.
- **Managed infrastructure** — Redis cluster rate limits (Upstash or managed Redis), PgBouncer
  (database admin), Kubernetes autoscaling (a cluster; the chart is in `infra/helm/nexus/`).

## On hold (billing)

- Bridge calls record spend under `DEFAULT_MODEL` instead of the model that answered, so cost pages
  price every call at one rate. Needs the answering provider on `LlmResponse`.
- Billing-only package code with no caller: billing `billingPreHandler`, gateway
  `CostCallbackRegistry`, telemetry `aggregateSessionCost` and the pricing helpers beside it.
