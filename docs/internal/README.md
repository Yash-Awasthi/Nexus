<!-- SPDX-License-Identifier: Apache-2.0 -->

# Internal engineering notes — security hardening and enrichment

Working documents for the security hardening and feature enrichment program that started on
2026-10-14. They are the source of truth for what was found, what was decided, what is being
built and in which order. Public-facing docs (`docs/*.md`, `SECURITY.md`) describe the product;
these describe the work.

## Files

| File                                         | What it holds                                                       |
| -------------------------------------------- | ------------------------------------------------------------------- |
| [goals.md](goals.md)                         | Why the program exists, what done looks like, what is out of scope  |
| [requirements.md](requirements.md)           | Numbered security and feature requirements (`SR-*`, `FR-*`)         |
| [architecture.md](architecture.md)           | The system as it is, seen from a security angle: boundaries, flows  |
| [security-findings.md](security-findings.md) | Findings register (`NX-SEC-*`) with evidence, severity, fix, status |
| [design.md](design.md)                       | How each fix and new feature is built, and why that way             |
| [roadmap.md](roadmap.md)                     | Phased plan with per-item status; the next thing to do is here      |
| [enrichment.md](enrichment.md)               | Feature backlog (`NX-FEAT-*`) beyond the fixes                      |

## Conventions

- **IDs are permanent.** A finding keeps its `NX-SEC-NNN` id after it is fixed; a feature keeps
  its `NX-FEAT-NNN`. Never renumber. New items take the next free number.
- **Status values:** `open`, `in-progress`, `fixed` (code merged on the working branch, test
  present), `verified` (fix exercised end to end), `accepted` (risk knowingly kept, reason
  written), `wontfix` (not a problem after all, reason written). Features use `open`,
  `in-progress` and `done`.
- **Every fix names its test.** A finding moves to `fixed` only when a test that failed before
  the change passes after it, and the register names that test file.
- **Evidence is a path and line.** `apps/api/src/routes/sandbox.ts:150` style, as of the commit
  the finding was recorded against. Lines drift; the function name next to it does not.
- **Update in the same commit.** A change that fixes a finding or ships a feature updates the
  register, the roadmap and, when behaviour changes for operators, `docs/STATUS.md` or the
  relevant public doc in the same commit.
- **Public repository.** This repository is public. A finding is described in full only in the
  same push that carries its fix. Open items that are not yet fixed stay at the level of detail
  an operator needs to mitigate them, not a recipe.

## Current state (2026-10-15)

- Everything is merged into `main` and live on Render (`nexus-iosc.onrender.com`). Findings
  NX-SEC-001 to NX-SEC-041 are fixed or accepted; P1, P2 and P3 features are done except the
  Python warm pool (NX-FEAT-014), deferred while the deployment is a 512 MB free instance.
- Checked on the live site after the last deploy: password and passkey sign-in, signed-in
  devices, sign-out, token last-use address, CSP reports, and account erasure revoking the
  account's sessions, tokens and passkeys. Code scanning has no open alerts.
- Render dashboard values override `render.yaml`. Deploys from 2026-10-12 to 2026-10-14 failed
  because the dashboard held `NEXUS_TRUST_PROXY=1`; it now holds the list in `render.yaml`. A
  deploy that never goes live shows as `update_failed` in Render's Events, not in GitHub.
- Not set yet, each a warning in the start-up log and in `nexus security check`:
  `NEXUS_MFA_KEY` (TOTP secrets are stored in plain text; setting it means users re-enrol),
  `REDIS_URL` or Upstash (rate limits reset on restart), `RESEND_API_KEY` and `NEXUS_MAIL_FROM`
  (no password reset in production), `AUDIT_EXPORT_S3_*` (audit log stays in the database only).
- Things that change on their own: Cloudflare's address ranges in `NEXUS_TRUST_PROXY`
  (if security notices start naming Cloudflare addresses, refresh them); GitHub turns scheduled
  workflows off after 60 days without commits (CodeQL, security scans, k6, ingest) and they must
  be re-enabled in the Actions tab.
- Coverage of each audit pass is listed in [security-findings.md](security-findings.md).
