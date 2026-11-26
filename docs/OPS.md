<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- verified: c6e5d6c 2026-11-24 -->

# Nexus — Operational reference (health, SSE, durable stores)

Short operational surface for the surfaces built and verified in the 2026-09-06
durability campaign: health endpoints with flush observability, the research SSE
stream, the shared-KV durable stores, and graceful shutdown. For general day-2
operations (logs, queues, DB, scaling, incidents) see
[runbook.md](runbook.md); for the current build state see
[STATUS.md](STATUS.md). Environment variables are documented in
[`.env.example`](../.env.example).

---

## 1. Health endpoints (root scope — no prefix, no auth)

Registered in `apps/api/src/routes/health.ts`, mounted at the Fastify **root**
(`/health`, `/health/ready` — **not** under `/api` or `/api/v1`). Both return
`Cache-Control: no-cache`.

### `GET /health` — liveness

```json
{ "status": "ok", "version": "0.1.0", "timestamp": "2026-09-06T…Z" }
```

Always 200 while the process serves.

### `GET /health/ready` — readiness

Runs all probes concurrently (each bounded by its own timeout) and returns:

```json
{
  "status": "ready | degraded | down",
  "checks": { "db": "ok", "kv": "ok", "costlog_flush": "ok" },
  "messages": {},
  "latencies": { "db": 1.2, "kv": 0.8, "costlog_flush": 0.01 },
  "durationMs": 3.1,
  "costLog": {
    "pendingEntries": 0,
    "dirty": false,
    "lastFlushAt": "2026-09-06T…Z",
    "lastFlushAgeMs": 4100,
    "consecutiveFailures": 0,
    "totalFlushes": 12,
    "totalFailures": 0
  }
}
```

Probes:

| Probe           | Critical | Fails when                                                  |
| --------------- | -------- | ----------------------------------------------------------- |
| `db`            | yes      | `SELECT 1` throws → status `down` → **HTTP 503**            |
| `kv`            | no       | shared-KV set/get round-trip fails → `degraded` (still 200) |
| `costlog_flush` | no       | `consecutiveFailures ≥ 3` (cost-log KV flushes failing)     |

Status mapping: all ok → `ready` (200); a non-critical probe fails → `degraded`
(200, pod stays in rotation); any critical probe fails → `down` (503).

The `costLog` block is the write-behind flush health for the cost log (see §4):
it rides **every** readiness response, so an operator always sees the pending
tail and the age of the last successful flush — not only when the probe trips.
A growing `pendingEntries` with climbing `consecutiveFailures` means persistence
has silently degraded to in-memory (reads still work; history would be lost on
restart).

---

## 2. SSE streams

| Stream                                                                       | Auth | Purpose                                                                   |
| ---------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------- |
| `GET /api/research/:id/stream` (bridge scope)                                | yes  | Deep-research run: phases, citations, report, done                        |
| `GET /api/v1/sse/tasks/:taskId`, `sse/verdicts/:taskId`, `sse/agent/:stream` | yes  | One task, verdict or agent run the caller owns; there is no global stream |

### Research run stream (`/api/research/:id/stream`)

Event framing is `data: <json>\n\n` per event, in this order for a successful run:

1. `phase_start` — `planning`
2. `phase_start` / `phase_done` — `researching` (per search cycle)
3. `phase_start` — `synthesis`; `citation` events as sources are emitted
4. `phase_done` — `synthesis`; `phase_start` — `complete`
5. `report` (full synthesis text) then `done` (`totalMs`)

Failures emit an `error` event and write the job record through to `error`.
The page never consumes `phase_start`'s sibling `phase_done` from a _replayed_
job: the durable record, not the live stream, is the source of truth for
history/deep links (see §4).

---

## 3. Shared KV — what backs the durable stores

All stores below persist to a single shared-KV abstraction (`getSharedKV()` in
`apps/api/src/lib/shared-kv.ts`). Backend priority:

