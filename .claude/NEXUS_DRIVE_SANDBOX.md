# Plan: Nexus Drive — per-user 512MB sandboxed CLI environment

## Goal
A persistent, isolated **512 MB per-user workspace** where a CLI runtime — **our Claude Code**
(provided by us) or a **user-chosen allowlisted CLI** — can execute with shell + git access
scoped to that workspace. The CLI image/runtime is ours; the user's personal storage is capped
at 512 MB and persists across sessions.

## Why it fits Nexus
Builds directly on existing capabilities, not against the grain:
- `@nexus/code-repl` + Piston already do sandboxed code execution.
- BullMQ workers (`apps/worker`) can schedule isolated, on-demand jobs.
- Postgres/Redis are available for per-user metadata, quota tracking, and job state.
- Credential storage is already wired (for git over HTTPS inside the sandbox).

So this adds *persistence* + *per-user quota* + *interactive CLI* on top of what exists.

## Locked decisions (2026-06-22)
- **Isolation:** **Firecracker microVMs** (primary target; spike confirms). Chosen for the
  strongest multi-tenant isolation of arbitrary user CLIs.
- **Quota-full behavior:** **soft warn + grace** — warn as the user nears 512 MB, allow a small
  temporary grace overage, then block writes. (More nuance than a hard ENOSPC fail; see Open
  questions.)
- **Idle retention:** reclaim a sandbox's persistent volume after **30 days idle**, with prior
  warning to the user.
- **First deliverable:** **design doc + isolation spike** (throwaway) proving Firecracker +
  512 MB FS quota works end-to-end. No production code until the spike passes.

## Design sketch
- **Isolation:** one **Firecracker microVM** per user session (primary).
  - Fallbacks if the spike hits blockers: **gVisor** (syscall-level, lighter) or **Docker +
    resource limits** (MVP/trusted-user only, weakest isolation).
- **512 MB storage cap (FS-level, tamper-proof — not app-level):**
  - 512 MB loopback ext4 image per user, **or** XFS/overlay project quota, **or** a
    quota-enforced disk-backed volume. Mounted at `/workspace`.
  - **Soft warn + grace:** emit a warning event at a near-full threshold (e.g. ~90% / ~460 MB),
    permit a bounded grace overage briefly, then enforce the hard block. Grace size + warning
    threshold are tunable (see Open questions).
- **CLI side is ours:** controlled runtime image with Claude Code preinstalled; allowlist for
  "user-chosen CLI".
- **API keys — user-supplied via `.env` in their workspace:** the user provides their *own*
  LLM/API key by placing a `.env` file in `/workspace` (it persists with the 512 MB volume).
  The CLI loads keys from that `.env` at runtime. We do **not** inject keys via Nexus's BYOK
  model for this feature. Implications:
  - The `.env` lives inside the per-user encrypted/quota'd volume; never logged, never leaves
    the sandbox; excluded from any backups/exports we surface.
  - Provide a `.env.example` / template in fresh workspaces showing the expected key names
    (e.g. `ANTHROPIC_API_KEY=`) so users know what to fill in.
  - Egress policy must still allow the CLI to reach the relevant provider API endpoints.
- **Shell / git / clone / push:** allowed *inside* the sandbox, scoped to `/workspace`;
  outbound git over HTTPS with stored credentials. Egress is policy-gated.
- **Lifecycle:** workspace volume **persists** across sessions; compute microVM is
  **ephemeral**, spun up on demand. Idle volumes are reclaimed after **30 days idle** (warn
  first); track `lastActiveAt` per workspace to drive cleanup.
- **Resource caps per sandbox:** CPU / RAM / PIDs / wall-clock timeout to prevent abuse.

## Open questions (resolve during the spike)
- Soft-quota tuning: exact warn threshold (~90%?) and grace size/duration before hard block.
- Firecracker host requirements (KVM availability, jailer setup) in the target deploy env.
- Per-user rootfs/kernel image strategy and how the persistent 512 MB volume attaches to a
  fresh microVM on each session.
- Warning + reclaim UX for the 30-day idle policy (notification channel, grace to restore).

## Surface area
- New `packages/sandbox` (or extend `@nexus/code-repl`).
- API routes `/api/v1/drive/*`: create, exec, upload, ls, quota.
- A new worker job type in `apps/worker`.
- UI panel for the drive/terminal.

## Risks
- **Multi-tenant security** (arbitrary CLI execution) — strongest cost driver; needs strong
  isolation + egress controls. Do an **isolation spike (gVisor/Firecracker vs Docker) first**.
- **Quota enforcement must be at the filesystem layer**, not the app, to be tamper-proof.
- Per-sandbox resource caps are mandatory.

## Sequencing
This is a **substantial new product feature** (security-sensitive), scoped as its own
initiative with a dedicated design doc + isolation spike. Sequence it **after** the
conductor→runtime consolidation — it is new functionality, not cleanup.
