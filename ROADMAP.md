<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Roadmap

Open work only. What ships is described by the code and `docs/`; git history is the record. When
an item is done, its line goes.

**Gate** = needs an operator action or an outside account. **Ceiling** = a known limit of something
that shipped, with the way past it. Nexus is free and open: "billing" below means spend guards on
the user's own keys, never charging for Nexus.

## Gated

- **Provider OAuth live round trip** — needs the operator's OAuth apps (Google, GitHub) and
  redirect URIs; unit coverage is in `packages/llm-oauth/tests/`. Never log token-exchange bodies.
- **SSO live round trip** — needs the operator's identity provider.
- **Drive backups on the operator's bucket** — runs against a bucket mock and an S3-compatible
  server that checks SigV4; a run on a real bucket needs the operator's credentials.
- **Desktop packaging** — code-signing certificates and macOS notarization; auto-update refuses
  unsigned builds.
- **Mobile app** — an Expo client for approvals, runs and alerts, with push notifications that
  carry ids and titles, never content; needs Apple and Google developer accounts.
- **Managed infrastructure** — Redis cluster rate limits (Upstash or managed Redis), PgBouncer
  (database admin), Kubernetes autoscaling (a cluster; the chart is in `infra/helm/nexus/`).

## Ceilings

- **Drive isolation** — Docker, or gVisor with `SANDBOX_RUNTIME=runsc`. A Firecracker runner would
  move each drive into a block image behind a VM and most hosts lack KVM, so it stays a spike
  (`scripts/drive-microvm-spike.sh`).
- **Drive quota** — checked before and re-measured after each command, so an overrun is bounded by
  one command's writes. A hard stop mid-write needs root (XFS project quota or a loopback ext4).
- **Drive links** — a signed link cannot be revoked on its own before it expires (7 days at most);
  rotating `NEXUS_SECRETS_KEY` revokes every link.
- **Plugin host calls** — `POST /api/plugins/:id/run` runs a plugin under `deno` with read access
  to its own directory only, so only plugins that ask for no capabilities run. Capabilities need a
  host bridge (for network, a localhost proxy).
- **Prompt-injection guard** — pattern screening cuts instruction-like text from sources, passages,
  webhook payloads and tool output; a reworded attack gets past it. A classifier model would catch
  more, at a call per source.
- **Batch runs** — `/v1/batches` runs one line at a time in the API process with the caller's
  token, so a restart fails the batch; `/v1/files` keeps bytes on the API host's disk. A worker
  queue job with a service identity and the drive's S3 bucket would lift both.

## On hold (billing)

- Bridge calls record spend under `DEFAULT_MODEL` instead of the model that answered, so cost pages
  price every call at one rate. Needs the answering provider on `LlmResponse`.
- Billing-only package code with no caller: billing `billingPreHandler`, gateway
  `CostCallbackRegistry`, telemetry `aggregateSessionCost` and the pricing helpers beside it.
