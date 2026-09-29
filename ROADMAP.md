<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Roadmap

Open work only. Shipped work is described by the code, `docs/STATUS.md` and git history, not
listed here.

Legend: **Gate** = needs a live or external action (provider key, OAuth app, live probe,
host-mutating install) · **Ceiling** = a known limit of what shipped, with the upgrade path.

> **Nexus is free/open** — no paid tier, no payment provider. "billing"/"quota" below = BYOK
> spend-guards on the user's own keys, never charging for Nexus.

Conventions for new work: build against mocks (`MockTransport`, injectable
`fetchFn`/`TokenHttp`); every live outbound call is a **Gate**; new env vars go in
`.env.example`; every new file carries the SPDX `Apache-2.0` header (`pnpm check:headers`);
migrations follow the `packages/db/migrations/` recipe (next free number, add a
`meta/_journal.json` entry or `db:migrate` skips the file); UI routes register in
`apps/ui/app/routes.ts`, compose `app/components/page.tsx`, and mirror `provider-keys.tsx`
(CRUD) or `costs.tsx` (dashboards).

---

## Provider OAuth

- **OAuth live E2E** _(Gate)_ — unit coverage exists in `packages/llm-oauth/tests/`; a live run
  needs the operator's registered OAuth app and redirect URI. Never log token-exchange bodies.

## Nexus Drive

**Spec (locked):** Firecracker microVM primary; fallback gVisor, then Docker limits. 512 MB
quota at `/workspace`; soft-warn at 90%, then hard-block. 30-day idle reclaim. The user's own
LLM key lives in `/workspace/.env`, never logged, excluded from backups and exports.

- **Isolation** _(Gate)_ — Firecracker and gVisor `runsc` both need a Linux host with KVM. The
  drive runs on Docker today behind the same interface, so the microVM is a later swap. Spike:
  boot a microVM with a 512 MB project-quota ext4 at `/workspace` and prove
  `dd if=/dev/zero of=/workspace/big bs=1M count=600` hard-fails.
- **Quota ceiling** — enforced by a pre-check plus a re-measure after each command, so an
  overrun is bounded by one command's writes. A mid-write hard fail needs root (XFS project
  quota or a loopback ext4); `--storage-opt` caps a container's layer, not a bind mount.
- **Off-machine backups** _(Gate)_ — drives back up to an S3 or R2 bucket (`DRIVE_BACKUP_S3_*`),
  tested against a mock of the bucket API and run against an S3-compatible server (Scality
  CloudServer, which checks SigV4); a run on the operator's own bucket needs their credentials.
- **Drive table** — deliberately not built: size and last activity live on the filesystem
  (`packages/sandbox/src/drive-fs.ts`). Build it when a drive needs something the disk does not
  know, such as a per-user quota override or a reclaim auditable after the files are gone.

## Plugins and federation

- **Plugin execution** — `DenoPluginRunner` runs a plugin under `deno` with read access to its
  own directory only. No route runs plugin code yet, and a plugin granted network access would
  need a localhost proxy, since `--allow-net` is never passed.
- **Knowledge-graph node and edge tombstones** — property deletes survive a sync; a deleted node
  or edge comes back from a peer that still holds it. Same mechanism as property clocks, one
  level up. No route deletes a node or edge today, so nothing asks for it yet.
- **SSO live round trip** _(Gate)_ — needs the operator's registered IdP.

## Desktop and mobile

- **Packaging (M4)** _(Gate)_ — signing certificates and macOS notarization are operator
  actions; auto-update refuses unsigned builds.
- **Vector memory on desktop** — PGlite ships without pgvector, so `0002_auto_schema_tables` is
  skipped there and vector memory stays in its in-memory store locally.
- **Mobile** — spec in `docs/design/nexus-mobile.md` (Expo RN + push); developer accounts are
  Gates.

## Backlog

- **Cheap extraction model** — deterministic distillation works today; a small model would
  improve recall.

## Blocked on external infra

| Task                     | Blocker                                   |
| ------------------------ | ----------------------------------------- |
| Firecracker / gVisor     | Linux host with KVM                       |
| Redis cluster rate-limit | Upstash / managed Redis                   |
| PgBouncer pooling        | DB admin                                  |
| K8s HPA deploy           | K8s cluster (chart in `infra/helm/nexus/`)|
| Provider OAuth app reg   | Google/GitHub dev consoles for client IDs |

## Reference note

`nexus/omni` can front any self-hosted OpenAI-compatible router to inherit a large provider
catalog with zero native driver work. Fine for dev/self-host; for production prefer native
drivers over shipping the sidecar as a silent hard dependency.
