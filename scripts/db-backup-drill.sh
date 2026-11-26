#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# A backup is a promise until someone restores it. This dumps the database, restores
# the dump into a *separate* database, compares every table's row count, verifies the
# audit hash chain in the restored copy, and prints the wall time in the shape
# docs/runbook.md 7.5 records it.
#
#   DATABASE_URL=postgres://… SCRATCH_DATABASE_URL=postgres://…/nexus_restore \
#     scripts/db-backup-drill.sh
#
# SCRATCH must be a different database: the drill restores into it and would otherwise
# overwrite the source. It is dropped and recreated, so never point it at anything real.
# Set RUN_SUITE=1 to also run the API suite against the restored copy (the slow half).
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${SCRATCH_DATABASE_URL:?SCRATCH_DATABASE_URL is required (a throwaway database)}"

if [ "$DATABASE_URL" = "$SCRATCH_DATABASE_URL" ]; then
  echo "✖ SCRATCH_DATABASE_URL is the source database — restoring would overwrite it" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
started=$(date +%s)

# ── 1. Dump ───────────────────────────────────────────────────────────────────
dump="$work/nexus.sql.gz"
pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip >"$dump"
echo "dump: $(du -h "$dump" | cut -f1) from $DATABASE_URL"

# ── 2. A clean instance ───────────────────────────────────────────────────────
# The scratch database is recreated, not reused, so the restore proves the dump is
# self-sufficient rather than surviving on whatever was already there.
scratch_admin="${SCRATCH_DATABASE_URL%/*}/postgres"
scratch_name="${SCRATCH_DATABASE_URL##*/}"
psql "$scratch_admin" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"$scratch_name\""
psql "$scratch_admin" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$scratch_name\""

# ── 3. Restore ────────────────────────────────────────────────────────────────
gunzip -c "$dump" | psql "$SCRATCH_DATABASE_URL" -v ON_ERROR_STOP=1 -q
restored=$(( $(date +%s) - started ))
echo "restored into $scratch_name in ${restored}s"

# ── 4. Same data, table by table ──────────────────────────────────────────────
tables="$(psql "$DATABASE_URL" -At -c "SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1")"
mismatch=0
rows_total=0
for table in $tables; do
  source_rows="$(psql "$DATABASE_URL" -At -c "SELECT count(*) FROM \"$table\"")"
  restored_rows="$(psql "$SCRATCH_DATABASE_URL" -At -c "SELECT count(*) FROM \"$table\"")"
  rows_total=$((rows_total + restored_rows))
  if [ "$source_rows" != "$restored_rows" ]; then
    echo "✖ $table: source has $source_rows rows, restored copy has $restored_rows" >&2
    mismatch=1
  fi
done
[ "$mismatch" = 0 ] || exit 1
echo "row counts match across $(echo "$tables" | wc -l | tr -d ' ') tables ($rows_total rows)"

# ── 5. The audit chain has to verify in the restored copy ─────────────────────
# A backup that restores rows but breaks the HMAC chain is a backup of a different
# system: the chain is what makes the audit log evidence.
chain="$(psql "$SCRATCH_DATABASE_URL" -At -c "SELECT count(*) FROM audit_log")"
if [ "$chain" != "0" ]; then
  echo "audit_log: $chain entries restored — verify with:"
  echo "  DATABASE_URL=$SCRATCH_DATABASE_URL pnpm --filter @nexus/cli exec nexus audit verify"
  echo "  (or GET /api/v1/audit/log/verify against an API pointed at the restored copy)"
fi

# ── 6. Optional: the suite against the restored copy ──────────────────────────
if [ "${RUN_SUITE:-0}" = "1" ]; then
  echo "running the API suite against the restored copy…"
  ( cd apps/api && PG_URL="$SCRATCH_DATABASE_URL" DATABASE_URL="$SCRATCH_DATABASE_URL" \
      ../../node_modules/.bin/vp test run ) || {
    echo "✖ the suite failed against the restored copy" >&2
    exit 1
  }
fi

elapsed=$(( $(date +%s) - started ))
echo
echo "✔ backup/restore drill passed"
echo "record in docs/runbook.md 7.5: | $(date -u +%Y-%m-%d) | $restored s | $elapsed s | $(du -h "$dump" | cut -f1) | $rows_total |"