1. Cloudflare Workers KV (when running on the CF edge)
2. **Redis** — `REDIS_URL` (same instance that backs BullMQ; cross-pod safe)
3. **Upstash REST** — `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
4. **In-process memory** — no Redis/Upstash configured (single pod only)

> The in-memory fallback is a **dev/CI convenience only**: data does not survive
> an API restart and is not shared across pods. Production requires Redis (or
> Upstash). Per-user stores remain isolated regardless of backend; the cost log
> is **workspace-global by design** (single-install semantics — see §4).

### What is safe to lose if Redis is flushed

Redis is a cache in some places and the only copy in others, and the difference
matters at 3 a.m. `FLUSHALL` is safe for the top half of this table and data loss
for the bottom half. Nothing below needs a migration to recover: the ones marked
_rebuilt_ or _retried_ repair themselves on the next write or next request.

| Keys                                          | Owner                                      | If it is lost                                                                                                          |
| --------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `cache:*`                                     | `packages/llm-cache`                       | **Safe.** Rebuilt on the next identical prompt; the only cost is tokens spent twice                                    |
| `ratelimit:*`                                 | `lib/rate-limiter.ts`                      | **Safe.** Counters restart at zero, so limits are briefly more permissive, then refill                                 |
| `oauth:state:*`, `oidc:state:*`, `saml:req:*` | `routes/{oauth,oidc,saml}.ts`              | **Safe.** A sign-in in flight fails closed; the user retries and gets a fresh state (5–10 min)                         |
| `kb:*`, `graph:idx:*` job markers             | `routes/kb.ts`                             | _Retried._ An in-flight graph job loses its marker; the job is marked interrupted, not corrupted                       |
| `costlog:day:YYYY-MM-DD`                      | `lib/cost-log.ts`                          | **Usage history for those days.** The in-memory tail survives and re-flushes; older days do not                        |
| `thread:*`, `notif:*`, `diffhist:*`           | `lib/{threads,notifications,diff-history}` | **User content.** Threads, notifications and edit diffs are gone — these are not derived                               |
| `research:list                                | item:_`, `mission:_`, `graph:*`            | research/mission/session stores                                                                                        | **User content.** Research runs, missions and session graphs are gone |
| `bull:nexus-{high,medium,low,dlq}`            | `packages/agent-core`                      | **Queued work.** Waiting and in-flight jobs vanish; the durable task rows remain and are re-enqueued by the reconciler |

So: flush Redis to fix a corrupted cache or a stuck queue, and expect to lose
queued jobs and the date range of stored content you flushed. Take the Postgres
backup path (§4) before flushing anything you care about — the KV stores are not
in `pg_dump`.

Two facts make that table checkable rather than aspirational:

- **Boot is not a special case.** `apps/api/tests/lib/empty-redis.test.ts` starts a
  real RESP server on a socket that knows an empty keyspace, points `REDIS_URL` at
  it, and asserts the app selects `RedisKVStore`, that every read answers empty
  instead of throwing, and that the first `/api/notifications`, `/api/threads` and
  `/api/missions` requests return `200`/`401` — never `500` — with the health
  probe's `kv` leg reporting `ok`. Breaking that fake so a cold `thread:list` read
  fails turns the same test red (`/api/missions answered 500`).
- **The class above is the roadmap.** A key family not in the table is undefined
  behaviour after a flush; adding one means adding a row.

---

## 4. Durable stores

All are KV stores written through from route/emitter code with **write-through
on state transitions**. Key layout, TTL, and recovery semantics:

| Store (owner module)                             | Keys                                                               | TTL   | Semantics / recovery                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threads** (`lib/threads-store.ts`)             | `thread:list:{uid}`, `thread:item:{uid}:{id}`, per-thread messages | 365 d | Per-user. Id list is write-order authoritative; locked read-modify-write per key                                                                                                                                                                                                                                                                                                               |
| **Notifications** (`lib/notifications-store.ts`) | `notif:list:{uid}`, `notif:item:{uid}:{id}`                        | 30 d  | Per-user. Research completion/failure notifications link to `/deep-research?id=…`                                                                                                                                                                                                                                                                                                              |
| **Research jobs** (`lib/research-jobs.ts`)       | `research:list:{uid}`, `research:item:{uid}:{id}`                  | 90 d  | Per-user, 200 jobs/user cap. Milestones (`phase → startedAt/finishedAt/detail`) persisted at every phase transition. **Zombie recovery**: a job still `running` whose `updatedAt` is > 5 min old (engine is provably bounded to one ≤15 s search + one ≤90 s synthesis) is written through to `error` — "Interrupted before completion…" — on the next read, so no surface shows a phantom run |
| **Cost / usage log** (`lib/cost-log.ts`)         | `costlog:day:YYYY-MM-DD`                                           | 150 d | **Workspace-global** (matches the weekly digest's single-install semantics). In-memory array capped at 10 000 newest entries is the hot read path; a debounced batched flush (2 s trailing idle, 10 s max under load) write-behinds only the delta. `record()` is synchronous — zero hot-path KV latency                                                                                       |

Cost-log flush contract (operator-relevant):

- **Best-effort by design.** A KV error keeps entries in memory (reads stay
  correct) and the watermark does not advance, so the next flush retries the
  whole delta. A crash between flushes loses **at most the last few seconds** —
  never the whole history.
- **Graceful shutdown flushes the tail.** `SIGTERM`/`SIGINT` →
  `gracefulShutdown` in `apps/api/src/index.ts` → `app.close()` → the
  `onClose` hook in `server.ts` calls `costLogStore.close()` (bounded to 2 s so
  a KV hang cannot stall process exit). A clean deploy loses ~zero; an unclean
  kill (e.g. the `node --watch` dev runner on Windows force-kills) stays within
  the documented few-seconds window.
- **Flush observability.** See the `costLog` block + `costlog_flush` probe in
  §1.
- Known residual: a flush straddling midnight whose _second_ day-write fails
  can double-count that flush's tail on retry — astronomically rare, accepted
  over data loss.

### Retention is a value in code, not a paragraph

`RETENTION` in `packages/contracts/src/shared/retention.ts` is the one place the
three policies below are written down; each store imports its own entry instead of
holding a literal, and `apps/api/tests/lib/retention.test.ts` holds each policy to
the store that implements it.

| Data           | Kept                            | Enforced by                                                                                    |
| -------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| Request traces | newest **1000**, oldest evicted | `MAX_TRACES` from `RETENTION.traces`; the JSONL backing compacts at twice the cap              |
| Notifications  | **30 days**                     | `RETENTION.notifications.ttlMs` stamped on `notif:item:*` _and_ on the `notif:list:*` index    |
| Audit log      | **forever** — no time, no count | `audit_log_no_delete` / `audit_log_no_update` triggers, and `audit_log` is absent from erasure |

Two of those are the sort of thing an incident review asks about, so the reasoning
is written beside the values: traces are for debugging the last few days and the
ten-thousandth-oldest span is not read; a notification expires once the user has had
a fair chance to see it, and the index carries the same expiry so it cannot point at
an item that is gone; and the audit log is evidence, so nothing removes an entry on a
schedule — not even an erasure request, which is itself an audit entry. A rule test
(`scripts/retention-policy.test.mjs`) fails if a second copy of any of these numbers
appears anywhere, or if any code path learns to delete from `audit_log`.

### Migrations only go forward

A migration that drops a column is not wrong in the abstract — it is wrong at a
particular moment: while the previous release is still serving requests, selecting
that column. The order is always **add → deploy → backfill → (a later release) drop**.

| Layer                                             | What it stops                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/migrations-forward-only.mjs`             | A `DROP TABLE/COLUMN/TYPE`, `TRUNCATE`, `DELETE FROM` or `RENAME` in any shipped migration, unless `.github/migration-exceptions.json` names it with a reason and an ADR that exists. Comments are stripped first — three migrations mention `DELETE FROM` in a cleanup hint, and a hint is not a statement. |
| `apps/api/tests/lib/migrate-forward-only.test.ts` | Applies every migration but the newest to an embedded Postgres, writes rows in the shape the _older_ code wrote, then applies the newest. The newest migration here (0022) backfills the memory owner, so the test holds both legacy spellings to it.                                                        |
| `migrate.yml / forward-only`                      | The same drill on a real `postgres:16` service against the previous release tag (`git archive`), failing if a column the old code reads is gone or a seeded row did not make it. Runs on pull requests, needs no production secret.                                                                          |

