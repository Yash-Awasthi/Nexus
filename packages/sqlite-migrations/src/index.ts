// SPDX-License-Identifier: Apache-2.0
/**
 * sqlite-migrations — Schema versioning for sqlite-store.
 *
 * Provides a MigrationRunner that:
 *   • Tracks applied migrations in a _schema_migrations table
 *   • Runs versioned UP steps in order, skipping already-applied ones
 *   • Offers helpers for safe column addition, constraint repair, index rebuild
 *   • Uses an injectable DbClient so tests never need a real SQLite file
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Migration {
  /** Monotonically increasing integer version (1, 2, 3 …). */
  version: number;
  /** Human-readable name, stored in the migrations table. */
  name: string;
  /** One or more SQL statements to execute. */
  up: string | string[];
  /** Optional rollback SQL (best-effort; not enforced). */
  down?: string | string[];
}

/** Applied migration interface definition. */
export interface AppliedMigration {
  version: number;
  name: string;
  appliedAt: string; // ISO timestamp
}

/** Migration result interface definition. */
export interface MigrationResult {
  version: number;
  name: string;
  status: "applied" | "skipped" | "failed";
  error?: string;
  durationMs: number;
}

/** Run report interface definition. */
export interface RunReport {
  results: MigrationResult[];
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
  totalDurationMs: number;
}

// ── DbClient interface ────────────────────────────────────────────────────────

export interface DbStatement {
  run(...params: unknown[]): void;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  get<T = unknown>(...params: unknown[]): T | undefined;
  all<T = unknown>(...params: unknown[]): T[];
}

/** Db client interface definition. */
export interface DbClient {
  prepare(sql: string): DbStatement;
  exec(sql: string): void;
  /** Execute fn inside a transaction; throw aborts & rolls back. */
  transaction<T>(fn: () => T): T;
  /** Returns list of column names for a table (empty if table missing). */
  tableColumns(table: string): string[];
  /** Returns list of index names for a table. */
  tableIndexes(table: string): string[];
}

// ── InMemoryDbClient — for tests ──────────────────────────────────────────────

type InMemRow = Record<string, unknown>;

/**
 * Minimal in-memory DbClient that understands a tiny subset of SQL:
 *   CREATE TABLE … IF NOT EXISTS
 *   INSERT INTO … VALUES / INSERT OR IGNORE INTO …
 *   SELECT … FROM … WHERE …  (single equality or no WHERE)
 *   ALTER TABLE … ADD COLUMN …
 *   CREATE INDEX … IF NOT EXISTS …
 * Enough to drive MigrationRunner tests without touching disk.
 */
export class InMemoryDbClient implements DbClient {
  private tables = new Map<string, InMemRow[]>();
  private columns = new Map<string, string[]>();
  private indexes = new Map<string, string[]>();
  readonly execLog: string[] = [];

  exec(sql: string): void {
    this.execLog.push(sql.trim());
    this._interpret(sql);
  }

