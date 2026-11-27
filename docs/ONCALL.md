<!-- verified: 8065a84 2026-11-25 -->

# On-call

This page says who answers a page, how fast, and what they do when it turns out to be real. It is written for the
current reality: **the rotation is one person.** A document that describes a three-person follow-the-sun rota for a
one-person project is fiction, and fiction is worse than an honest limit, because it makes people plan around
coverage that does not exist.

## 1. The rotation, stated plainly

|                       |                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Who**               | One engineer — the maintainer of record.                                                                                                                              |
| **Handover**          | None. There is no second responder and no rota to hand over to.                                                                                                       |
| **Backup**            | Nobody. When the maintainer is asleep, on a plane, or ill, nothing is being watched.                                                                                  |
| **What that implies** | Response targets below are **best effort during waking hours (UTC+05:30)**, not a 24×7 guarantee. The `/status` page and the alerting rules do not pretend otherwise. |

If a second engineer joins, the first thing to add is an overlap, not a full rota: two people covering the same six
hours beat three people each alone. Until then this page exists so the gap is written down rather than assumed away.

## 2. Response-time targets

These are targets for **acknowledgement**, not for resolution — an acknowledgement is cheap, and pretending a
single person can meet a 15-minute restore target at 3am is how an on-call document becomes a lie nobody reads.

| Severity  | Trigger (`docs/slos.md` §10.1)                                                    | Acknowledge within    | What starts immediately                                                |
| --------- | --------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| **Sev-1** | `NexusStatusDown`, `/health/ready` failing, audit chain broken (`P4`)             | 30 min, waking hours  | P1/P4 playbook, status page updated before any fix attempt             |
| **Sev-2** | Elevated error rate, p99 latency breach, queue backlog (`P2`), cost spike (`P5`)  | 2 hours, waking hours | The playbook's first diagnostic command, recorded in the incident note |
| **Sev-3** | Dependency degraded, single integration failing, SLO burn without customer impact | Next working day      | Triage queue; a postmortem only if it repeats                          |

**Outside waking hours:** nothing is acknowledged until the maintainer is awake. Pages still arrive and the status
page stays honest; the queue is the record. That is the real target, and it is written here so a customer can plan
against it instead of discovering it during an incident.

## 3. When to escalate

"Escalate" here means **wake somebody up or roll back**, because there is no tier above the maintainer:

- **Roll back first if the last deploy is within 6 hours** — `docs/runbook.md` §8, and the migration rules in
  `docs/UPGRADING.md` mean the previous tag still works against the current schema. A rollback is one command; a
  diagnosis is an hour.
- **Sev-1 with data loss or an audit-chain break** — stop serving, then preserve evidence. `P4`'s playbook exists
  because deleting the evidence of a broken chain is worse than the break.
- **Anything that needs provider support** (database, Redis, model provider) — file the ticket, and post the
  provider's incident link on our status page rather than paraphrasing it.
- **Anything that needs a decision about money** (turning off a provider, capping spend) — `P5`, and the budget
  hard stop in `/api/org/...` is the mechanism; the decision is the human's.

## 4. What to do the moment a page is acknowledged

1. **Acknowledge in the incident note** — a file under `docs/internal/incidents/YYYY-MM-DD-slug.md`, created from
   the template, with the first line saying whether customers are affected.
2. **Run the first diagnostic command from `docs/runbook.md` §10.1** for that alert. It is there because guessing
   costs more than reading.
3. **Update `/status`** (it is generated from the same probes the alerts use) before touching anything. A status
   page that lags a fix is a second incident.
4. **Fix, roll back, or mitigate** — in that order of preference only if the fix is under ten minutes; otherwise
   roll back.
5. **Write the postmortem within 48 hours**, from `docs/internal/postmortem-template.md`. Blameless, and short:
   three sections done well beat nine done badly.

## 5. Postmortems

Template: `docs/internal/postmortem-template.md`. Every Sev-1 gets one, and any Sev-2 that recurs gets one the
second time. The template asks for **the timeline, the contributing causes, and the two changes that would have
caught it** — with the follow-ups turned into plan items or issues before the postmortem is committed, because a
postmortem whose action items are a paragraph is a diary entry.

`scripts/oncall-doc.test.mjs` reads this page and the things it points at — the playbooks, the alert table, the
template — and fails when a reference rots, so a rename in the runbook cannot leave this page pointing nowhere.

## 6. Honest limits

- **No 24×7 cover.** Stated above, and it is the main limit.
- **No automatic rollback.** The rollback in §3 is a person running a command, and outside waking hours that person
  is asleep. `docs/DEPLOYMENT.md` explains why the deploy pipeline does not roll itself back: an automatic rollback
  on a health check that flaps is a second outage.
- **No separate security on-call.** A security report goes through `SECURITY.md`; the same person triages it.