A rewrite worth a look rather than a failure — `ALTER COLUMN … TYPE` — is reported as
a warning with its migration name, because it may run and may lose precision, and a
rule that guessed would either cry wolf or miss the next real drop.

---

## 5. `make verify` — local green means CI green

`make verify` runs every gate a pull request runs, in CI's order, from
`scripts/verify.mjs`. Each line names the workflow job it mirrors, and the
script reads `.github/workflows/*.yml` to list any CI step no gate covers — so a
workflow that gains a step shows up as a reported gap instead of drifting.

| Gate                                                                              | Mirrors                                        |
| --------------------------------------------------------------------------------- | ---------------------------------------------- |
| `pnpm lint`, `node --test scripts/lint-targets.test.mjs`, `pnpm format:check`     | `lint.yml` / lint                              |
| `pnpm check:headers`, `check:docs`, `check:release`                               | `lint.yml` / hygiene                           |
| `pnpm baseline:check`                                                             | `lint.yml` / baseline                          |
| `pnpm openapi:check`, `types:check`                                               | `test.yml` / contracts                         |
| `pnpm typecheck`, `pnpm test`                                                     | `test.yml` / unit                              |
| `pnpm cli:parity`                                                                 | `lint.yml` / lint (through `scripts/lint.mjs`) |
| `node --test scripts/lockfile-drift.test.mjs`                                     | `lint.yml` / lint                              |
| `node --test scripts/{workflow-map,release-triggers,ci-cache,job-times}.test.mjs` | `lint.yml` / lint                              |