  prepare(sql: string): DbStatement {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      run(...params: unknown[]): void {
        self.execLog.push(`[prepared] ${sql.trim()} params=${JSON.stringify(params)}`);
        self._interpret(sql, params);
      },
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
      get<T>(...params: unknown[]): T | undefined {
        return self._query<T>(sql, params)[0];
      },
      all<T>(...params: unknown[]): T[] {
        return self._query<T>(sql, params);
      },
    };
  }

  transaction<T>(fn: () => T): T {
    return fn();
  }

  tableColumns(table: string): string[] {
    return this.columns.get(table) ?? [];
  }

  tableIndexes(table: string): string[] {
    return this.indexes.get(table) ?? [];
  }

  // ── Internal mini-SQL interpreter ─────────────────────────────────────────

  private _interpret(sql: string, params: unknown[] = []): void {
    const s = sql.trim().replace(/\s+/g, " ");

    // CREATE TABLE [IF NOT EXISTS] name (col1 type, …)
    const createMatch = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(/i.exec(s);
    if (createMatch) {
      const tbl = createMatch[1]!;
      if (!this.tables.has(tbl)) {
        this.tables.set(tbl, []);
        // Parse column names from CREATE TABLE body
        const inner = s.slice(s.indexOf("(") + 1, s.lastIndexOf(")"));
        const cols = inner
          .split(",")
          .map((c) => c.trim().split(/\s+/)[0]!)
          .filter(
            (c) =>
              c &&
              !c.toUpperCase().startsWith("PRIMARY") &&
              !c.toUpperCase().startsWith("UNIQUE") &&
              !c.toUpperCase().startsWith("FOREIGN") &&
              !c.toUpperCase().startsWith("CHECK"),
          );
        this.columns.set(tbl, cols);
      }
      return;
    }

    // ALTER TABLE name ADD COLUMN colname type
    const alterMatch = /ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/i.exec(s);
    if (alterMatch) {
      const tbl = alterMatch[1]!;
      const col = alterMatch[2]!;
      const cols = this.columns.get(tbl) ?? [];
      if (!cols.includes(col)) cols.push(col);
      this.columns.set(tbl, cols);
      if (!this.tables.has(tbl)) this.tables.set(tbl, []);
      return;
    }

    // CREATE INDEX [IF NOT EXISTS] name ON table (…)
    const idxMatch = /CREATE(?:\s+UNIQUE)?\s+INDEX(?:\s+IF NOT EXISTS)?\s+(\w+)\s+ON\s+(\w+)/i.exec(s);
    if (idxMatch) {
      const idxName = idxMatch[1]!;
      const tbl = idxMatch[2]!;
      const idxList = this.indexes.get(tbl) ?? [];
      if (!idxList.includes(idxName)) idxList.push(idxName);
      this.indexes.set(tbl, idxList);
      return;
    }

    // INSERT INTO / INSERT OR IGNORE INTO / INSERT OR REPLACE INTO
    const insertMatch = /INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES\s*\(([^)]+)\)/i.exec(s);
    if (insertMatch) {
      const tbl = insertMatch[1]!;
      const colNames = insertMatch[2]!.split(",").map((c) => c.trim());
      const valPlaceholders = insertMatch[3]!.split(",").map((v) => v.trim());
      const rows = this.tables.get(tbl) ?? [];
      const row: InMemRow = {};
      let pIdx = 0;
      for (let i = 0; i < colNames.length; i++) {
        const ph = valPlaceholders[i]!;
        if (ph === "?") {
          row[colNames[i]!] = params[pIdx++];
        } else {
          // literal
          row[colNames[i]!] = ph.replace(/^'|'$/g, "");
        }
      }

      // OR IGNORE: skip if version already exists
      if (/INSERT OR IGNORE/i.test(s) && colNames.includes("version")) {
        const exists = rows.some((r) => r["version"] === row["version"]);
        if (exists) return;
      }
      rows.push(row);
      this.tables.set(tbl, rows);
      return;
    }

    // DROP INDEX
    const dropIdxMatch = /DROP INDEX(?:\s+IF EXISTS)?\s+(\w+)/i.exec(s);
    if (dropIdxMatch) {
      const idxName = dropIdxMatch[1]!;
      for (const [tbl, idxList] of this.indexes) {
        this.indexes.set(
          tbl,
          idxList.filter((i) => i !== idxName),
        );
      }
      return;
    }

    // Ignore other statements (SELECT handled separately in _query)
  }

  private _query<T>(sql: string, params: unknown[]): T[] {
    const s = sql.trim().replace(/\s+/g, " ");

    // SELECT * FROM table WHERE col = ?
    const selMatch = /SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(\w+)\s*=\s*\?)?(?:\s+ORDER BY\s+(\w+))?/i.exec(s);
    if (selMatch) {
      const tbl = selMatch[2]!;
      const whereCol = selMatch[3];
      const orderCol = selMatch[4];
      let rows = [...(this.tables.get(tbl) ?? [])];
      if (whereCol) {
        rows = rows.filter((r) => r[whereCol] === params[0]);
      }
      if (orderCol) {
        rows.sort((a, b) => {
          const av = a[orderCol];
          const bv = b[orderCol];
          if (typeof av === "number" && typeof bv === "number") return av - bv;
          return String(av).localeCompare(String(bv));
        });
      }
      return rows as T[];
    }

    return [];
  }
}

// ── SchemaVersion table helpers ───────────────────────────────────────────────

const MIGRATIONS_TABLE = "_schema_migrations";

