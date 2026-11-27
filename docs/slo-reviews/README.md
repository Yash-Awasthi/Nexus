# SLO reviews

One record per quarter, in this directory, named `YYYY-QN.md`. `docs/slos.md` says the cadence is
quarterly; this is where the quarter is written down, because a cadence with no artefact is a habit
nobody can audit.

## What a review is for

A review answers three questions and nothing else:

1. **Where did the error budget end the quarter?** Not "did anything break" — the alerts already said
   that. The budget is a number, and it is read from the same series the alerts use
   (`nexus_slo_*` at `GET /api/v1/metrics`), never from memory or from a dashboard somebody
   eyeballed.
2. **If it was exhausted, what did we do about it?** The decision is per SLO and stated in advance in
   the table below, so nobody invents a policy during an incident.
3. **What changes next quarter?** A target that moves, an SLI that turned out to be unmeasurable, an
   alert whose threshold was wrong. If the answer is "nothing", say nothing changed and why.

## The decision policy when a budget is exhausted

Written here so it is a decision rather than an improvisation, and enforced by
`scripts/slo-review.mjs --check`, which fails if the numbers below disagree with `docs/slos.md`.

| SLO                     | Target (verbatim from `docs/slos.md`)                                          | Budget                        | When the budget is gone                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| SLO-1 availability      | 99.5% over a 30-day rolling window                                             | 0.5% ≈ 3.6 h/month            | Freeze non-urgent feature deploys; fix reliability first. A deploy is allowed only with a rollback plan written in the release notes. |
| SLO-2 latency (p99)     | p99 < 500ms                                                                    | violations × 5 min            | Stop adding work to the request path; profile before the next feature.                                                                |
| SLO-3 council success   | 99% over a 7-day rolling window                                                | 1% of deliberations           | Investigate provider-side failures first, then our retries; publish the finding in the next review.                                   |
| SLO-4 queue processing  | p99 < 30s for `nexus-medium`, p99 < 10s for `nexus-high`                       | violations × 10 min           | Add worker concurrency or replicas (`docs/runbook.md` §5) before adding job types.                                                    |
| SLO-5 audit integrity   | 100% — zero tolerance for chain breaks                                         | none — a break is an incident | Playbook P4: stop, preserve evidence, postmortem, never repair by deleting rows.                                                      |
| SLO-6 dependency status | `ok` for 99.9% of the time, and never `down` for more than 5 minutes unnoticed | any `down` is an incident     | Prefer a degrading fallback over a failing dependency while it is resolved.                                                           |

## Record format

Every record has these headings, in this order, and `scripts/slo-review.mjs --check` enforces them:

```
## Quarter
## Error-budget position
## Actions taken
## Changes for next quarter
## Evidence
```

- **Error-budget position** — a table of SLO → target → measured → budget remaining, with the source
  of each number.
- **Actions taken** — what was actually done when a budget was exhausted, with dates. "None, the
  budget was intact" is a valid and checkable answer.
- **Evidence** — the exact query or command that produced the numbers, so the next review can be
  repeated rather than trusted.

## What is deliberately not here

- **No projection.** Budget burn does not extrapolate linearly, and a projection in a quarterly record
  gets quoted as a commitment.
- **No customer names.** Impact is a request count and a duration; who they were is not the review's
  business.
- **No 24×7 claim.** `docs/ONCALL.md` states the real coverage; a review that assumed otherwise would
  score the quarter against a promise nobody made.
