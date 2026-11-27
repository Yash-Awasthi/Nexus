# Postmortem — YYYY-MM-DD — <one line that names what broke>

**Severity:** Sev-1 | Sev-2 | Sev-3
**Duration:** HH:MM (start, UTC) → HH:MM (detected) → HH:MM (mitigated) → HH:MM (resolved)
**Author:** <who wrote this>
**Status:** Draft | Reviewed | Closed

## 1. What happened, for somebody who was not there

Two or three sentences. What did a customer experience, for how long, and how did we find out — an alert, a
report, or somebody noticing on their own? If the answer is "no alert fired", say so here: that is a finding, not
an embarrassment.

## 2. Impact

| Question                   | Answer                                                  |
| -------------------------- | ------------------------------------------------------- |
| Customers affected         | <number or "all", or "none — internal only">            |
| Requests failed / degraded | <count from `/metrics`, or the estimate with its basis> |
| Data lost or exposed       | <none, or exactly what>                                 |
| Error budget burned        | <% of the monthly budget, from `docs/slos.md`>          |
| SLO breached               | <SLO-1…SLO-6, or none>                                  |

## 3. Timeline (UTC)

Facts only, one line each, including the boring minutes:

| Time  | What happened                                        |
| ----- | ---------------------------------------------------- |
| HH:MM | Deploy / first bad request / provider incident began |
| HH:MM | Alert fired — or the first person noticed            |
| HH:MM | Acknowledged, by whom                                |
| HH:MM | First diagnostic run, and what it said               |
| HH:MM | Mitigation applied (rollback / cap / restart)        |
| HH:MM | Resolved; status page updated                        |

## 4. Contributing causes

Not "the cause" — the conditions that had to be true together. At least one of them is usually "we had no test for
this" or "the alert threshold was set for a different failure mode".

1. <cause>
2. <cause>

## 5. What would have caught it earlier

Two changes, not ten. Each must be something a machine checks — a test, a gate, an alert — rather than "we will be
more careful". If a change cannot be made into a check, say why not.

| Change | Kind (test / gate / alert / playbook line) | Where it lives |
| ------ | ------------------------------------------ | -------------- |
|        |                                            |                |

## 6. Decisions this forces

Anything that contradicts a written promise — an SLO in `docs/slos.md`, a budget in `docs/OPS.md`, an invariant in
`plan.md` §0 — is an ADR (`docs/adr/`), not a paragraph here. List them:

- [ ] <decision → ADR number, or "none">

## 7. Follow-ups, before this is closed

Each one is an issue or a plan item with an owner and a date. A postmortem whose action items are a paragraph is a
diary entry.

| Follow-up | Owner | Due | Issue / plan item |
| --------- | ----- | --- | ----------------- |
|           |       |     |                   |

## 8. What went well

One or two things, honestly. Usually: the rollback worked, the status page was accurate, or the alert was precise
enough to skip triage.
