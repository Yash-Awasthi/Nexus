// SPDX-License-Identifier: Apache-2.0
/**
 * Migrations only go forward.
 *
 * A migration that drops a column is not a mistake in the abstract — it is a mistake
 * at a particular moment: the moment it is applied while the previous release is
 * still serving requests, where old code still selects that column and new code
 * expects data that is now gone. The safe order is always add → deploy → backfill →
 * (later, separately) drop.
 *
 * So this fails a migration that removes something, unless
 * `.github/migration-exceptions.json` names it and points at an ADR that exists.
 * Comments are stripped first: three migrations in this repo mention `DELETE FROM` in
 * a cleanup hint, and a hint is not a statement.
 *
 * What it cannot check is whether the migration *runs* against the previous schema —
 * `apps/api/tests/lib/migrate-forward-only.test.ts` does that on an embedded Postgres
 * and `migrate.yml`'s forward-only job does it on a real one.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MIGRATIONS = "packages/db/migrations";
const EXCEPTIONS = ".github/migration-exceptions.json";

/** Removals and rewrites, which break a reader that only knows the older shape. */
const DESTRUCTIVE = [
  ["drop table", /\bDROP\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW|SCHEMA|TYPE|SEQUENCE)\b/i],
  ["drop column", /\bDROP\s+COLUMN\b/i],
  ["truncate", /\bTRUNCATE\b/i],
  ["delete", /\bDELETE\s+FROM\b/i],
  ["rename", /\bRENAME\s+(?:TO|COLUMN)\b/i],
];

/** Worth a look, not worth failing: the statement may run, and may lose precision. */
const SUSPICIOUS = [["type change", /\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i]];

/** Strip line comments and block comments so prose is not mistaken for SQL. */
export function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/--[^\r\n]*/g, ""))
    .join("\n");
}

/** Split into statements at `;` — good enough for migration DDL, which has no dollar-quoting tricks in this repo. */
export function statements(sql) {
  return stripComments(sql)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Every migration folder, oldest first, with the SQL that will run. */
export function migrations(dir = MIGRATIONS) {
  return readdirSync(dir)
    .filter((name) => existsSync(path.join(dir, name, "migration.sql")))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(path.join(dir, name, "migration.sql"), "utf8"),
    }));
}

function exceptions(file = EXCEPTIONS) {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  return entries.map((entry) => {
    const problems = [];
    if (!entry.migration) problems.push("no migration");
    if (!entry.match) problems.push("no match snippet");
    if (!entry.reason) problems.push("no reason");
    if (!entry.adr || !existsSync(path.join("docs/adr", path.basename(entry.adr))))
      problems.push(`adr ${JSON.stringify(entry.adr)} does not name an existing file`);
    return { ...entry, problems };
  });
}

/** Every destructive statement in the tree, with whether an exception covers it. */
export function audit(dir = MIGRATIONS, exceptionFile = EXCEPTIONS) {
  const permitted = exceptions(exceptionFile);
  const found = [];
  for (const migration of migrations(dir)) {
    for (const statement of statements(migration.sql)) {
      const flat = statement.replace(/\s+/g, " ");
      for (const [rule, pattern] of DESTRUCTIVE) {
        if (!pattern.test(flat)) continue;
        const cover = permitted.find(
          (entry) =>
            entry.problems.length === 0 &&
            migration.name.includes(entry.migration) &&
            flat.includes(entry.match),
        );
        found.push({ migration: migration.name, rule, statement: flat, permitted: cover ?? null });
      }
      for (const [rule, pattern] of SUSPICIOUS) {
        if (!pattern.test(flat)) continue;
        found.push({
          migration: migration.name,
          rule,
          statement: flat,
          suspect: true,
          permitted: null,
        });
      }
    }
  }
  return {
    found,
    stale: permitted.filter((entry) => !found.some((hit) => hit.permitted === entry)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { found, stale } = audit();
  const failures = found.filter((hit) => !hit.permitted && !hit.suspect);
  const suspects = found.filter((hit) => hit.suspect);
  for (const hit of failures)
    console.error(
      `✖ ${hit.migration}: ${hit.rule} — ${hit.statement.slice(0, 120)}\n  migrations only go forward: add, deploy, backfill, then drop in a later release — or record the decision in ${EXCEPTIONS}`,
    );
  for (const hit of suspects)
    console.warn(`! ${hit.migration}: ${hit.rule} — check that the rewrite survives old data`);
  for (const entry of stale)
    console.warn(`! ${EXCEPTIONS}: entry for ${entry.migration} matches no statement — remove it`);
  const count = migrations().length;
  console.log(
    `migration discipline: ${count} migration(s), ${found.length} removal(s), ${failures.length} unpermitted`,
  );
  if (failures.length > 0) process.exit(1);
}
