<!-- SPDX-License-Identifier: Apache-2.0 -->

# Struck Reference Repositories

These repositories appeared across multiple Nexus audit rounds and were never
referenced in any Nexus commit. No extractable pattern was found for any
`@nexus/*` package across two full audit rounds. They are permanently removed
from consideration.

**Decision date:** 2026-06-17
**Authority:** instruction.txt Section 5

---

| Repository | Reason struck |
| --- | --- |
| `jayanthmb14/forthepeople` | Never referenced in any commit. No Nexus mapping found across two audit rounds. |
| `666ghj/MiroFish` | Never referenced in any commit. No Nexus mapping found. |
| `quiet-node/thuki` | Never referenced in any commit. No Nexus mapping found. |
| `txbabaxyz/polyrec` | Superseded entirely by `Polymarket/agents` official SDK (now extracted). |
| `Alishahryar1/free-claude-code` | Rate-limit proxy hack. Not an architecture reference. |
| `ItzCrazyKns/Vane` | Never referenced in any commit across two full audit rounds. |
| `autogluon/autogluon` | AutoML training framework. Nexus does no model training. No viable transfer. |
| `Chintanpatel24/flint` | Never referenced in any commit. No Nexus mapping found. |
| `python-sandbox/python-sandbox` | `@nexus/code-repl` DockerReplExecutor is already more complete. |
| `robbyant/lingbot-map` | Not in the reference library. Too large; not relevant to any package. |

---

## Inaccessible repositories (not struck — blocked by access)

| Repository | Status |
| --- | --- |
| `Yash-Awasthi/onyx-foss` | Private or does not exist under this name. Audit blocked. Target was `@nexus/ragtime` for search pipeline patterns. Re-evaluate if access is granted. |
| `frappe/erpnext` | Rejected after deep audit — 100% Frappe-framework coupled (DB, ORM, errors, config, i18n). Zero portable subsystems. Do not re-attempt. See decision 2026-06-16. |
