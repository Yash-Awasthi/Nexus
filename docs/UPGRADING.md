<!-- verified: 4904f5b 2026-11-26 -->

# Upgrade policy

What a release promises somebody running the previous one: what the database will accept,
how long an API route keeps working after it is deprecated, and what to do if the new
version is worse than the old one. Each promise names the file that enforces it, and the
places where the enforcement is a rule rather than a check are marked as such.

## 1. The schema only goes forward, and only in additive steps

A migration that drops a column is not wrong in the abstract — it is wrong **while the
previous release is still serving requests**, selecting that column. The order is always:

```
add  →  deploy the code that writes both  →  backfill  →  a LATER release drops the old thing
```

| Enforced by                                       | What it refuses                                                                                                                                                                                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/migrations-forward-only.mjs`             | `DROP TABLE/VIEW/MATERIALIZED VIEW/SCHEMA/TYPE/SEQUENCE`, `DROP COLUMN`, `TRUNCATE`, `DELETE FROM` and `RENAME TO/COLUMN` in any shipped migration. Comments are stripped first, so a cleanup hint mentioning `DELETE FROM` is not a statement |
| `scripts/migrations-forward-only.test.mjs`        | The rule itself: comments are not SQL, an exception with no ADR is not a permit, and a stale exception is reported                                                                                                                             |
| `apps/api/tests/lib/migrate-forward-only.test.ts` | Applies every migration but the newest to an embedded Postgres, writes rows in the shape the older code wrote, then applies the newest                                                                                                         |
| `.github/workflows/migrate.yml` / `forward-only`  | The same drill on a real `postgres:16` service against the previous `v*` tag, via `scripts/db-forward-only-drill.sh`; runs on every migration pull request and needs no production secret                                                      |

The script also runs as its own gate in `.github/workflows/lint.yml`
(`node scripts/migrations-forward-only.mjs`) and in `scripts/verify.mjs`, so a destructive
migration fails before the database job is reached. `ALTER COLUMN ... TYPE` is reported as a
warning rather than a failure, because it may run and may lose precision.

**Exceptions.** The permit list is `.github/migration-exceptions.json`. It is **not
present in this tree today**, so the list is empty and every statement in the table above is
refused. An entry, if one is ever added, must name a migration, a statement snippet, a
reason and an existing `docs/adr/` file — the script checks all four
(`scripts/migrations-forward-only.mjs`, `exceptions()`).

Migrations live in `packages/db/migrations/<timestamp>_<name>/migration.sql` and are applied
in folder-name order by drizzle-kit through `pnpm db:migrate`
(`packages/db/README.md` §Migrations). `docs/OPS.md` §4 restates this rule for operators.

**Rollback of a schema change is therefore not a down-migration.** Going back to the
previous release means going back to code that must still work against the newer schema,
which the additive rule guarantees. A migration that is not additive cannot be rolled back,
so it does not ship.

## 2. An API route gets a deprecation window before it goes

Deprecation is decided in one register, `apps/api/src/lib/api-deprecation.ts`:
`DEPRECATED_ROUTES` is a list of `{ method, path, stage, since, sunset, replacement,
reason }`. The module is mounted as a `preHandler` on both API scopes in
`apps/api/src/server.ts` (the `/api/v1` scope and the `/api` scope), so an entry changes
what every caller already sees, without touching the handler:

| Stage                      | What the caller sees                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `deprecated`               | `Deprecation: true`, `Sunset: <HTTP-date>` and `Link: <replacement>; rel="successor-version"`; the route still answers normally |
| `deprecated` past `sunset` | `410` with code `ROUTE_RETIRED`, the replacement and the reason in the body — never a silent `404`                              |
| `gone`                     | The same `410`, immediately                                                                                                     |

Enforced by `apps/api/tests/lib/api-deprecation.test.ts`, which drives the real hook through
Fastify rather than calling the helpers: headers arrive on a deprecated route and no other
route is decorated; a past-sunset entry answers `410` with the replacement; a `gone` entry is
`410` rather than `404`; `:param` matches one segment only; methods are explicit; and the
shipped register is asserted empty today, so the first entry is a decision rather than an
accident.

**The window is recorded, not computed.** `since` and `sunset` are fields an author fills
in; the test asserts that a `deprecated` entry's `sunset` is in the future and that every
entry names a replacement starting with `/api/`. Nothing compares the window to a release
version, so "one minor" (the plan's rule) is a review obligation written here and in
`docs/adr/0009-versioned-api.md` — which states _two_ minors after a replacement — not a
number a script derives.

**Gap:** the deprecation is not in the contract documents. `openapi.yaml` carries no
`deprecated:` field, `apps/api/scripts/generate-openapi.ts` emits none, and route files carry
no marker; `docs/openai-v1-transcript.md` does not mention deprecation either. The only
machine-readable marker today is the register above.

Removal-only versions are not allowed: `/api/v1` is the stable surface
(`docs/adr/0009-versioned-api.md`), and a breaking change is `/api/v2`, served in parallel.
Routes that never moved under `/v1` remain mounted under `/api` in `server.ts`; the register
matches whatever template Fastify reports, so the policy applies to both.

## 3. Every release has a documented rollback

The rollback procedure lives in `docs/runbook.md` §8: Render's **Rollback** button to the
previous deploy (§8.1), `docker compose up -d --build` for compose (§8.2), `pnpm db:migrate`
before the API starts (§8.3), and the five-item checklist in §8.4 — previous image restored,
`/health/ready` passing, queue depth normal, audit chain intact, no schema-mismatch errors in
the logs.

Per change type:

- **Application-only change** — redeploy the previous tag. Nothing else to undo.
- **Additive migration** — redeploy the previous tag; the new column stays and is ignored by
  the old code (the guarantee in §1).
- **Changed retention or encryption key material** — the two-deploy procedure in
  `docs/runbook.md` §11.4, in reverse: set `NEXUS_SECRETS_KEY_PREVIOUS` to the newer key,
  run `apps/api/src/rotate-secrets.ts`, then drop the variable.
- **An exception permitted by the migrations file** — the ADR named there states the
  rollback, and the release note repeats it.

What `.github/workflows/release.yml` actually does: pushes to `master` only open the version
PR; a `v*` tag publishes the packages and images (tagged `:latest` and `:vX.Y.Z`), builds and
signs the desktop installers, and publishes a signed update feed. Nothing in the workflow
writes, reads or verifies a rollback line.

**Gap:** "every release states its rollback" is not gated. `docs/RELEASE-NOTES.md` is the
_pending changeset set_, checked by `pnpm release:notes:check`
(`scripts/sync-release-notes.mjs`), and the published notes come from Changesets changelogs
plus GitHub's `generate_release_notes: true`. So the rollback statement is a review
obligation documented here and in `docs/runbook.md` §8, not a CI-enforced field.

## 4. What is explicitly not promised

- **Downgrades across a dropped feature.** If a release removes a route after its
  deprecation window, the previous version still works but the data the route created stays.
  There is no down-migration for it.
- **A rollback that loses writes.** A worker that processed a queue item under the new code
  cannot be un-processed. The promise is about schema and routes, not about replaying side
  effects.
- **Upgrading across more than one major.** Migrations run in order, so the mechanics work,
  but the result is not predicted. Go one major at a time.