### Caches and wall times

Every job that installs dependencies opts into the package-manager cache
(`setup-vp` with `cache: true`, or `setup-node` with `cache: pnpm`), and every job
that runs a turbo task restores `.turbo/cache` keyed on `pnpm-lock.yaml`. Both are
asserted by `scripts/ci-cache.test.mjs`, including a canary test that the turbo
detection matches at least two real jobs — a pattern that matches nothing would
make the other two assertions pass for the wrong reason.

Those jobs also report their wall time through `scripts/job-times.mjs` at the end:
the number lands in the run summary (`| build | 420s vs 400s baseline |`) and is
compared with `.github/job-times.json`. Over 25% slower than the baseline fails
the build. That file is deliberately empty (`{}`) until a real runner produces a
first number — `node scripts/job-times.mjs --record` is how one is filled in, and
a job with no baseline is recorded, not judged.

`pnpm-lock.yaml` and the `package.json` files move together, enforced by
`scripts/lockfile-drift.mjs` in the lint job on every pull request: a lockfile
change with no manifest change fails (a hand-edited or hand-merged lockfile),
and a manifest change with no lockfile change fails too (the next
`pnpm install --frozen-lockfile` would break for whoever clones). Locally it
needs a base to diff against — `node scripts/lockfile-drift.mjs --base origin/master`
— and says "nothing checked" rather than passing quietly when it has none.

`make verify-fast` skips `build`, `typecheck` and the full suite (~4 minutes) for
the loop between commits; `node scripts/verify.mjs --gaps` prints any CI step no
gate covers without running anything.

Four CI jobs cannot run from a developer machine and are printed as skips with
their reason rather than passed silently: the xvfb-driven desktop e2e job, the
Postgres-service jobs (extensions and concurrent migration), the Electron/browser
install steps, and anything needing a Docker daemon. Those are `needs-verify` on
a pull request — the image builds in `build.yml` in particular.

---

## 6. Security tooling is installed, not committed

Nothing in this repository ships a security scanner binary. `.nexus/` is ignored
scratch space, and the hand-built `gitleaks.exe`/`actionlint.exe` that used to sit
in `.nexus/bin` were never referenced by a script, a hook or a workflow — CI runs
both checks from actions, so the copies only added a way to run a different
version than the one that judges a pull request. They have been deleted.

| Check                 | Where it runs                                                                              | Version          | Run it locally                                                  |
| --------------------- | ------------------------------------------------------------------------------------------ | ---------------- | --------------------------------------------------------------- |
| Secret scan           | `security.yml` → `gitleaks/gitleaks-action@v3`, `--all --no-merges --first-parent`         | the action's pin | `gitleaks git --no-merges --first-parent` with the same release |
| Dependency advisories | `security.yml` → `node scripts/audit-gate.mjs` (prod in the required job, dev as a signal) | the lockfile     | `node scripts/audit-gate.mjs --prod`                            |
| Dependency licences   | `lint.yml` → `node scripts/license-audit.mjs` (rules, floors and NOTICE in one pass)       | the lockfile     | `node scripts/license-audit.mjs`                                |
| Image/CVE scan        | `security.yml` → Trivy                                                                     | the action's pin | `trivy fs .`                                                    |

Workflow YAML is **not** linted today: no CI job runs actionlint, so the local
`actionlint.exe` was checking a file set nothing else checked and could not
match CI by construction. Adding that job is tracked in `plan.md` (M2.1).

Advisory severity: `scripts/audit-gate.mjs` runs `pnpm audit --json` and blocks on
high and critical only — moderate and below are printed by neither gate, because a
warning nobody acts on teaches people to ignore the check. A high that genuinely
cannot be fixed yet is added to `.github/audit-allowlist.json` with a `reason` and
an `expires` date; the gate fails once that date passes, so "temporarily accepted"
decays into "fixed" rather than into "forgotten". An entry that no longer matches an
advisory is reported (the fix landed) and does not fail the build. **The allowlist
is empty today**: 0 high or critical advisories in either tree, on a lockfile with
1,819 dependencies.

