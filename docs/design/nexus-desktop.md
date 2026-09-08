<!-- SPDX-License-Identifier: Apache-2.0 -->

# Spec: Nexus Desktop (§15.5) — Electron shell + offline worker

Status: **spec — no code until scaffolding decision** (ROADMAP §15.5, Tier 3).

## Goal

A desktop app that puts the Nexus agent on the user's machine: local chat +
mission UI, an offline-capable worker that keeps lightweight tasks running
without a cloud, and a thin client to a self-hosted or hosted Nexus API when
connectivity exists.

## Why it fits Nexus

- The API is already a clean Fastify surface — the Electron main process is
  just another client of `/api/*` with a local token.
- `@nexus/runtime` + the agent CLI already run headless; the offline worker is
  the same code with a local SQLite/PGlite store instead of Postgres.
- The plugin marketplace (§15.1) gives desktop installs a controlled extension
  surface — same manifests, same capability grants.

## Proposed architecture

```
apps/desktop/
  electron/main/          — window mgmt, tray, auto-update, protocol handler
  electron/preload/       — contextBridge API (no nodeIntegration in renderer)
  src/                    — renderer: reuse apps/ui routes (React Router) as-is
  worker/                 — offline worker (node child process, not renderer)
    store: PGlite (WASM Postgres) or SQLite via drizzle
    queues: in-process BullMQ-compatible shim (no Redis)
    sync:  pull/push deltas against the cloud API when online
packages/local-runtime    — the offline subset of @nexus/runtime + memory
```

## Locked-in principles

1. **The renderer never touches Node.** All privileged work goes through the
   preload bridge with an explicit, typed surface (same philosophy as the
   plugin capability gate).
2. **Offline ≠ reduced capability silently.** Every feature reports its mode:
   `local-only`, `syncing`, `cloud`. No fake results offline.
3. **Secrets stay in the OS keychain** (safeStorage), never in localStorage.
   Provider keys sync from the user's own entry, one-time, and never leave the
   machine in telemetry.
4. **Auto-update via signed releases only** (electron-updater + code signing);
   unsigned dev builds refuse to auto-update.

## Offline worker scope (first slice)

Works offline: chat with local models (Ollama endpoint), mission planning,
memory read/write (local store), corpus reading, codegen diffs.
Cloud-only (clearly labeled): council deliberation with remote providers,
domain feeds, web search, fine-tune export.

## Scaffolding decisions needed before code

1. **PGlite vs SQLite** for the local store. Recommendation: PGlite — same
   Drizzle schema as the cloud, one mental model, real Postgres semantics.
2. **Reuse apps/ui directly vs a new renderer.** Recommendation: reuse — the
   routes are data-driven through `/api/*`; the desktop main process serves the
   same API locally, so the UI is unchanged.
3. **Local model serving**: bundle Ollama detection (existing install) vs
   shipping a bundled llama.cpp. Recommendation: detect + guide install first;
   bundling a runtime is a later, heavier decision.

## Milestones

1. **M1 — shell:** Electron scaffold, preload bridge, apps/ui served from the
   local API, tray + window persistence. Tests: preload bridge unit tests;
   main-process smoke test in CI with `xvfb`.
2. **M2 — local API:** the Fastify app booted with PGlite + in-process queue
   shim; the offline subset of routes green.
3. **M3 — sync:** delta pull/push with conflict policy (last-writer-wins per
   field, audit-preserved); explicit "what synced" ledger.
4. **M4 — packaging:** signed builds (Win/macOS/Linux), auto-update channel,
   crash reporting opt-in.

## Gates

- Code signing certificates (OS-specific) — operator action.
- Notarization (macOS) — operator action.
- Any telemetry endpoint decision — product call.

## Risks

- Electron + Playwright-in-sandbox (§15.4) on the same machine: GPU/driver
  conflicts → browser tasks stay in the worker process, never the renderer.
- PGlite write amplification on long missions → cap local retention + vacuum
  policy in M2.
