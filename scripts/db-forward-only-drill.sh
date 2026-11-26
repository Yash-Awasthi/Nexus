#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Apply this release's migrations to a database that is already running the previous
# release's schema, with rows in it, and fail if anything the old code reads is gone.
#
# The local equivalent — same idea, embedded Postgres — is
# apps/api/tests/lib/migrate-forward-only.test.ts. This one uses a real server so the
# CI check exercises the real parser, the real locks and a real deploy-shaped DB.
#
#   DATABASE_URL=postgres://… PREV_REF=v1.2.3 scripts/db-forward-only-drill.sh
#
# PREV_REF is the previous release tag. Without it (a first release, or a shallow
# clone) the drill falls back to "every migration except the newest", which still
# checks the interesting direction: the newest migration against older rows.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
MIGRATIONS="${MIGRATIONS:-packages/db/migrations}"
PREV_REF="${PREV_REF:-}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
started=$(date +%s)

psql_run() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q "$@"; }

apply_dir() {
  local dir="$1" label="$2" applied=0
  for migration in "$dir"/*/; do
    [ -f "${migration}migration.sql" ] || continue
    psql_run -f "${migration}migration.sql"
    applied=$((applied + 1))
  done
  echo "applied $applied migration(s) from $label"
}

# ── The previous release's schema ─────────────────────────────────────────────
if [ -n "$PREV_REF" ] && git rev-parse --verify --quiet "$PREV_REF^{commit}" >/dev/null; then
  git archive "$PREV_REF" "$MIGRATIONS" | tar -x -C "$work"
  prev="$work/$MIGRATIONS"
  echo "previous release: $PREV_REF ($(find "$prev" -name migration.sql | wc -l | tr -d ' ') migrations)"
else
  [ -n "$PREV_REF" ] && echo "! $PREV_REF is not in this clone — falling back to all but the newest migration"
  prev="$work/prev"
  mkdir -p "$prev"
  newest="$(find "$MIGRATIONS" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)"
  for migration in "$MIGRATIONS"/*/; do
    [ "$(cd "$migration" && pwd)" = "$(cd "$newest" && pwd)" ] && continue
    cp -R "$migration" "$prev/"
  done
  echo "previous schema: every migration except $(basename "$newest")"
fi

apply_dir "$prev" "the previous release"

# ── Data the older code wrote ─────────────────────────────────────────────────
# Rows in the shape the *old* release wrote them, so a migration is tested against
# history rather than against an empty table.
psql_run -c "INSERT INTO users (email, password_hash) VALUES ('forward-only@example.test', 'x')" ||
  echo "! users table absent — skipping the seeded row"

psql_run <<'SQL' || echo "! memory_entries absent — skipping the legacy rows"
INSERT INTO memory_entries (id, text, embedding, metadata, created_at, user_id)
VALUES ('drill-metadata', 'owner in metadata only', array_fill(0.01::real, ARRAY[768])::vector, '{"userId":"u-1"}', 1, NULL),
       ('drill-user-id', 'owner in user_id only', array_fill(0.01::real, ARRAY[768])::vector, '{}', 2, 'u-2');
SQL

# ── This release's migrations ─────────────────────────────────────────────────
before="$work/columns.before"
psql_run -At -c "SELECT table_name || '.' || column_name FROM information_schema.columns
                  WHERE table_schema = 'public' ORDER BY 1" >"$before"

for migration in "$MIGRATIONS"/*/; do
  name="$(basename "$migration")"
  [ -d "$prev/$name" ] && continue
  [ -f "${migration}migration.sql" ] || continue
  echo "→ $name"
  psql_run -f "${migration}migration.sql"
done

after="$work/columns.after"
psql_run -At -c "SELECT table_name || '.' || column_name FROM information_schema.columns
                  WHERE table_schema = 'public' ORDER BY 1" >"$after"

# ── The verdict ───────────────────────────────────────────────────────────────
removed="$(comm -23 <(sort "$before") <(sort "$after"))"
if [ -n "$removed" ]; then
  echo "✖ the new migrations removed columns the previous release reads:" >&2
  echo "$removed" >&2
  echo "  migrations only go forward: add, deploy, backfill, then drop in a later release" >&2
  exit 1
fi

rows="$(psql_run -At -c "SELECT count(*) FROM users WHERE email = 'forward-only@example.test'")"
[ "$rows" = "1" ] || {
  echo "✖ the seeded user row did not survive the migration" >&2
  exit 1
}

owned="$(psql_run -At -c "SELECT count(*) FROM memory_entries
                           WHERE (user_id IS NOT NULL)::int +
                                 ((metadata ? 'userId')::int) = 2" 2>/dev/null || echo "n/a")"
echo "owner rows carrying both spellings after the migration: $owned"

elapsed=$(( $(date +%s) - started ))
echo "✔ forward-only drill passed in ${elapsed}s ($(find "$after" -type f | wc -l | tr -d ' ') files checked)"