If you install gitleaks yourself, pin the release in your shell history or a
wrapper outside the repo; a binary checked into the tree silently drifts from the
version CI enforces.

### Actions are pinned to a commit SHA

A tag is a movable pointer: `actions/checkout@v7` is whatever that repository
pushes to `v7` next, and a workflow step runs with the token's permissions. Every
`uses:` in `.github/workflows/` therefore names a 40-character commit SHA and keeps
the tag in a trailing comment, so the pin is reproducible and still readable:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
```

`scripts/actions-pinned.test.mjs` (lint job and `make verify`) fails on a floating
tag **and** on a SHA with no tag comment — reproducible but unreadable is not the
goal. Local actions (`./path`) and `docker://image:tag` refs are exempt.

Dependabot's `github-actions` ecosystem in `.github/dependabot.yml` updates these
pins in place: it reads the trailing comment and rewrites both the SHA and the tag.
To move a pin by hand, take the commit for the tag rather than the tag object:

```bash
git ls-remote --tags https://github.com/actions/checkout 'refs/tags/v7^{}'
```

### Every dependency's licence is measured, not assumed

`scripts/license-audit.mjs` walks the **installed** tree — pnpm puts a package's
resolved dependencies beside it, so the walk sees the versions on disk, not the
ranges in a manifest — and classifies every licence it finds: 1018 packages in the
production closure, 908 more reachable only through dev edges, and 25 Go modules.
Licence text is read from the package itself: the `license` field, then `licenses`,
then a `LICENSE`/`LICENCE`/`COPYING` file, which is how a package that declares
nothing (`khroma`) still resolves without a human.

| What it finds                                      | What happens                                           |
| -------------------------------------------------- | ------------------------------------------------------ |
| MIT, ISC, Apache-2.0, BSD, 0BSD, Unlicense, OFL    | nothing to do; the copyright text ships in the package |
| MPL-2.0, EPL-2.0, LGPL, CDDL — file/link copyleft  | allowed, listed in `NOTICE`                            |
| GPL, AGPL, SSPL, OSL, EUPL, BUSL — strong copyleft | **fails** unless an exception names an ADR that exists |
| nothing declared, or an unreadable expression      | **fails** unless an exception records the decision     |
| a module it could not read                         | reported as a note, never counted as clean             |

`MIT OR GPL-3.0-or-later` passes: a dual grant is a choice, and we take the
permissive one. `Apache-2.0 AND LGPL-3.0-or-later` is weak copyleft, because both
apply. Entries live in `.github/license-exceptions.json`; an entry that no longer
matches an installed package is reported, so an acceptance cannot outlive the
dependency that needed it. Two are there today: `@giscus/react`, which declares no
licence in the tarball but is MIT upstream, and `@splinetool/runtime`, which has no
grant anywhere — ADR [0019](adr/0019-transitive-dependency-without-a-licence.md)
keeps it installed but out of the build.

`NOTICE` carries a generated block listing every weak-copyleft and accepted package.
The audit compares that block to the tree on every run, so a dependency cannot ship
unattributed: `node scripts/license-audit.mjs --write` regenerates it. Platform
binaries (`lightningcss-win32-x64-msvc`, `@img/sharp-linux-x64`) are attributed once
as `<platform>`, so a laptop and a Linux runner produce the same file.

The audit needs the installed tree; a Go module it cannot read (no toolchain, cold
cache) is printed as a note rather than a pass — build the service once and re-run.

---

## 7. What each workflow prevents

Fourteen workflows is a lot of surface for one maintainer, so each row states the
failure it exists to prevent. The list is checked against `.github/workflows/`
by `scripts/workflow-map.test.mjs` (run in the lint job and in `make verify`):
a workflow with no row fails, and so does a row with no workflow.