const CREATE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  version   INTEGER PRIMARY KEY,
  name      TEXT    NOT NULL,
  applied_at TEXT   NOT NULL
)
`.trim();

// ── MigrationRunner ───────────────────────────────────────────────────────────

export class MigrationRunner {
  private db: DbClient;
  private migrations: Migration[];

  constructor(db: DbClient, migrations: Migration[] = []) {
    this.db = db;
    this.migrations = [...migrations].sort((a, b) => a.version - b.version);
  }

  /** Ensure the migrations tracking table exists. */
  init(): void {
    this.db.exec(CREATE_MIGRATIONS_TABLE);
  }

  /** Return list of already-applied versions. */
  appliedVersions(): number[] {
    const stmt = this.db.prepare(`SELECT version FROM ${MIGRATIONS_TABLE} ORDER BY version`);
    const rows = stmt.all<{ version: number }>();
    return rows.map((r) => r.version);
  }

  /** Return full applied-migration records. */
  appliedMigrations(): AppliedMigration[] {
    const stmt = this.db.prepare(
      `SELECT version, name, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY version`,
    );
    return stmt.all<AppliedMigration>().map((r) => ({
      version: r.version,
      name: r.name,
       
      appliedAt: (r as unknown)["applied_at"] as string,
    }));
  }

  /** Run all pending migrations and return a report. */
  run(): RunReport {
    this.init();
    const applied = new Set(this.appliedVersions());
    const results: MigrationResult[] = [];
    const start = Date.now();

    for (const migration of this.migrations) {
      const t0 = Date.now();

      if (applied.has(migration.version)) {
        results.push({
          version: migration.version,
          name: migration.name,
          status: "skipped",
          durationMs: 0,
        });
        continue;
      }

      try {
        this.db.transaction(() => {
          const stmts = Array.isArray(migration.up) ? migration.up : [migration.up];
          for (const sql of stmts) {
            this.db.exec(sql);
          }
          // Record as applied
          this.db
            .prepare(
              `INSERT OR IGNORE INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`,
            )
            .run(migration.version, migration.name, new Date().toISOString());
        });

        results.push({
          version: migration.version,
          name: migration.name,
          status: "applied",
          durationMs: Date.now() - t0,
        });
      } catch (err) {
        results.push({
          version: migration.version,
          name: migration.name,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - t0,
        });
        // Stop on first failure
        break;
      }
    }

    return {
      results,
      appliedCount: results.filter((r) => r.status === "applied").length,
      skippedCount: results.filter((r) => r.status === "skipped").length,
      failedCount: results.filter((r) => r.status === "failed").length,
      totalDurationMs: Date.now() - start,
    };
  }

  /** Run a single migration by version (idempotent). */
  runOne(version: number): MigrationResult {
    this.init();
    const migration = this.migrations.find((m) => m.version === version);
    if (!migration) {
      return {
        version,
        name: "unknown",
        status: "failed",
        error: `Migration v${version} not found`,
        durationMs: 0,
      };
    }
    const applied = new Set(this.appliedVersions());
    if (applied.has(version)) {
      return { version, name: migration.name, status: "skipped", durationMs: 0 };
    }
    const t0 = Date.now();
    try {
      this.db.transaction(() => {
        const stmts = Array.isArray(migration.up) ? migration.up : [migration.up];
        for (const sql of stmts) this.db.exec(sql);
        this.db
          .prepare(
            `INSERT OR IGNORE INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`,
          )
          .run(migration.version, migration.name, new Date().toISOString());
      });
      return { version, name: migration.name, status: "applied", durationMs: Date.now() - t0 };
    } catch (err) {
      return {
        version,
        name: migration.name,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      };
    }
  }

  /** Pending (not-yet-applied) migrations in version order. */
  pending(): Migration[] {
    this.init();
    const applied = new Set(this.appliedVersions());
    return this.migrations.filter((m) => !applied.has(m.version));
  }
}

// ── Schema repair helpers ─────────────────────────────────────────────────────

export class SchemaRepair {
  private db: DbClient;

  constructor(db: DbClient) {
    this.db = db;
  }

  /**
   * Add a column to a table only if it doesn't already exist.
   * Returns true if the column was added, false if it was already present.
   */
  addColumnIfMissing(table: string, column: string, definition: string): boolean {
    const existing = this.db.tableColumns(table);
    if (existing.includes(column)) return false;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }

  /**
   * Rebuild an index: drops it if it exists then re-creates it.
   * Returns the CREATE INDEX statement that was executed.
   */
  rebuildIndex(indexName: string, table: string, columns: string, unique = false): string {
    const uniqueKw = unique ? "UNIQUE " : "";
    this.db.exec(`DROP INDEX IF EXISTS ${indexName}`);
    const stmt = `CREATE ${uniqueKw}INDEX IF NOT EXISTS ${indexName} ON ${table} (${columns})`;
    this.db.exec(stmt);
    return stmt;
  }

  /**
   * Ensure an index exists; create it if missing.
   * Returns true if created, false if already present.
   */
  ensureIndex(indexName: string, table: string, columns: string, unique = false): boolean {
    const existing = this.db.tableIndexes(table);
    if (existing.includes(indexName)) return false;
    this.rebuildIndex(indexName, table, columns, unique);
    return true;
  }

  /**
   * Run a list of repair actions sequentially.
   * Returns a summary of actions taken.
   */
  repairAll(
    actions: (| {
          type: "addColumn";
          table: string;
          column: string;
          definition: string;
        }
      | {
          type: "ensureIndex";
          indexName: string;
          table: string;
          columns: string;
          unique?: boolean;
        }
      | {
          type: "rebuildIndex";
          indexName: string;
          table: string;
          columns: string;
          unique?: boolean;
        })[],
  ): string[] {
    const log: string[] = [];
    for (const action of actions) {
      if (action.type === "addColumn") {
        const added = this.addColumnIfMissing(action.table, action.column, action.definition);
        log.push(
          added
            ? `addColumn: added ${action.table}.${action.column}`
            : `addColumn: ${action.table}.${action.column} already exists`,
        );
      } else if (action.type === "ensureIndex") {
        const created = this.ensureIndex(
          action.indexName,
          action.table,
          action.columns,
          action.unique,
        );
        log.push(
          created
            ? `ensureIndex: created ${action.indexName}`
            : `ensureIndex: ${action.indexName} already exists`,
        );
      } else if (action.type === "rebuildIndex") {
        const sql = this.rebuildIndex(
          action.indexName,
          action.table,
          action.columns,
          action.unique,
        );
        log.push(`rebuildIndex: rebuilt ${action.indexName} → ${sql}`);
      }
    }
    return log;
  }
}
