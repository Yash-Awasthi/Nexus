<!-- verified: 8065a84 2026-11-25 -->

# Upgrade policy

What a release promises somebody running the previous one: what the database will accept, how long an API route
keeps working after it is deprecated, and what to do if the new version is worse than the old one. Each promise is
enforced by something in the tree, not by good intentions.

## 1. The schema only goes forward, and only in additive steps

A migration that drops a column is not wrong in the abstract — it is wrong **while the previous release is still
serving requests**, selecting that column. The order is always:

```
add  →  deploy the code that writes both  →  backfill  →  a LATER release drops the old thing
```

| Enforced by                                       | What it refuses                                                                                                                                                              |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/migrations-forward-only.mjs`             | `DROP TABLE/COLUMN/TYPE`, `TRUNCATE`, `DELETE FROM`, `RENAME` in any shipped migration unless `.github/migration-exceptions.json` names it with a reason and an existing ADR |
| `apps/api/tests/lib/migrate-forward-only.test.ts` | Proves it on an embedded Postgres: every migration but the newest is applied, rows are written in the shape the _older_ code wrote, then the newest migration runs           |
| `.github/workflows/migrate.yml`                   | The same drill against a real `postgres:16` and the previous release tag, failing if a column the old code reads is gone                                                     |
| `scripts/migrations-forward-only.test.mjs`        | The rule itself: a comment mentioning `DELETE` is not a `DELETE`, and an exception with no ADR is not a permit                                                               |

**Rollback of a schema change is therefore not a down-migration.** Going back to the previous release means going
back to code that must still work against the newer schema — which the additive rule guarantees. A migration that
is not additive cannot be rolled back, so it does not ship.

## 2. An API route gets one minor of deprecation before it goes

| Stage                | What the caller sees                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deprecation**      | The response carries `Deprecation: true` and a `Sunset: <date>` header; `docs/openai-v1-transcript.md` and the OpenAPI document mark it deprecated |
| **One minor later**  | The route returns `410 Gone` with the replacement named in the body, never a silent `404`                                                          |
| **Two minors later** | The route is removed                                                                                                                               |

Enforced by `apps/api/tests/lib/api-deprecation.test.ts`: it reads the maturity table (`lib/api-maturity.ts`) and
fails when a surface marked `deprecated` has no `Sunset` header wired into its handler, or when a route disappears
without ever having been marked — the second case is what catches "we removed it because nobody seemed to use it".

Removal-only versions are not allowed: `/api/v1` is the stable surface (`docs/adr/0009-versioned-api.md`), and a
breaking change is `/api/v2`, served in parallel.

## 3. Every release states its rollback

Each release note ends with a rollback line, because the time to work out how to undo a deploy is before the deploy:

- **Application-only change** — redeploy the previous tag. Nothing else to undo.
- **Additive migration** — redeploy the previous tag; the new column stays and is ignored by the old code.
- **Changed retention or encryption key material** — the two-deploy procedure in `docs/runbook.md` §11.4, in
  reverse: set `NEXUS_SECRETS_KEY_PREVIOUS` to the newer key, run `rotate-secrets.ts`, drop it.
- **Anything the exceptions file permits** — the ADR named there states the rollback, and the release note repeats
  it; if it does not, the exception is not granted.

`docs/RELEASE-NOTES.md` is generated from the changesets, so this section is where a release note starts, not where
it is edited afterwards.

## 4. What is explicitly not promised

- **Downgrades across a dropped feature.** If a release removes a route after its deprecation window, the previous
  version still works but the data the route created stays. There is no down-migration for it.
- **A rollback that loses writes.** A worker that processed a queue item under the new code cannot be un-processed.
  The promise is about schema and routes, not about replaying side effects.
- **Upgrading across more than one major.** Jumping several majors at once is supported in the sense that migrations
  run in order; it is not supported in the sense that we can predict the result. Go one major at a time.
