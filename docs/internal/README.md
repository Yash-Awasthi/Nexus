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

## Current state

- Baseline audit: 2026-10-14, against `main` at `c9d4a19`; second pass the same day.
- `security/hardening` is merged into `main`. P2 work is on `feat/p2-enrichment`; merging it
  deploys to Render, and the operator notes in `docs/STATUS.md` say what to set first.
- Phases 0–6 of [roadmap.md](roadmap.md) are done: every critical, high and medium finding is
  fixed with a test; the security check, sign-out everywhere, security notifications, audit
  events, MFA recovery codes and the CI advisory gate shipped.
- Phase 6 (account email, NX-FEAT-015) is done; mail goes out once the operator sets
  `RESEND_API_KEY` and `NEXUS_MAIL_FROM`.
- P2 and P3 are done except the Python warm pool (NX-FEAT-014), deferred while the deployment is
  a 512 MB free instance.
- Coverage of each audit pass is listed in [security-findings.md](security-findings.md).