| Workflow                   | Trigger                     | Failure it prevents                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lint.yml`                 | PR, push                    | A change that type-checks but breaks a rule the reviewer would have caught; a licence header missing from a new file; a documented env var that no longer exists; a stale baseline in `docs/STATUS.md`.                                                                                                                                                                                                                     |
| `test.yml`                 | PR, push                    | Anything green in the editor and red on another machine: unit suites per app, the desktop e2e run under xvfb, migrations against a real Postgres, the browser-extension and Python suites, a spec that disagrees with the contracts package, and — in the `seeded` job — a suite that passes twice only by luck (the same shuffle seed twice, compared test by test).                                                       |
| `build.yml`                | PR, push                    | A build that only works on the author's platform or Node version — matrix over Node 24/26 on ubuntu and macos, then `pnpm typecheck`.                                                                                                                                                                                                                                                                                       |
| `security.yml`             | push, PR, weekly            | A secret in a commit (gitleaks over full history), a high or critical advisory in the dependency trees (`scripts/audit-gate.mjs`, with an allowlist whose entries carry an expiry date), a CVE in an image (Trivy).                                                                                                                                                                                                         |
| `codeql.yml`               | weekly, dispatch            | A taint path nobody wrote a test for: CodeQL's semantic analysis, which no unit test covers.                                                                                                                                                                                                                                                                                                                                |
| `docker.yml`               | push, PR                    | A Dockerfile that builds locally and not from a clean checkout: every service image plus the sandbox image, then a compose smoke test that curls `/health`, with a PR-only smoke job.                                                                                                                                                                                                                                       |
| `release.yml`              | push to `master`, `v*` tags | A release assembled by hand or shipped by accident: on `master` a push only opens the version PR, and on a `v*` tag the `publish` job writes the `latest` dist-tag after checking the tag is on master, `docker-release` builds and signs images tagged with the release name, and desktop installers plus the signed update feed are produced.                                                                             |
| `npm-publish.yml`          | dispatch                    | An unreleased version reaching `npm i`: it reinstalls from the lockfile, builds, runs the `packages/*` suites, publishes under the `next` dist-tag only, and notifies afterwards so a bad preview is visible.                                                                                                                                                                                                               |
| `migrate.yml`              | push, dispatch, PR          | Migrations applied ad hoc: it refuses to run without `DATABASE_URL`, runs `drizzle-kit check` (drift between schema and migrations), then `db:migrate`, never cancelling an in-flight run. On a pull request the `forward-only` job runs the reverse test on a throwaway `postgres:16`: previous release's schema, rows in the old shape, then this release's migrations — a column the old code reads must still be there. |
| `conventional-commits.yml` | PR                          | A commit history that cannot generate a changelog, caught at the PR instead of at release time.                                                                                                                                                                                                                                                                                                                             |
| `dependabot-automerge.yml` | PR (dependabot)             | A patch sitting unmerged for weeks, or a major merging unattended: security fixes merge once required checks pass, majors wait for a person.                                                                                                                                                                                                                                                                                |
| `k6.yml`                   | nightly, dispatch           | A latency or error-rate regression that no functional test sees: nightly load against the deployed service.                                                                                                                                                                                                                                                                                                                 |
| `keep-warm.yml`            | every 10 min, 00–18 UTC     | A free-tier instance that sleeps and then takes a minute to answer the first request.                                                                                                                                                                                                                                                                                                                                       |
| `ingest-finscrape.yml`     | every 30 min                | Signals piling up unread in the ingest service's directory: it calls `/scan` and forwards them to the ingest API.                                                                                                                                                                                                                                                                                                           |

Two pairs overlap and are kept on purpose, because the trigger is the difference:
`docker.yml` validates every image on a PR while `release.yml`'s `docker-release`
builds and signs the ones that ship, and `npm-publish.yml` publishes on demand
while `release.yml` publishes through changesets on `master`. Both matrices list
the service images in two places, so an image added to one and not the other is
the drift to watch (tracked in `plan.md` M2.1).

The tag-trigger defect this table exposed — `release.yml` fired on `v*` tags while its publish and image jobs were gated on `refs/heads/master`, so a tag built installers and shipped no packages or images — is fixed: `version-pr` runs on master and publishes nothing, `publish` and `docker-release` run on tags. `scripts/release-triggers.test.mjs` holds the split in place (one writer of `latest`, preview always on `next`, images tagged with the release name).

---

## 7a. Seeded determinism

`scripts/seed-determinism.mjs` runs the suite twice with the same shuffle seed
(`--sequence.shuffle --sequence.seed=<seed>`, default 1337) and compares every
test's status between the runs. Same seed means the same order, so a difference
cannot be shuffle noise: it is wall-clock time, `Math.random`, a shared temp file,
or state one test left for another. It exits 1 and prints each test with both
statuses; a test that appears in only one run counts as a difference too, and a
run that reports no tests is a failure rather than a pass.

```bash
node scripts/seed-determinism.mjs                          # whole suite, ~2× the suite
node scripts/seed-determinism.mjs --seed 7 --scope packages/llm
```

The `seeded` job in `test.yml` runs it, and `make verify` has the same gate
(skipped by `--fast`, along with `build`, `typecheck` and `test`).

## 8. Branch protection on `master`

Merge gate as of **2026-11-24** (`gh api repos/:owner/:repo/branches/master/protection`):

| Setting                             | Value                                                                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Required checks (9)                 | `Unit tests (Node 24)`, `Unit tests (Node 26)`, `ESLint + Prettier`, `Build (26 / ubuntu-latest)`, `Build api`, `Browser E2E (offline, isolated)`, `App package suites`, `Python tests (nexus-ingest)`, `Production dependency advisories` |
| Strict (branch must be up to date)  | off — `strict: false`                                                                                                                                                                                                                      |
| Enforce on admins                   | off                                                                                                                                                                                                                                        |
| Force pushes / deletions            | blocked                                                                                                                                                                                                                                    |
| Required signatures, linear history | off                                                                                                                                                                                                                                        |

All three named in `plan.md` are there: `test.yml` (unit, app suites, browser e2e,
python), `lint.yml` (ESLint + Prettier) and `build.yml` (Build 26 / ubuntu-latest).
The snapshot lives in `.github/required-checks.json` and is refreshed with
`node scripts/required-checks.mjs --fetch`.

**A required check that no job reports blocks every pull request forever, and
says nothing about why.** That is not hypothetical here: the required context
`Production dependency advisories` matched no job name — the job was called
`Dependency advisories`, and renaming a job is all it takes. The job now carries
the exact required name (the audit it runs is the prod one), the dev-tree audit
moved to a `Dev dependency advisories` job that is a signal rather than a gate,
and `scripts/required-checks.mjs` compares the snapshot with the names the
workflows actually produce — expanding matrices the way Actions does — so the two
cannot drift apart silently.

Two jobs that are _not_ required but probably should be: `Concurrent migrations
(Postgres)` and `E2E — signal pipeline`. Both need service containers and are slow,
and adding them is an administrative change on GitHub rather than a code change.

---

## 9. Quick references

- Store ownership + design notes: STATUS.md pass 4–9 sections.
- KV/queue infra and deployment: `docs/DEPLOYMENT.md`, `docs/runbook.md`.
- Test tiers that exercise these surfaces: `docs/TESTING.md`.
- Local env: `cp .env.example .env` (see §3 for the KV backend variables).
- Drills, in the order they cost you time: `scripts/db-backup-drill.sh` (needs a scratch
  database), `scripts/db-forward-only-drill.sh` (needs a disposable Postgres), the rotation
  drill in `docs/runbook.md` §11 (needs a provider console). Their guards —
  `scripts/backup-drill.test.mjs`, `scripts/migrations-forward-only.test.mjs`,
  `scripts/rotation-drill.test.mjs` — run in `make verify` and keep the procedures pointing
  at things that exist.

### Pre-release dependencies, and the job that covers the compiler

A release candidate is a schedule problem, not a licence problem: it can change its API
without a semver major, and a lockfile keeps the old build green. Four are installed and
`.github/prerelease-policy.json` records who owns each one, why a stable release does not
work, and what ends the exception. `scripts/prerelease-audit.mjs` reads every manifest
_and_ the `catalog:` block — where most versions actually live — and fails on an
unrecorded pre-release, a policy entry that drifted from the tree, an entry missing its
owner/reason/exit, or an ADR that does not exist. ADR
[0020](adr/0020-release-candidates-in-the-persistence-layer.md) is the decision; the table
below is generated from it.

The compiler is the same problem one level up. `typescript` resolves to
`npm:@typescript/typescript6` (a preview channel) because the tools that import the
compiler API need the 6.0 API, while `@typescript/native` provides `tsc` at 7. A
construct that only the preview accepts would ship and then fail for whoever is on stable
6.x, so `build.yml`'s **`typescript-stable`** job installs the latest published stable
TypeScript 6 and compiles the whole tree with it. That job is the condition for keeping
the alias: it is deleted when the alias is.

Linting keeps one type-aware path for the same reason — `vp lint --type-aware` owns every
rule, and `eslint` is limited to `import-x/order`, which needs no types.
`scripts/lint-paths.test.mjs` fails if a second rule appears in the ESLint config or a
second type-aware invocation appears in `scripts/lint.mjs`.

<!-- begin:prerelease table (scripts/prerelease-audit.mjs) -->

| Package                | Version         | Why it is installed                                                                                                                                                                  | Owner | Exit                                                                                                                                          | ADR                                                                                                            |
| ---------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `@monaco-editor/react` | `4.8.0-rc.3`    | 4.7 does not lift Monaco out of the server-rendered bundle; the RC is the release that made the editor import-safe, and the code editor is unusable without it.                      | ui    | Move to 4.8.x stable when published; the only API used is `<Editor>` with `onMount`, so the swap is a version bump plus one screenshot.       | [0020-release-candidates-in-the-persistence-layer.md](adr/0020-release-candidates-in-the-persistence-layer.md) |
| `drizzle-kit`          | `1.0.0-rc.6`    | Must match drizzle-orm exactly; a generator from a different line emits migrations the runtime cannot read.                                                                          | db    | Same commit as drizzle-orm: GA, then regenerate every migration once and confirm `migrations-forward-only.mjs` still passes.                  | [0020-release-candidates-in-the-persistence-layer.md](adr/0020-release-candidates-in-the-persistence-layer.md) |
| `drizzle-orm`          | `1.0.0-rc.6`    | The only release line that ships the typed relational queries and migration splitter this repository is written against; 0.44 is a different API, not a smaller version of this one. | db    | Migrate when 1.0.0 is GA: bump the catalog, hand-run `migrate-forward-only.test.ts` and `migrations-forward-only.mjs`, and delete this entry. | [0020-release-candidates-in-the-persistence-layer.md](adr/0020-release-candidates-in-the-persistence-layer.md) |
| `node-pty`             | `1.2.0-beta.15` | 1.1 has no Node 26 prebuild, so it compiles native code on every install; the beta ships the prebuilt binary the terminal needs.                                                     | pty   | 1.2.0 stable, or 1.1 gaining a Node 26 prebuild — either removes the beta and the build step.                                                 | [0020-release-candidates-in-the-persistence-layer.md](adr/0020-release-candidates-in-the-persistence-layer.md) |

<!-- end:prerelease table -->

---

## 10. Performance budgets — measured numbers, and what fails on regression

Four workloads are measured, recorded, and enforced. The numbers below are the baseline in
`.github/perf-baseline.json`; a run more than 25 % slower than the baseline fails
`scripts/perf-budget.mjs`, and CI's `budgets` job (`.github/workflows/build.yml`) prints the
table in the step summary of every build.

| Workload | Baseline | What it covers |
| --- | --- | --- |
| `buildCold` | 12 356 ms | `pnpm build` with every `tsbuildinfo` removed — the wall time a fresh clone pays. |
| `buildWarm` | 627 ms | The same build with the incremental state in place — what a second local run costs. |
| `uiDev` | 8 900 ms | `vite` answering its first HTTP 200 — how long a contributor waits for a page. |
| `apiBoot` | 5 837 ms | Import of `apps/api/src/server.ts` to a served `/health` — cold start for a replica. |
| `test` | recorded per host | `turbo run test` across the workspace. |

The host is part of the record: `win32-13th Gen Intel(R) Core(TM) i7-13650HX-20c-24gb`. A run
on a different host is reported but not compared, because two machines are two baselines and a
comparison between them measures the machine. Re-record on the machine you intend to trust:

```bash
node scripts/perf-budget.mjs --record          # every workload
node scripts/perf-budget.mjs --only uiDev,apiBoot --record
```

Two size budgets sit beside it:

- **UI bundle**, per route (`scripts/bundle-budget.mjs`, `.github/bundle-budget.json`): every
  built route is attributed through Vite's `manifest`, gzipped, and checked against a
  per-route budget with 1.1× headroom over what it was when the budget was set; the default
  for a route without its own entry is 200 kB gzipped. `three.module` is forbidden outside the
  routes that legitimately own a 3D view, which is how the landing scene and the knowledge
  graph stay behind `React.lazy`.
- **API boot**, two numbers (`scripts/api-boot-budget.mjs`, `.github/boot-budget.json`):
  9 000 ms to a served `/health`, and 450 registered route lines. The route count is the
  early-warning half: boot time is noisy, the number of routes is not, and a registration that
  adds forty routes is a cold-start regression before it is a slow one.

A budget that fails is a question, not a verdict: either the change is slower and should be
made faster, or the baseline is stale and should be re-recorded **in the same commit** as the
change with a note saying why.
